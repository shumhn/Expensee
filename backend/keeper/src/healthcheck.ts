/**
 * Health check + Claim Relay API server for the keeper service.
 * Exposes:
 *   GET  /health           — health check
 *   POST /api/claim-auth   — receive worker claim authorizations
 *
 * Port: 9090 (configurable via KEEPER_HEALTH_PORT).
 */

import http from 'http';
import { ed25519 } from '@noble/curves/ed25519';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';


const PORT = Number(process.env.KEEPER_HEALTH_PORT || '9090');
const ENABLE_VIEW_RELAY = process.env.KEEPER_ENABLE_VIEW_RELAY === 'true';
const ENABLE_SERVER_DECRYPT = process.env.KEEPER_ENABLE_SERVER_DECRYPT === 'true';
const REVEAL_AUTH_WINDOW_SECS = Number(process.env.KEEPER_REVEAL_AUTH_WINDOW_SECS || '180');
const EMPLOYEE_STREAM_V2_ACCOUNT_LEN = 243;
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');
const BUSINESS_SEED = Buffer.from('business');

const PROGRAM_ID = new PublicKey(
    requiredEnv('KEEPER_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID),
);
const REVEAL_READ_RPC_URL =
    process.env.KEEPER_READ_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.KEEPER_RPC_URL ||
    'https://api.devnet.solana.com';
const revealReadConnection = new Connection(REVEAL_READ_RPC_URL, 'confirmed');
const keeperPayer = loadPayer();
const EMPLOYEE_STREAM_V2_DISC = accountDiscriminator('EmployeeStreamV2');
const keeperSecretSeed = keeperPayer.secretKey.slice(0, 32);

let lastTickAt = 0;
let tickCount = 0;
let consecutiveFailures = 0;
const startedAt = Date.now();

export interface ClaimAuthRecord {
    workerPubkey: string;
    streamIndex: number;
    nonce: number;
    destinationTokenAccount: string;
    signature: number[];
    message: number[];
    businessOwner: string;
    expiry: number;
    receivedAt: number;
}

export interface WithdrawAuthRecord {
    workerPubkey: string;
    streamIndex: number;
    signature: number[];
    message: number[];
    businessOwner: string;
    timestamp: number;
    receivedAt: number;
}

interface RevealRequestPayload {
    workerPubkey: string;
    businessOwner: string;
    streamIndex: number;
    timestamp: number;
    signature: number[];
}

function requiredEnv(name: string, fallback?: string): string {
    const value = fallback || process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value.trim();
}

function resolveKeeperFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    const normalized = filePath.replace(/\\/g, '/');
    const cwdNormalized = process.cwd().replace(/\\/g, '/');
    let candidate = normalized;
    if (normalized.startsWith('backend/keeper/') && cwdNormalized.endsWith('/backend/keeper')) {
        candidate = normalized.slice('backend/keeper/'.length);
    }
    return path.resolve(candidate);
}

function loadPayer(): Keypair {
    const fromInline = process.env.KEEPER_PAYER_SECRET_JSON;
    if (fromInline) {
        const parsed = JSON.parse(fromInline);
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    const keypairPath = requiredEnv('KEEPER_PAYER_KEYPAIR_PATH');
    const raw = fs.readFileSync(resolveKeeperFilePath(keypairPath), 'utf8');
    const parsed = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function accountDiscriminator(name: string): Buffer {
    return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function deriveBusinessPda(owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([BUSINESS_SEED, owner.toBuffer()], PROGRAM_ID)[0];
}

function deriveEmployeeStreamPda(business: PublicKey, streamIndex: number): PublicKey {
    const index = Buffer.alloc(8);
    index.writeBigUInt64LE(BigInt(streamIndex));
    return PublicKey.findProgramAddressSync([EMPLOYEE_V2_SEED, business.toBuffer(), index], PROGRAM_ID)[0];
}

function readU128LE(buffer: Buffer, offset: number): bigint {
    let out = 0n;
    for (let i = 0; i < 16; i += 1) {
        out |= BigInt(buffer[offset + i] || 0) << (BigInt(i) * 8n);
    }
    return out;
}

function hashWorkerPubkey(workerPubkey: PublicKey): Buffer {
    return createHash('sha256').update(workerPubkey.toBuffer()).digest();
}

function parseRevealPayload(data: any): RevealRequestPayload {
    return {
        workerPubkey: String(data?.workerPubkey || ''),
        businessOwner: String(data?.businessOwner || ''),
        streamIndex: Number(data?.streamIndex),
        timestamp: Number(data?.timestamp),
        signature: Array.isArray(data?.signature) ? data.signature : [],
    };
}

function assertRecentTimestamp(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('Invalid timestamp');
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > REVEAL_AUTH_WINDOW_SECS) {
        throw new Error(
            `Reveal authorization expired (window ${REVEAL_AUTH_WINDOW_SECS}s). Please try again.`,
        );
    }
}

function verifyRevealSignature(payload: RevealRequestPayload): void {
    const msgPreferred = new TextEncoder().encode(
        `reveal:${payload.businessOwner}:${payload.streamIndex}:${payload.timestamp}`,
    );
    const msgLegacy = new TextEncoder().encode(
        `reveal:${payload.streamIndex}:${payload.timestamp}`,
    );
    const workerBytes = new PublicKey(payload.workerPubkey).toBytes();
    const signature = new Uint8Array(payload.signature || []);
    const valid =
        ed25519.verify(signature, msgPreferred, workerBytes) ||
        ed25519.verify(signature, msgLegacy, workerBytes);
    if (!valid) {
        throw new Error('Invalid reveal signature');
    }
}

async function revealLiveWithKeeper(payload: RevealRequestPayload): Promise<{
    salaryLamportsPerSec: string;
    accruedLamportsCheckpoint: string;
    checkpointTime: number;
    streamAddress: string;
}> {
    const businessOwner = new PublicKey(payload.businessOwner);
    const workerPubkey = new PublicKey(payload.workerPubkey);
    const businessPda = deriveBusinessPda(businessOwner);
    const streamPda = deriveEmployeeStreamPda(businessPda, payload.streamIndex);
    const streamInfo = await revealReadConnection.getAccountInfo(streamPda, 'confirmed');
    if (!streamInfo) {
        throw new Error('Payroll stream not found');
    }
    if (streamInfo.data.length < EMPLOYEE_STREAM_V2_ACCOUNT_LEN) {
        throw new Error('Invalid payroll stream account length');
    }
    if (!Buffer.from(streamInfo.data.subarray(0, 8)).equals(EMPLOYEE_STREAM_V2_DISC)) {
        throw new Error('Invalid payroll stream discriminator');
    }

    const employeeAuthHash = Buffer.from(streamInfo.data.subarray(48, 80));
    const expectedAuthHash = hashWorkerPubkey(workerPubkey);
    if (!employeeAuthHash.equals(expectedAuthHash)) {
        throw new Error('Worker authorization does not match this payroll record');
    }

    const salaryHandle = readU128LE(Buffer.from(streamInfo.data), 112).toString();
    const accruedHandle = readU128LE(Buffer.from(streamInfo.data), 144).toString();
    const lastAccrualTime = Number(Buffer.from(streamInfo.data).readBigInt64LE(176));
    const lastSettleTime = Number(Buffer.from(streamInfo.data).readBigInt64LE(184));
    const checkpointTime = lastAccrualTime > 0 ? lastAccrualTime : lastSettleTime;

    const { decrypt } = await import('@inco/solana-sdk');
    const result = await decrypt([salaryHandle, accruedHandle], {
        address: keeperPayer.publicKey,
        signMessage: async (message: Uint8Array) =>
            Uint8Array.from(ed25519.sign(message, keeperSecretSeed)),
    });

    return {
        salaryLamportsPerSec: String(result?.plaintexts?.[0] || '0'),
        accruedLamportsCheckpoint: String(result?.plaintexts?.[1] || '0'),
        checkpointTime,
        streamAddress: streamPda.toBase58(),
    };
}

/** In-memory queue removed for DB integration. */

export function recordTick(): void {
    lastTickAt = Date.now();
    tickCount += 1;
    consecutiveFailures = 0;
}

export function recordFailure(): void {
    consecutiveFailures += 1;
}

function corsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

export function startHealthServer(): void {
    const server = http.createServer((req, res) => {
        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders());
            res.end();
            return;
        }

        // Health check
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
            const now = Date.now();
            const uptimeMs = now - startedAt;
            const lastTickAgoMs = lastTickAt > 0 ? now - lastTickAt : -1;
            const healthy = lastTickAgoMs < 60_000 && consecutiveFailures < 10;

            import('./claims-queue').then(q => q.getQueueSize()).then(queueSize => {
                const body = JSON.stringify({
                    ok: healthy,
                    uptimeMs,
                    uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
                    tickCount,
                    lastTickAgoMs,
                    consecutiveFailures,
                    pendingClaimAuths: queueSize,
                });
                res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(body);
            }).catch(() => {
                const body = JSON.stringify({ ok: healthy, error: "Queue unreadable" });
                res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(body);
            });
            return;
        }

        // Claim authorization endpoint
        if (req.method === 'POST' && req.url === '/api/claim-auth') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (
                        !data.workerPubkey ||
                        data.streamIndex === undefined ||
                        data.nonce === undefined ||
                        !data.businessOwner ||
                        !data.destinationTokenAccount
                    ) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }

                    // Edge Verification: Claim
                    // Preferred signed format binds business + destination:
                    //   claim:<businessOwner>:<streamIndex>:<nonce>:<expiry>:<destinationTokenAccount>
                    // Legacy fallback:
                    //   claim:<streamIndex>:<nonce>:<expiry>
                    const messagePreferred = new TextEncoder().encode(
                        `claim:${data.businessOwner}:${data.streamIndex}:${data.nonce}:${data.expiry || 0}:${data.destinationTokenAccount}`
                    );
                    const messageLegacy = new TextEncoder().encode(
                        `claim:${data.streamIndex}:${data.nonce}:${data.expiry || 0}`
                    );
                    try {
                        const workerBytes = new PublicKey(data.workerPubkey).toBytes();
                        const signature = new Uint8Array(data.signature || []);
                        const isValid =
                            ed25519.verify(signature, messagePreferred, workerBytes) ||
                            ed25519.verify(signature, messageLegacy, workerBytes);
                        if (!isValid) {
                            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                            res.end(JSON.stringify({ error: 'Invalid signature' }));
                            return;
                        }
                    } catch (err) {
                        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Cryptographic verification failed' }));
                        return;
                    }

                    const { enqueueClaimAuth, getQueueSize } = await import('./claims-queue');

                    const queued = await enqueueClaimAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        nonce: data.nonce,
                        destinationTokenAccount: data.destinationTokenAccount,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        expiry: data.expiry || 0,
                        receivedAt: Date.now(),
                    });

                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'Authorization already queued' }));
                        return;
                    }

                    const queueSize = await getQueueSize();
                    console.log(`[keeper api] claim auth queued stream=${data.streamIndex} nonce=${data.nonce}`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true, queueSize }));
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }

        // Withdraw authorization endpoint
        if (req.method === 'POST' && req.url === '/api/withdraw-auth') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.workerPubkey || data.streamIndex === undefined || data.timestamp === undefined || !data.businessOwner) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }

                    // Edge Verification: Withdraw
                    // Preferred signed format binds to business owner to prevent cross-business replay:
                    //   withdraw:<businessOwner>:<streamIndex>:<timestamp>
                    // Legacy fallback kept for backward compatibility:
                    //   withdraw:<streamIndex>:<timestamp>
                    const messagePreferred = new TextEncoder().encode(
                        `withdraw:${data.businessOwner}:${data.streamIndex}:${data.timestamp}`
                    );
                    const messageLegacy = new TextEncoder().encode(
                        `withdraw:${data.streamIndex}:${data.timestamp}`
                    );
                    try {
                        const workerBytes = new PublicKey(data.workerPubkey).toBytes();
                        const signature = new Uint8Array(data.signature || []);
                        const isValid =
                            ed25519.verify(signature, messagePreferred, workerBytes) ||
                            ed25519.verify(signature, messageLegacy, workerBytes);
                        if (!isValid) {
                            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                            res.end(JSON.stringify({ error: 'Invalid signature' }));
                            return;
                        }
                    } catch (err) {
                        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Cryptographic verification failed' }));
                        return;
                    }

                    const { enqueueWithdrawAuth } = await import('./claims-queue');

                    const queued = await enqueueWithdrawAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        timestamp: data.timestamp,
                        receivedAt: Date.now(),
                    });

                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'Withdraw auth already queued' }));
                        return;
                    }

                    console.log(`[keeper api] withdraw auth queued stream=${data.streamIndex} ts=${data.timestamp}`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }
        // View authorization endpoint
        if (req.method === 'POST' && req.url === '/api/request-view-access') {
            if (!ENABLE_VIEW_RELAY) {
                res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(
                    JSON.stringify({
                        error:
                            'View relay is disabled in strict privacy mode. Enable KEEPER_ENABLE_VIEW_RELAY=true to allow this endpoint.',
                    }),
                );
                return;
            }
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.workerPubkey || data.streamIndex === undefined || data.timestamp === undefined || !data.businessOwner) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }

                    // Edge Verification: View
                    const messageStr = `view:${data.streamIndex}:${data.timestamp}`;
                    const message = new TextEncoder().encode(messageStr);
                    try {
                        const workerBytes = new PublicKey(data.workerPubkey).toBytes();
                        const isValid = ed25519.verify(new Uint8Array(data.signature || []), message, workerBytes);
                        if (!isValid) {
                            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                            res.end(JSON.stringify({ error: 'Invalid signature' }));
                            return;
                        }
                    } catch (err) {
                        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Cryptographic verification failed' }));
                        return;
                    }

                    const { enqueueViewAuth } = await import('./claims-queue');

                    const queued = await enqueueViewAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        timestamp: data.timestamp,
                        receivedAt: Date.now(),
                    });

                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'View auth already queued' }));
                        return;
                    }

                    console.log(`[keeper api] view auth queued stream=${data.streamIndex} ts=${data.timestamp}`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e: any) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }

        // Keeper server-side reveal endpoint
        if (req.method === 'POST' && req.url === '/api/reveal-live') {
            if (!ENABLE_SERVER_DECRYPT) {
                res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(
                    JSON.stringify({
                        error:
                            'Keeper server decrypt is disabled. Enable KEEPER_ENABLE_SERVER_DECRYPT=true to allow this endpoint.',
                    }),
                );
                return;
            }
            let body = '';
            req.on('data', (chunk: Buffer) => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const parsed = parseRevealPayload(JSON.parse(body));
                    if (
                        !parsed.workerPubkey ||
                        !parsed.businessOwner ||
                        !Number.isFinite(parsed.streamIndex) ||
                        !Number.isFinite(parsed.timestamp) ||
                        parsed.signature.length === 0
                    ) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }

                    assertRecentTimestamp(parsed.timestamp);
                    verifyRevealSignature(parsed);
                    const revealed = await revealLiveWithKeeper(parsed);

                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(
                        JSON.stringify({
                            ok: true,
                            mode: 'keeper',
                            keeperWallet: keeperPayer.publicKey.toBase58(),
                            ...revealed,
                        }),
                    );
                } catch (e: any) {
                    const msg = e?.message || 'Reveal failed';
                    const lower = String(msg).toLowerCase();
                    const status =
                        lower.includes('invalid reveal signature') ||
                        lower.includes('authorization') ||
                        lower.includes('expired')
                            ? 401
                            : lower.includes('not allowed to decrypt')
                                ? 403
                                : 400;
                    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: msg }));
                }
            });
            return;
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
        console.log(`[keeper api] listening on http://0.0.0.0:${PORT} (health + relay API)`);
        console.log(
            `[keeper api] view relay: ${
                ENABLE_VIEW_RELAY ? 'enabled' : 'disabled (strict privacy default)'
            }`,
        );
        console.log(
            `[keeper api] server decrypt: ${
                ENABLE_SERVER_DECRYPT ? 'enabled' : 'disabled (strict privacy default)'
            }`,
        );
    });

    server.on('error', (err) => {
        console.error(`[keeper api] server error: ${err.message}`);
    });
}
