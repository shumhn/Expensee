"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const crypto_1 = require("crypto");
const healthcheck_1 = require("./healthcheck");
const claims_queue_1 = require("./claims-queue");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ed25519_1 = require("@noble/curves/ed25519");
const fetchAny = globalThis.fetch;
const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');
const VAULT_SEED = Buffer.from('vault');
const BUFFER_SEED = Buffer.from('buffer');
const DELEGATION_SEED = Buffer.from('delegation');
const DELEGATION_METADATA_SEED = Buffer.from('delegation-metadata');
const SHIELDED_PAYOUT_V2_SEED = Buffer.from('shielded_payout');
const INCO_LIGHTNING_ID = new web3_js_1.PublicKey(process.env.KEEPER_INCO_LIGHTNING_ID ||
    process.env.NEXT_PUBLIC_INCO_PROGRAM_ID ||
    '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
const INCO_TOKEN_PROGRAM_ID = new web3_js_1.PublicKey(process.env.KEEPER_INCO_TOKEN_PROGRAM_ID ||
    process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID ||
    '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N');
const PAYUSD_MINT = new web3_js_1.PublicKey(process.env.KEEPER_PAYUSD_MINT ||
    process.env.NEXT_PUBLIC_PAYUSD_MINT ||
    'GhCZ59UK4Afg4WGpQ11HyRc8ya4swgWFXMh2BxuWQXHt');
// Inco Confidential Token: initialize_account discriminator
const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);
const KEEPER_CLAIM_ON_BEHALF_V2_DISC = Buffer.from([161, 194, 33, 127, 138, 221, 153, 84]);
const KEEPER_REQUEST_WITHDRAW_V2_DISC = Buffer.from([241, 181, 94, 57, 32, 108, 61, 165]);
const GRANT_EMPLOYEE_VIEW_ACCESS_V2_DISC = Buffer.from([201, 191, 208, 133, 117, 221, 125, 147]);
const GRANT_KEEPER_VIEW_ACCESS_V2_DISC = Buffer.from([60, 78, 33, 123, 183, 61, 107, 58]);
const REVOKE_VIEW_ACCESS_V2_DISC = Buffer.from([79, 190, 166, 170, 246, 184, 119, 163]);
const GRANT_EMPLOYEE_VIEW_ACCESS_V2_DISC = Buffer.from([201, 191, 208, 133, 117, 221, 125, 147]);
const GRANT_KEEPER_VIEW_ACCESS_V2_DISC = Buffer.from([60, 78, 33, 123, 183, 61, 107, 58]);
const REVOKE_VIEW_ACCESS_V2_DISC = Buffer.from([79, 190, 166, 170, 246, 184, 119, 163]);
const MAGIC_PROGRAM_ID = new web3_js_1.PublicKey(process.env.KEEPER_MAGIC_CORE_PROGRAM_ID ||
    process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM ||
    'Magic11111111111111111111111111111111111111');
const DELEGATION_PROGRAM_ID = new web3_js_1.PublicKey(process.env.KEEPER_DELEGATION_PROGRAM_ID ||
    process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM ||
    process.env.KEEPER_MAGIC_PROGRAM_ID ||
    'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_CONTEXT_ID = new web3_js_1.PublicKey(process.env.KEEPER_MAGIC_CONTEXT ||
    process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT ||
    'MagicContext1111111111111111111111111111111');
const DEFAULT_VALIDATOR = new web3_js_1.PublicKey(process.env.KEEPER_VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
const DEFAULT_TICK_SECS = Number(process.env.KEEPER_TICK_SECS || '10');
const DEFAULT_MAX_STREAMS_PER_TICK = Number(process.env.KEEPER_MAX_STREAMS_PER_TICK || '25');
const DEFAULT_JITTER_MS = Number(process.env.KEEPER_STREAM_JITTER_MS || '800');
const DEFAULT_MAX_RETRIES = Number(process.env.KEEPER_MAX_RETRIES || '3');
const DEFAULT_BACKOFF_MS = Number(process.env.KEEPER_RETRY_BASE_MS || '500');
const DEFAULT_COMPLIANCE_WINDOW_SECS = Number(process.env.KEEPER_COMPLIANCE_POLICY_WINDOW_SECS || '600');
const PAUSE_ON_COMPLIANCE_SOFT_FAIL = process.env.KEEPER_PAUSE_ON_COMPLIANCE_SOFT_FAIL === 'true';
// Compliance is disabled by default (especially for devnet/local). Enable explicitly via env.
const COMPLIANCE_ENABLED = process.env.KEEPER_COMPLIANCE_ENABLED === 'true';
const DEFAULT_MAX_CONSECUTIVE_FAILURES = Number(process.env.KEEPER_MAX_CONSECUTIVE_FAILURES || '10');
const DEFAULT_UNDELEGATE_WAIT_ATTEMPTS = Number(process.env.KEEPER_UNDELEGATE_WAIT_ATTEMPTS || '30');
const DEFAULT_UNDELEGATE_WAIT_MS = Number(process.env.KEEPER_UNDELEGATE_WAIT_MS || '1000');
const DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS = Number(process.env.KEEPER_UNDELEGATE_RETRY_COOLDOWN_SECS || '45');
const DEFAULT_SETTLE_GUARD_SECS = Number(process.env.KEEPER_SETTLE_GUARD_SECS || '1');
// REMOVED: DEFAULT_WITHDRAW_DECRYPT_RETRY_COOLDOWN_SECS — keeper no longer decrypts (Phase 1 Blind Keeper).
// REMOVED: WITHDRAW_USE_RATE_ONLY — keeper no longer computes payout amounts (Phase 1 Blind Keeper).
const ROUTER_STATUS_TIMEOUT_MS = Number(process.env.KEEPER_ROUTER_STATUS_TIMEOUT_MS || '3500');
const ROUTER_STATUS_RETRIES = Number(process.env.KEEPER_ROUTER_STATUS_RETRIES || '3');
const ROUTER_STATUS_BACKOFF_MS = Number(process.env.KEEPER_ROUTER_STATUS_BACKOFF_MS || '250');
const ROUTER_STATUS_CACHE_MS = Number(process.env.KEEPER_ROUTER_STATUS_CACHE_MS || '15000');
const REDELEGATE_AFTER_WITHDRAW = process.env.KEEPER_REDELEGATE_AFTER_WITHDRAW !== 'false';
// If a stream is delegated, attempt to run accrue_v2 on the ER endpoint before commit+undelegate.
// This makes MagicBlock the compute engine for the accrual checkpoint.
const ACCRUE_ON_ER_BEFORE_COMMIT = process.env.KEEPER_ACCRUE_ON_ER_BEFORE_COMMIT !== 'false';
const EMPLOYEE_STREAM_V2_ACCOUNT_LEN = 243;
const WITHDRAW_REQUEST_V2_ACCOUNT_LEN = 122;
const BUSINESS_ACCOUNT_LEN = 154;
const VAULT_ACCOUNT_LEN = 169;
const STREAM_CONFIG_V2_ACCOUNT_LEN = 123;
const PAUSE_REASON_COMPLIANCE = 2;
const PROGRAM_ID = new web3_js_1.PublicKey(requiredEnv('KEEPER_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID));
const TX_RPC_URL = requiredEnv('KEEPER_RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL);
const ROUTER_RPC_URL = process.env.KEEPER_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app';
const DEFAULT_ROUTER_FAILOVER_URLS = [
    ROUTER_RPC_URL,
    'https://devnet-eu.magicblock.app',
    'https://devnet-us.magicblock.app',
    'https://devnet-as.magicblock.app',
].join(',');
const ROUTER_RPC_URLS = (process.env.KEEPER_ROUTER_RPC_URLS || DEFAULT_ROUTER_FAILOVER_URLS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const READ_RPC_PRIMARY_URL = process.env.KEEPER_READ_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
    'https://api.devnet.solana.com';
const READ_RPC_FALLBACK_URL = process.env.KEEPER_READ_RPC_FALLBACK_URL || 'https://api.devnet.solana.com';
// Optional: comma-separated list to fully control failover order.
// Example:
// KEEPER_READ_RPC_URLS="https://devnet.helius-rpc.com/?api-key=XXX,https://api.devnet.solana.com"
const READ_RPC_URLS = (process.env.KEEPER_READ_RPC_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const ENFORCE_MAGIC_CONTEXT_CHECK = process.env.KEEPER_ENFORCE_MAGIC_CONTEXT_CHECK === 'true';
function resolveKeeperFilePath(filePath) {
    if (path_1.default.isAbsolute(filePath))
        return filePath;
    const normalized = filePath.replace(/\\/g, '/');
    const cwdNormalized = process.cwd().replace(/\\/g, '/');
    let candidate = normalized;
    // Avoid resolving to ".../backend/keeper/backend/keeper/*" when running from backend/keeper.
    if (normalized.startsWith('backend/keeper/') && cwdNormalized.endsWith('/backend/keeper')) {
        candidate = normalized.slice('backend/keeper/'.length);
    }
    return path_1.default.resolve(candidate);
}
const DEAD_LETTER_FILE = process.env.KEEPER_DEAD_LETTER_FILE
    ? resolveKeeperFilePath(process.env.KEEPER_DEAD_LETTER_FILE)
    : path_1.default.resolve(process.cwd(), 'dead-letter.log');
const ALERT_WEBHOOK_URL = process.env.KEEPER_ALERT_WEBHOOK_URL || '';
const RANGE_API_KEY = process.env.KEEPER_RANGE_API_KEY || process.env.RANGE_API_KEY || process.env.NEXT_PUBLIC_RANGE_API_KEY || '';
const TEE_AUTH_TOKEN = (process.env.KEEPER_TEE_AUTH_TOKEN || process.env.MAGICBLOCK_TEE_TOKEN || '').trim();
const txConnection = new web3_js_1.Connection(TX_RPC_URL, 'confirmed');
const readUrlsRaw = READ_RPC_URLS.length > 0 ? READ_RPC_URLS : [READ_RPC_PRIMARY_URL, READ_RPC_FALLBACK_URL];
const readUrls = [];
for (const url of readUrlsRaw) {
    const normalized = normalizeRpcUrl(url);
    if (normalized.length === 0)
        continue;
    if (readUrls.some((u) => normalizeRpcUrl(u) === normalized))
        continue;
    readUrls.push(url);
}
const readConnections = readUrls.map((url) => new web3_js_1.Connection(url, 'confirmed'));
if (readConnections.length === 0) {
    // Should never happen because defaults include api.devnet.solana.com
    throw new Error('No READ RPC URLs configured');
}
// Back-compat aliases used throughout the keeper for logs and base-layer txs.
// Primary = first URL in the failover list.
const READ_RPC_URL = readUrls[0];
const readConnection = readConnections[0];
const txConnectionCache = new Map();
txConnectionCache.set(normalizeRpcUrl(TX_RPC_URL), txConnection);
const payer = loadPayer();
const payerSigner = payer;
const idempotency = new Set();
const withdrawDecryptRetryAfter = new Map();
const complianceCache = new Map();
const delegatedUnsupportedLogged = new Set();
const teeTokenMissingLogged = new Set();
const undelegateInFlight = new Map();
const autoResumeCooldownByBusiness = new Map();
const businessCache = new Map();
const vaultCache = new Map();
const streamConfigCache = new Map();
const delegatedRouteCache = new Map();
let tickInProgress = false;
let consecutiveFailures = 0;
let magicCommitSupported = false;
function requiredEnv(name, fallback) {
    const value = fallback || process.env[name];
    if (!value || value.trim().length === 0) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value.trim();
}
function normalizeRpcUrl(url) {
    return url.replace(/\/+$/, '');
}
function isRetryableReadRpcError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return (message.includes('fetch failed') ||
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('econnreset') ||
        message.includes('enotfound'));
}
async function getAccountInfoRead(pubkey, commitment = 'confirmed') {
    let primaryErr = null;
    for (let i = 0; i < readConnections.length; i++) {
        const conn = readConnections[i];
        const endpoint = rpcEndpoint(conn);
        try {
            return await conn.getAccountInfo(pubkey, commitment);
        }
        catch (e) {
            if (i === 0)
                primaryErr = e;
            // If it's not retryable, fail fast (caller likely passed bad args).
            if (!isRetryableReadRpcError(e))
                throw e;
            // Otherwise try the next configured READ RPC.
            log(`READ RPC failed endpoint=${endpoint} op=getAccountInfo reason=${e?.message || 'unknown'}`);
        }
    }
    const urls = readUrls.map(normalizeRpcUrl).join(', ');
    throw new Error(`READ RPC failover exhausted op=getAccountInfo urls=[${urls}] reason=${primaryErr?.message || 'unknown'}`);
}
async function getProgramAccountsRead(programId, config) {
    let primaryErr = null;
    for (let i = 0; i < readConnections.length; i++) {
        const conn = readConnections[i];
        const endpoint = rpcEndpoint(conn);
        try {
            return await conn.getProgramAccounts(programId, config);
        }
        catch (e) {
            if (i === 0)
                primaryErr = e;
            if (!isRetryableReadRpcError(e))
                throw e;
            log(`READ RPC failed endpoint=${endpoint} op=getProgramAccounts reason=${e?.message || 'unknown'}`);
        }
    }
    const urls = readUrls.map(normalizeRpcUrl).join(', ');
    throw new Error(`READ RPC failover exhausted op=getProgramAccounts urls=[${urls}] reason=${primaryErr?.message || 'unknown'}`);
}
function loadPayer() {
    const fromInline = process.env.KEEPER_PAYER_SECRET_JSON;
    if (fromInline) {
        const parsed = JSON.parse(fromInline);
        return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    const keypairPath = requiredEnv('KEEPER_PAYER_KEYPAIR_PATH');
    const raw = fs_1.default.readFileSync(resolveKeeperFilePath(keypairPath), 'utf8');
    const parsed = JSON.parse(raw);
    return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(parsed));
}
async function detectMagicCommitSupport() {
    try {
        const [magicProgram, magicContext] = await Promise.all([
            getAccountInfoRead(MAGIC_PROGRAM_ID, 'confirmed'),
            getAccountInfoRead(MAGIC_CONTEXT_ID, 'confirmed'),
        ]);
        if (!magicProgram || !magicProgram.executable)
            return false;
        if (!magicContext)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function accountDiscriminator(name) {
    return (0, crypto_1.createHash)('sha256').update(`account:${name}`).digest().subarray(0, 8);
}
function instructionDiscriminator(name) {
    return (0, crypto_1.createHash)('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function deriveStreamConfigPda(business) {
    return web3_js_1.PublicKey.findProgramAddressSync([STREAM_CONFIG_V2_SEED, business.toBuffer()], PROGRAM_ID)[0];
}
function deriveEmployeeStreamPda(business, streamIndex) {
    const index = Buffer.alloc(8);
    index.writeBigUInt64LE(BigInt(streamIndex));
    return web3_js_1.PublicKey.findProgramAddressSync([EMPLOYEE_V2_SEED, business.toBuffer(), index], PROGRAM_ID)[0];
}
function deriveVaultPda(business) {
    return web3_js_1.PublicKey.findProgramAddressSync([VAULT_SEED, business.toBuffer()], PROGRAM_ID)[0];
}
function deriveShieldedPayoutPda(business, streamIndex, nonce) {
    const streamIndexBuf = Buffer.alloc(8);
    streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    return web3_js_1.PublicKey.findProgramAddressSync([SHIELDED_PAYOUT_V2_SEED, business.toBuffer(), streamIndexBuf, nonceBuf], PROGRAM_ID)[0];
}
function deriveMagicContext(_employeeStreamPda) {
    return MAGIC_CONTEXT_ID;
}
function deriveBufferPda(employeeStreamPda) {
    return web3_js_1.PublicKey.findProgramAddressSync([BUFFER_SEED, employeeStreamPda.toBuffer()], PROGRAM_ID)[0];
}
function deriveDelegationRecordPda(employeeStreamPda) {
    return web3_js_1.PublicKey.findProgramAddressSync([DELEGATION_SEED, employeeStreamPda.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}
function deriveDelegationMetadataPda(employeeStreamPda) {
    return web3_js_1.PublicKey.findProgramAddressSync([DELEGATION_METADATA_SEED, employeeStreamPda.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}
function readU128LE(buffer, offset) {
    let out = 0n;
    for (let i = 0; i < 16; i += 1) {
        out |= BigInt(buffer[offset + i] || 0) << (BigInt(i) * 8n);
    }
    return out;
}
function parseEmployeeStreamV2(address, owner, data) {
    if (data.length < EMPLOYEE_STREAM_V2_ACCOUNT_LEN)
        return null;
    if (!data.subarray(0, 8).equals(accountDiscriminator('EmployeeStreamV2')))
        return null;
    return {
        address,
        owner,
        business: new web3_js_1.PublicKey(data.subarray(8, 40)),
        streamIndex: Number(data.readBigUInt64LE(40)),
        employeeTokenAccount: new web3_js_1.PublicKey(data.subarray(80, 112)),
        lastSettleTime: Number(data.readBigInt64LE(184)),
        salaryHandle: readU128LE(data, 112),
        // EncryptedHandle stores a u128 Lightning handle in the first 16 bytes (little-endian).
        accruedHandle: readU128LE(data, 144),
        isActive: data[192] === 1,
        isDelegated: data[193] === 1,
        // Bounded stream fields (after bump at offset 194).
        periodStart: Number(data.readBigInt64LE(195)),
        periodEnd: Number(data.readBigInt64LE(203)),
    };
}
function parseBusiness(data) {
    if (data.length < BUSINESS_ACCOUNT_LEN)
        return null;
    if (!data.subarray(0, 8).equals(accountDiscriminator('Business')))
        return null;
    return {
        owner: new web3_js_1.PublicKey(data.subarray(8, 40)),
        vault: new web3_js_1.PublicKey(data.subarray(40, 72)),
    };
}
function parseVault(data) {
    if (data.length < VAULT_ACCOUNT_LEN)
        return null;
    if (!data.subarray(0, 8).equals(accountDiscriminator('BusinessVault')))
        return null;
    return {
        tokenAccount: new web3_js_1.PublicKey(data.subarray(72, 104)),
    };
}
function parseStreamConfig(data) {
    if (data.length < STREAM_CONFIG_V2_ACCOUNT_LEN)
        return null;
    if (!data.subarray(0, 8).equals(accountDiscriminator('BusinessStreamConfigV2')))
        return null;
    return {
        keeper: new web3_js_1.PublicKey(data.subarray(40, 72)),
        settleIntervalSecs: Number(data.readBigUInt64LE(72)),
        isPaused: data[88] === 1,
        pauseReason: data[89],
    };
}
function parseWithdrawRequestV2(address, data) {
    if (data.length < WITHDRAW_REQUEST_V2_ACCOUNT_LEN)
        return null;
    if (!data.subarray(0, 8).equals(accountDiscriminator('WithdrawRequestV2')))
        return null;
    return {
        address,
        business: new web3_js_1.PublicKey(data.subarray(8, 40)),
        streamIndex: Number(data.readBigUInt64LE(40)),
        requester: new web3_js_1.PublicKey(data.subarray(48, 80)),
        requestedAt: Number(data.readBigInt64LE(80)),
        isPending: data[88] === 1,
    };
}
async function getBusiness(businessPda) {
    const key = businessPda.toBase58();
    if (businessCache.has(key))
        return businessCache.get(key);
    let account;
    try {
        account = await getAccountInfoRead(businessPda, 'confirmed');
    }
    catch (e) {
        throw new Error(`read_rpc_getAccountInfo_business_failed url=${normalizeRpcUrl(READ_RPC_URL)} business=${businessPda.toBase58()} reason=${e?.message || 'unknown'}`);
    }
    if (!account)
        return null;
    const parsed = parseBusiness(Buffer.from(account.data));
    if (!parsed)
        return null;
    businessCache.set(key, parsed);
    return parsed;
}
async function getVault(vaultPda) {
    const key = vaultPda.toBase58();
    if (vaultCache.has(key))
        return vaultCache.get(key);
    let account;
    try {
        account = await getAccountInfoRead(vaultPda, 'confirmed');
    }
    catch (e) {
        throw new Error(`read_rpc_getAccountInfo_vault_failed url=${normalizeRpcUrl(READ_RPC_URL)} vault=${vaultPda.toBase58()} reason=${e?.message || 'unknown'}`);
    }
    if (!account)
        return null;
    const parsed = parseVault(Buffer.from(account.data));
    if (!parsed)
        return null;
    vaultCache.set(key, parsed);
    return parsed;
}
async function getStreamConfig(businessPda) {
    const key = businessPda.toBase58();
    if (streamConfigCache.has(key))
        return streamConfigCache.get(key);
    const pda = deriveStreamConfigPda(businessPda);
    let account;
    try {
        account = await getAccountInfoRead(pda, 'confirmed');
    }
    catch (e) {
        throw new Error(`read_rpc_getAccountInfo_stream_config_failed url=${normalizeRpcUrl(READ_RPC_URL)} stream_config=${pda.toBase58()} reason=${e?.message || 'unknown'}`);
    }
    if (!account)
        return null;
    const parsed = parseStreamConfig(Buffer.from(account.data));
    if (!parsed)
        return null;
    streamConfigCache.set(key, parsed);
    return parsed;
}
function clearPerTickCaches() {
    businessCache.clear();
    vaultCache.clear();
    streamConfigCache.clear();
}
async function listPendingWithdrawRequests() {
    let requestAccounts;
    try {
        requestAccounts = await getProgramAccountsRead(PROGRAM_ID, {
            filters: [{ dataSize: WITHDRAW_REQUEST_V2_ACCOUNT_LEN }],
            commitment: 'confirmed',
        });
    }
    catch (e) {
        throw new Error(`read_rpc_getProgramAccounts_withdraw_requests_failed url=${normalizeRpcUrl(READ_RPC_URL)} program=${PROGRAM_ID.toBase58()} reason=${e?.message || 'unknown'}`);
    }
    const pending = [];
    for (const account of requestAccounts) {
        const parsed = parseWithdrawRequestV2(account.pubkey, Buffer.from(account.account.data));
        if (parsed && parsed.isPending)
            pending.push(parsed);
    }
    pending.sort((a, b) => a.requestedAt - b.requestedAt);
    return pending;
}
async function listActiveStreams() {
    const byAddress = new Map();
    let programOwned;
    try {
        programOwned = await getProgramAccountsRead(PROGRAM_ID, {
            filters: [{ dataSize: EMPLOYEE_STREAM_V2_ACCOUNT_LEN }],
            commitment: 'confirmed',
        });
    }
    catch (e) {
        throw new Error(`read_rpc_getProgramAccounts_failed url=${normalizeRpcUrl(READ_RPC_URL)} program=${PROGRAM_ID.toBase58()} reason=${e?.message || 'unknown'}`);
    }
    for (const account of programOwned) {
        const parsed = parseEmployeeStreamV2(account.pubkey, PROGRAM_ID, Buffer.from(account.account.data));
        if (parsed && parsed.isActive) {
            byAddress.set(parsed.address.toBase58(), parsed);
        }
    }
    return Array.from(byAddress.values());
}
function buildStreamIndexArg(streamIndex) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(streamIndex));
    return b;
}
async function sendInstruction(label, instruction, connection = txConnection, extraSigners = []) {
    const tx = new web3_js_1.Transaction().add(instruction);
    tx.feePayer = payer.publicKey;
    const endpoint = rpcEndpoint(connection);
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
        tx.recentBlockhash = blockhash;
        tx.sign(payerSigner, ...extraSigners);
        const signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
            preflightCommitment: 'processed',
        });
        await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        log(`${label} tx=${signature} rpc=${endpoint}`);
        return signature;
    }
    catch (e) {
        let programLogs = '';
        if (e instanceof web3_js_1.SendTransactionError && typeof e.getLogs === 'function') {
            try {
                const logs = await e.getLogs(connection);
                if (logs && logs.length > 0) {
                    programLogs = logs.slice(-20).join(' | ');
                }
            }
            catch {
                // Keep original error if log extraction fails.
            }
        }
        const logsSuffix = programLogs.length > 0 ? ` | program_logs=${programLogs}` : '';
        throw new Error(`${label} failed rpc=${endpoint} reason=${e?.message || 'unknown'}${logsSuffix}`);
    }
}
function accrueIx(business, streamIndex) {
    const streamConfig = deriveStreamConfigPda(business);
    const employee = deriveEmployeeStreamPda(business, streamIndex);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: false },
            { pubkey: employee, isSigner: false, isWritable: true },
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
            instructionDiscriminator('accrue_v2'),
            buildStreamIndexArg(streamIndex),
        ]),
    });
}
function autoSettleIx(business, streamIndex, vaultTokenAccount, employeeTokenAccount) {
    const streamConfig = deriveStreamConfigPda(business);
    const vault = deriveVaultPda(business);
    const employee = deriveEmployeeStreamPda(business, streamIndex);
    const magicContext = deriveMagicContext(employee);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: false },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: employee, isSigner: false, isWritable: true },
            { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
            { pubkey: employeeTokenAccount, isSigner: false, isWritable: true },
            { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
            { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: magicContext, isSigner: false, isWritable: true },
            { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
            instructionDiscriminator('auto_settle_stream_v2'),
            buildStreamIndexArg(streamIndex),
        ]),
    });
}
function processWithdrawRequestIx(request, nonce, vaultTokenAccount, payoutTokenAccount) {
    const streamConfig = deriveStreamConfigPda(request.business);
    const vault = deriveVaultPda(request.business);
    const employee = deriveEmployeeStreamPda(request.business, request.streamIndex);
    const shieldedPayout = deriveShieldedPayoutPda(request.business, request.streamIndex, nonce);
    // Phase 2b: 2-hop — vault → payout_token_account.
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: request.business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: false },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: employee, isSigner: false, isWritable: true },
            { pubkey: request.address, isSigner: false, isWritable: true },
            { pubkey: shieldedPayout, isSigner: false, isWritable: true },
            { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
            { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
            { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
            instructionDiscriminator('process_withdraw_request_v2'),
            buildStreamIndexArg(request.streamIndex),
            nonceBuf,
        ]),
    });
}
/**
 * Read the mint from an on-chain Inco token account.
 * Inco token account layout: discriminator(8) + mint(32) + owner(32) + ...
 * Returns null if the account can't be read or parsed.
 */
async function readTokenAccountMint(tokenAccount) {
    try {
        const info = await getAccountInfoRead(tokenAccount, 'confirmed');
        if (info && info.data.length >= 40) {
            const data = Buffer.from(info.data);
            return new web3_js_1.PublicKey(data.subarray(8, 40));
        }
    }
    catch (e) {
        log(`[PREFLIGHT] readTokenAccountMint failed for ${tokenAccount.toBase58()}: ${e?.message || 'unknown'}`);
    }
    return null;
}
/**
 * Run preflight checks before processing a withdraw request.
 * Validates that the vault's on-chain state is consistent with the platform's canonical mint.
 * Returns { ok: true } if all checks pass, or { ok: false, reason, remediation } on failure.
 */
async function runWithdrawPreflight(vault, request) {
    // Check 1: Vault token account exists on-chain
    const vaultTokenInfo = await getAccountInfoRead(vault.tokenAccount, 'confirmed').catch(() => null);
    if (!vaultTokenInfo) {
        return {
            ok: false,
            reason: `[PREFLIGHT] Vault token account ${vault.tokenAccount.toBase58()} not found on-chain.`,
            remediation: 'Re-create the vault token account in the Employer Portal (Advanced Controls > Step 2: Create Vault Token Account).',
        };
    }
    // Check 2: Vault mint matches platform canonical PAYUSD_MINT
    const vaultMint = await readTokenAccountMint(vault.tokenAccount);
    if (!vaultMint) {
        return {
            ok: false,
            reason: `[PREFLIGHT] Could not read mint from vault token account ${vault.tokenAccount.toBase58()}.`,
            remediation: 'The vault token account may be corrupted. Re-create it in the Employer Portal.',
        };
    }
    if (!vaultMint.equals(PAYUSD_MINT)) {
        return {
            ok: false,
            reason: `[PREFLIGHT] CRITICAL Mint mismatch! Vault uses ${vaultMint.toBase58()} but platform requires ${PAYUSD_MINT.toBase58()}.`,
            remediation: 'Open the Employer Portal > Advanced Controls and click "Fix Vault Mint" to rotate the vault to the correct mint. This requires the employer wallet signature.',
        };
    }
    return { ok: true };
}
/**
 * Create an Inco token account for the shielded payout PDA.
 * Returns the Keypair (address) and the TransactionInstruction.
 * Uses the provided mint so it always matches the vault's token account.
 */
function createPayoutTokenAccountIx(payerPubkey, owner, mint = PAYUSD_MINT) {
    const keypair = web3_js_1.Keypair.generate();
    const instruction = new web3_js_1.TransactionInstruction({
        programId: INCO_TOKEN_PROGRAM_ID,
        keys: [
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: owner, isSigner: false, isWritable: false },
            { pubkey: payerPubkey, isSigner: true, isWritable: true },
            { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        ],
        data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
    });
    return { keypair, instruction };
}
function commitUndelegateIx(business, streamIndex) {
    const streamConfig = deriveStreamConfigPda(business);
    const employee = deriveEmployeeStreamPda(business, streamIndex);
    const magicContext = deriveMagicContext(employee);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: false },
            { pubkey: employee, isSigner: false, isWritable: true },
            { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: magicContext, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
            instructionDiscriminator('commit_and_undelegate_stream_v2'),
            buildStreamIndexArg(streamIndex),
        ]),
    });
}
function redelegateIx(business, streamIndex) {
    const streamConfig = deriveStreamConfigPda(business);
    const employee = deriveEmployeeStreamPda(business, streamIndex);
    const bufferEmployee = deriveBufferPda(employee);
    const delegationRecordEmployee = deriveDelegationRecordPda(employee);
    const delegationMetadataEmployee = deriveDelegationMetadataPda(employee);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: false },
            { pubkey: bufferEmployee, isSigner: false, isWritable: true },
            { pubkey: delegationRecordEmployee, isSigner: false, isWritable: true },
            { pubkey: delegationMetadataEmployee, isSigner: false, isWritable: true },
            { pubkey: employee, isSigner: false, isWritable: true },
            { pubkey: DEFAULT_VALIDATOR, isSigner: false, isWritable: false },
            { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // owner_program
            { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false }, // delegation_program
        ],
        data: Buffer.concat([
            instructionDiscriminator('redelegate_stream_v2'),
            buildStreamIndexArg(streamIndex),
        ]),
    });
}
function pauseComplianceIx(business) {
    const streamConfig = deriveStreamConfigPda(business);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([
            instructionDiscriminator('pause_stream_v2'),
            Buffer.from([PAUSE_REASON_COMPLIANCE]),
        ]),
    });
}
function resumeStreamIx(business) {
    const streamConfig = deriveStreamConfigPda(business);
    return new web3_js_1.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: business, isSigner: false, isWritable: false },
            { pubkey: streamConfig, isSigner: false, isWritable: true },
        ],
        data: instructionDiscriminator('resume_stream_v2'),
    });
}
async function retry(label, fn) {
    let attempt = 0;
    let lastError;
    while (attempt < DEFAULT_MAX_RETRIES) {
        try {
            return await fn();
        }
        catch (e) {
            lastError = e;
            attempt += 1;
            if (attempt >= DEFAULT_MAX_RETRIES)
                break;
            const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
            log(`${label} failed attempt=${attempt}, retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastError;
}
async function waitForOwner(account, expectedOwner, attempts = DEFAULT_UNDELEGATE_WAIT_ATTEMPTS, delayMs = DEFAULT_UNDELEGATE_WAIT_MS) {
    for (let i = 0; i < attempts; i += 1) {
        const info = await getAccountInfoRead(account, 'confirmed');
        if (info && info.owner.equals(expectedOwner)) {
            return true;
        }
        await sleep(delayMs);
    }
    return false;
}
function connectionForRpc(url) {
    const normalized = normalizeRpcUrl(url);
    const existing = txConnectionCache.get(normalized);
    if (existing)
        return existing;
    const created = new web3_js_1.Connection(normalized, 'confirmed');
    txConnectionCache.set(normalized, created);
    return created;
}
function rpcEndpoint(connection) {
    const endpoint = connection.rpcEndpoint;
    if (typeof endpoint === 'string' && endpoint.length > 0) {
        return normalizeRpcUrl(endpoint);
    }
    return 'unknown';
}
function parseDelegationEndpoint(result) {
    if (!result)
        return null;
    const delegated = Boolean(result.delegated) ||
        Boolean(result.isDelegated) ||
        Boolean(result.delegation?.delegated);
    if (!delegated)
        return null;
    const raw = result.delegation?.fqdn ||
        result.delegation?.endpoint ||
        result.fqdn ||
        result.endpoint;
    if (!raw || typeof raw !== 'string')
        return null;
    const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
    return normalizeRpcUrl(withProtocol);
}
function isSettleTooSoonError(error) {
    const message = String(error?.message || error || '');
    return (message.includes('SettleTooSoon') ||
        message.includes('0x177d') ||
        message.includes('Error Number: 6013'));
}
function isBlockhashNotFoundError(error) {
    const message = String(error?.message || error || '');
    return message.includes('Blockhash not found');
}
async function getChainUnixTime() {
    try {
        const slot = await readConnection.getSlot('processed');
        const blockTime = await readConnection.getBlockTime(slot);
        if (typeof blockTime === 'number' && blockTime > 0)
            return blockTime;
    }
    catch {
        // Fall back to local wall clock if block time lookup fails.
    }
    return Math.floor(Date.now() / 1000);
}
function endpointHost(endpoint) {
    try {
        return new URL(endpoint).host.toLowerCase();
    }
    catch {
        return '';
    }
}
function isRetryableRouterStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}
async function routerStatusFetch(url, body) {
    if (!fetchAny)
        throw new Error('fetch unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTER_STATUS_TIMEOUT_MS);
    try {
        return await fetchAny(normalizeRpcUrl(url), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
        });
    }
    finally {
        clearTimeout(timeout);
    }
}
async function getDelegationStatusWithRetry(streamAccount) {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getDelegationStatus',
        params: [streamAccount.toBase58()],
    });
    let lastReason = '';
    for (let attempt = 1; attempt <= ROUTER_STATUS_RETRIES; attempt += 1) {
        for (const url of ROUTER_RPC_URLS) {
            try {
                const res = await routerStatusFetch(url, body);
                if (!res.ok) {
                    lastReason = `status=${res.status} url=${normalizeRpcUrl(url)}`;
                    if (isRetryableRouterStatus(res.status))
                        continue;
                    log(`getDelegationStatus failed stream=${streamAccount.toBase58()} ${lastReason}`);
                    return null;
                }
                const payload = await res.json();
                return { payload, usedUrl: normalizeRpcUrl(url) };
            }
            catch (e) {
                lastReason = `url=${normalizeRpcUrl(url)} reason=${e?.message || 'unknown'}`;
            }
        }
        if (attempt < ROUTER_STATUS_RETRIES) {
            const delay = ROUTER_STATUS_BACKOFF_MS * Math.pow(2, attempt - 1);
            await sleep(delay);
        }
    }
    log(`getDelegationStatus exhausted retries stream=${streamAccount.toBase58()} attempts=${ROUTER_STATUS_RETRIES} ${lastReason}`);
    return null;
}
function withTeeTokenIfNeeded(endpoint) {
    const host = endpointHost(endpoint);
    const isTee = host === 'tee.magicblock.app';
    if (!isTee)
        return endpoint;
    try {
        const url = new URL(endpoint);
        if (url.searchParams.get('token'))
            return normalizeRpcUrl(url.toString());
        if (!TEE_AUTH_TOKEN)
            return null;
        url.searchParams.set('token', TEE_AUTH_TOKEN);
        return normalizeRpcUrl(url.toString());
    }
    catch {
        return null;
    }
}
async function resolveDelegatedTxConnection(streamAccount) {
    if (!fetchAny)
        return { connection: txConnection };
    const streamKey = streamAccount.toBase58();
    const nowMs = Date.now();
    const cached = delegatedRouteCache.get(streamKey);
    if (cached && nowMs - cached.cachedAtMs <= ROUTER_STATUS_CACHE_MS) {
        return { connection: connectionForRpc(cached.endpoint) };
    }
    try {
        const status = await getDelegationStatusWithRetry(streamAccount);
        if (!status) {
            if (cached) {
                const ageMs = nowMs - cached.cachedAtMs;
                log(`getDelegationStatus unavailable stream=${streamKey}; using cached delegated endpoint=${cached.endpoint} age_ms=${ageMs}`);
                return { connection: connectionForRpc(cached.endpoint) };
            }
            return { connection: txConnection };
        }
        const statusResult = status.payload?.result;
        const parsedEndpoint = parseDelegationEndpoint(statusResult);
        const delegatedNoEndpoint = Boolean(statusResult?.delegated) ||
            Boolean(statusResult?.isDelegated) ||
            Boolean(statusResult?.delegation?.delegated);
        // Some ER endpoints return { isDelegated: true } without fqdn/endpoint.
        // In that case, use the endpoint that returned the delegated status.
        const endpointCandidate = parsedEndpoint || (delegatedNoEndpoint ? status.usedUrl : null);
        if (!endpointCandidate) {
            delegatedRouteCache.delete(streamKey);
            return { connection: txConnection };
        }
        const endpoint = withTeeTokenIfNeeded(endpointCandidate);
        if (!endpoint) {
            return {
                connection: txConnection,
                skipReason: `delegated_to_tee_without_token endpoint=${endpointCandidate}`,
            };
        }
        delegatedRouteCache.set(streamKey, { endpoint, cachedAtMs: nowMs });
        if (endpoint !== normalizeRpcUrl(TX_RPC_URL)) {
            log(`Routing stream=${streamAccount.toBase58()} to delegated ER endpoint=${endpoint}`);
        }
        return { connection: connectionForRpc(endpoint) };
    }
    catch (e) {
        if (cached) {
            const ageMs = nowMs - cached.cachedAtMs;
            log(`getDelegationStatus error stream=${streamKey} reason=${e?.message || 'unknown'}; using cached delegated endpoint=${cached.endpoint} age_ms=${ageMs}`);
            return { connection: connectionForRpc(cached.endpoint) };
        }
        log(`getDelegationStatus error stream=${streamKey} reason=${e?.message || 'unknown'}; using default TX RPC`);
        return { connection: txConnection };
    }
}
async function checkComplianceFailClosed(wallet) {
    if (!RANGE_API_KEY) {
        return { ok: false, reason: 'Range API key missing', hardFail: false };
    }
    const cached = complianceCache.get(wallet);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.isCompliant && now - cached.checkedAt <= DEFAULT_COMPLIANCE_WINDOW_SECS) {
        return { ok: true, reason: 'cached', hardFail: false };
    }
    try {
        const [riskRes, sanctionsRes] = await Promise.all([
            fetchAny(`https://api.range.org/v1/risk/address?address=${encodeURIComponent(wallet)}&network=solana`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${RANGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }),
            fetchAny(`https://api.range.org/v1/risk/sanctions/${encodeURIComponent(wallet)}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${RANGE_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }),
        ]);
        if (!riskRes.ok || !sanctionsRes.ok) {
            return {
                ok: false,
                reason: `Range API unavailable risk=${riskRes.status} sanctions=${sanctionsRes.status}`,
                hardFail: false,
            };
        }
        const risk = await riskRes.json();
        const sanctions = await sanctionsRes.json();
        const isCompliant = Number(risk?.riskScore || 10) <= 3 &&
            !Boolean(sanctions?.is_token_blacklisted) &&
            !Boolean(sanctions?.is_ofac_sanctioned);
        complianceCache.set(wallet, {
            checkedAt: now,
            isCompliant,
        });
        if (!isCompliant) {
            return {
                ok: false,
                reason: `riskScore=${risk?.riskScore} blacklisted=${sanctions?.is_token_blacklisted} ofac=${sanctions?.is_ofac_sanctioned}`,
                hardFail: true,
            };
        }
        return { ok: true, reason: 'ok', hardFail: false };
    }
    catch (e) {
        return {
            ok: false,
            reason: `Range check failed: ${e?.message || 'unknown error'}`,
            hardFail: false,
        };
    }
}
function isNoAccruedBalanceError(error) {
    const message = String(error ?? '');
    return message.includes('NoAccruedBalance') || message.includes('No accrued balance');
}
async function processWithdrawRequest(request) {
    const requestKey = `${request.address.toBase58()}:${request.requestedAt}`;
    if (idempotency.has(requestKey))
        return;
    const retryAt = withdrawDecryptRetryAfter.get(requestKey) || 0;
    if (retryAt > Date.now())
        return;
    const business = await getBusiness(request.business);
    if (!business) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=business_missing`);
        return;
    }
    const config = await getStreamConfig(request.business);
    if (!config)
        throw new Error(`v2 stream config missing for ${request.business.toBase58()}`);
    if (config.isPaused) {
        // Devnet quality-of-life: if compliance is disabled but the business is stuck in a
        // compliance pause (reason=2), auto-resume with a cooldown so the app doesn't feel broken.
        if (!COMPLIANCE_ENABLED && config.pauseReason === PAUSE_REASON_COMPLIANCE) {
            const key = request.business.toBase58();
            const last = autoResumeCooldownByBusiness.get(key) || 0;
            const now = Date.now();
            if (now - last >= 60000) {
                autoResumeCooldownByBusiness.set(key, now);
                try {
                    await retry(`resume_stream_v2 business=${key}`, () => sendInstruction('resume_stream_v2', resumeStreamIx(request.business), readConnection));
                    log(`Auto-resumed business=${key} reason=compliance_disabled`);
                }
                catch (e) {
                    log(`Auto-resume failed business=${key} reason=${e?.message || 'unknown'}`);
                }
            }
        }
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=config_paused pause_reason=${config.pauseReason}`);
        return;
    }
    if (!(payer.publicKey.equals(config.keeper) || payer.publicKey.equals(business.owner))) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=keeper_not_authorized`);
        return;
    }
    if (COMPLIANCE_ENABLED) {
        const compliance = await checkComplianceFailClosed(request.requester.toBase58());
        if (!compliance.ok) {
            if (!compliance.hardFail && !PAUSE_ON_COMPLIANCE_SOFT_FAIL) {
                const reason = `compliance_soft_fail_skip: ${compliance.reason}`;
                await deadLetterWithdrawRequest('compliance_soft_fail', request, reason);
                log(`Skipping withdraw_request=${request.address.toBase58()} reason=${reason}`);
                return;
            }
            await retry(`pause_stream_v2 business=${request.business.toBase58()}`, () => sendInstruction('pause_stream_v2', pauseComplianceIx(request.business), readConnection));
            const reason = `compliance_fail_closed: ${compliance.reason}`;
            await deadLetterWithdrawRequest('compliance_pause', request, reason);
            await sendAlertWithdrawRequest('compliance_pause', request, reason);
            log(`Paused business=${request.business.toBase58()} reason=${reason}`);
            return;
        }
    }
    const vaultPda = business.vault.equals(web3_js_1.PublicKey.default)
        ? deriveVaultPda(request.business)
        : business.vault;
    const vault = await getVault(vaultPda);
    if (!vault)
        throw new Error(`Vault missing for business ${request.business.toBase58()}`);
    const employeePda = deriveEmployeeStreamPda(request.business, request.streamIndex);
    let employeeInfo = await getAccountInfoRead(employeePda, 'confirmed');
    if (!employeeInfo) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_stream_missing`);
        return;
    }
    let delegatedOnChain = employeeInfo.owner.equals(DELEGATION_PROGRAM_ID);
    const delegatedOriginally = delegatedOnChain;
    let accruedOnEr = false;
    let employeeParsed = parseEmployeeStreamV2(employeePda, employeeInfo.owner, Buffer.from(employeeInfo.data));
    if (!employeeParsed) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_parse_failed`);
        return;
    }
    if (delegatedOnChain && ENFORCE_MAGIC_CONTEXT_CHECK && !magicCommitSupported) {
        if (!delegatedUnsupportedLogged.has(employeePda.toBase58())) {
            delegatedUnsupportedLogged.add(employeePda.toBase58());
            const reason = 'delegated_stream_requires_magic_commit_context (Magic program/context unavailable on configured RPC)';
            log(`Skipping withdraw_request=${request.address.toBase58()} reason=${reason}`);
            await deadLetter('delegated_stream_skipped', employeeParsed, reason);
        }
        return;
    }
    // If delegated, commit+undelegate first.
    if (delegatedOnChain) {
        const inFlightAt = undelegateInFlight.get(employeePda.toBase58());
        if (inFlightAt) {
            const elapsedMs = Date.now() - inFlightAt;
            if (elapsedMs < DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000) {
                log(`Undelegate pending stream=${employeePda.toBase58()} waited_ms=${elapsedMs} cooldown_ms=${DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000}`);
                return;
            }
        }
        const route = await resolveDelegatedTxConnection(employeePda);
        if (route.skipReason) {
            if (!teeTokenMissingLogged.has(employeePda.toBase58())) {
                teeTokenMissingLogged.add(employeePda.toBase58());
                log(`Skipping withdraw_request=${request.address.toBase58()} reason=${route.skipReason}`);
                await deadLetter('delegated_stream_skipped', employeeParsed, route.skipReason);
            }
            return;
        }
        // Optional: checkpoint accrual inside ER before committing.
        // If this fails (e.g. program availability mismatch), we fall back to base-layer accrual after undelegation.
        if (ACCRUE_ON_ER_BEFORE_COMMIT) {
            try {
                await retry(`accrue_v2(er) stream=${request.streamIndex}`, () => sendInstruction('accrue_v2', accrueIx(request.business, request.streamIndex), route.connection));
                accruedOnEr = true;
            }
            catch (e) {
                const reason = e?.message || 'unknown';
                log(`accrue_v2(er) failed stream=${employeePda.toBase58()} reason=${reason}; falling back to base-layer accrual`);
            }
        }
        try {
            await retry(`commit_and_undelegate_stream_v2 stream=${request.streamIndex}`, () => sendInstruction('commit_and_undelegate_stream_v2', commitUndelegateIx(request.business, request.streamIndex), route.connection));
        }
        catch (e) {
            if (isBlockhashNotFoundError(e)) {
                log(`Skipping withdraw_request=${request.address.toBase58()} reason=blockhash_not_found`);
                return;
            }
            throw e;
        }
        undelegateInFlight.set(employeePda.toBase58(), Date.now());
        log(`Waiting undelegate stream=${employeePda.toBase58()} timeout_ms=${DEFAULT_UNDELEGATE_WAIT_ATTEMPTS * DEFAULT_UNDELEGATE_WAIT_MS}`);
        const undelegated = await waitForOwner(employeePda, PROGRAM_ID);
        if (!undelegated) {
            log(`Undelegate still pending stream=${employeePda.toBase58()} reason=callback_delayed`);
            return;
        }
        undelegateInFlight.delete(employeePda.toBase58());
        employeeInfo = await getAccountInfoRead(employeePda, 'confirmed');
        if (!employeeInfo) {
            log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_stream_missing_after_undelegate`);
            return;
        }
        delegatedOnChain = employeeInfo.owner.equals(DELEGATION_PROGRAM_ID);
        employeeParsed =
            parseEmployeeStreamV2(employeePda, employeeInfo.owner, Buffer.from(employeeInfo.data)) ||
                employeeParsed;
    }
    if (delegatedOnChain) {
        // Undelegation callback still pending; try next tick.
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=stream_still_delegated`);
        return;
    }
    // ALWAYS checkpoint accrual before settling — required by the on-chain 30-second freshness guard.
    // Skip only if already checkpointed in ER pre-commit above.
    if (!accruedOnEr) {
        await retry(`accrue_v2 stream=${request.streamIndex}`, () => sendInstruction('accrue_v2', accrueIx(request.business, request.streamIndex), readConnection));
    }
    // Reload stream post-accrual to capture the latest handles.
    employeeInfo = await getAccountInfoRead(employeePda, 'confirmed');
    if (!employeeInfo) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_stream_missing_after_accrue`);
        return;
    }
    employeeParsed =
        parseEmployeeStreamV2(employeePda, employeeInfo.owner, Buffer.from(employeeInfo.data)) ||
            employeeParsed;
    // ── PREFLIGHT CHECKS ──
    // Validate vault state before processing. Strict enforcement — no silent auto-heal.
    const preflight = await runWithdrawPreflight(vault, request);
    if (!preflight.ok) {
        const { reason, remediation } = preflight;
        log(reason);
        log(`[PREFLIGHT] Remediation: ${remediation}`);
        await deadLetterWithdrawRequest('preflight_failed', request, `${reason} | Remediation: ${remediation}`);
        await sendAlertWithdrawRequest('preflight_failed', request, `${reason} | Fix: ${remediation}`);
        return;
    }
    // Phase 2b: Create Inco token account for shielded payout PDA, then buffer.
    // Preflight passed — mint is guaranteed to be PAYUSD_MINT.
    const payoutNonce = Math.floor(Date.now() / 1000);
    const shieldedPayoutPda = deriveShieldedPayoutPda(request.business, request.streamIndex, payoutNonce);
    const { keypair: payoutTokenKeypair, instruction: createPayoutAcctIx } = createPayoutTokenAccountIx(payer.publicKey, shieldedPayoutPda, PAYUSD_MINT);
    log(`settle_audit stream=${employeePda.toBase58()} ` +
        `accrued_handle=${employeeParsed.accruedHandle.toString()} ` +
        `nonce=${payoutNonce} payout_token=${payoutTokenKeypair.publicKey.toBase58()} mode=2hop_shielded`);
    try {
        // Step 1: Create the payout token account.
        await retry(`create_payout_token_account nonce=${payoutNonce}`, () => sendInstruction('create_payout_token_account', createPayoutAcctIx, readConnection, [payoutTokenKeypair]));
        // Step 2: Buffer the payout (vault → payout_token_account).
        await retry(`process_withdraw_request_v2 stream=${request.streamIndex}`, () => sendInstruction('process_withdraw_request_v2', processWithdrawRequestIx(request, payoutNonce, vault.tokenAccount, payoutTokenKeypair.publicKey), readConnection));
    }
    catch (e) {
        if (isSettleTooSoonError(e)) {
            log(`Skipping withdraw_request=${request.address.toBase58()} reason=settle_too_soon`);
            return;
        }
        if (isNoAccruedBalanceError(e)) {
            log(`Skipping withdraw_request=${request.address.toBase58()} reason=no_accrued_balance`);
            return;
        }
        if (String(e?.message || '').includes('StreamDelegated')) {
            log(`Skipping withdraw_request=${request.address.toBase58()} reason=stream_still_delegated`);
            return;
        }
        throw e;
    }
    if (REDELEGATE_AFTER_WITHDRAW && delegatedOriginally) {
        try {
            await retry(`redelegate_stream_v2 stream=${request.streamIndex}`, () => sendInstruction('redelegate_stream_v2', redelegateIx(request.business, request.streamIndex), readConnection));
        }
        catch (e) {
            const reason = e?.message || 'redelegate failed';
            await deadLetter('redelegate_error', employeeParsed, reason);
            await sendAlert('redelegate_error', employeeParsed, reason);
            log(`Redelegate failed stream=${employeePda.toBase58()} reason=${reason}`);
        }
    }
    idempotency.add(requestKey);
    withdrawDecryptRetryAfter.delete(requestKey);
    log(`Processed withdraw_request=${request.address.toBase58()} stream=${employeePda.toBase58()}`);
}
async function processStream(inputStream) {
    let stream = inputStream;
    const streamKey = stream.address.toBase58();
    let delegatedOnChain = stream.owner.equals(DELEGATION_PROGRAM_ID);
    let shouldRedelegate = delegatedOnChain || undelegateInFlight.has(streamKey);
    // Always refresh owner from chain at stream start to avoid stale delegation state.
    const latestInfo = await getAccountInfoRead(stream.address, 'confirmed');
    if (latestInfo) {
        delegatedOnChain = latestInfo.owner.equals(DELEGATION_PROGRAM_ID);
        const parsedLatest = parseEmployeeStreamV2(stream.address, latestInfo.owner, Buffer.from(latestInfo.data));
        if (parsedLatest) {
            stream = parsedLatest;
        }
        shouldRedelegate = delegatedOnChain || shouldRedelegate;
    }
    if (delegatedOnChain && ENFORCE_MAGIC_CONTEXT_CHECK && !magicCommitSupported) {
        if (!delegatedUnsupportedLogged.has(streamKey)) {
            delegatedUnsupportedLogged.add(streamKey);
            const reason = 'delegated_stream_requires_magic_commit_context (Magic program/context unavailable on configured RPC)';
            log(`Skipping stream=${streamKey} reason=${reason}`);
            await deadLetter('delegated_stream_skipped', stream, reason);
        }
        return;
    }
    const business = await getBusiness(stream.business);
    if (!business)
        throw new Error(`Business account missing for ${stream.business.toBase58()}`);
    const config = await getStreamConfig(stream.business);
    if (!config)
        throw new Error(`v2 stream config missing for ${stream.business.toBase58()}`);
    if (config.isPaused) {
        log(`Skipping stream=${stream.address.toBase58()} reason=config_paused pause_reason=${config.pauseReason}`);
        return;
    }
    if (!(payer.publicKey.equals(config.keeper) || payer.publicKey.equals(business.owner))) {
        log(`Skipping stream=${stream.address.toBase58()} reason=keeper_not_authorized`);
        return;
    }
    const now = await getChainUnixTime();
    // Skip streams whose pay period has completed.
    if (stream.periodEnd > 0 && now >= stream.periodEnd) {
        log(`Skipping stream=${stream.address.toBase58()} reason=period_completed`);
        return;
    }
    const elapsedSinceSettle = now - stream.lastSettleTime;
    if (elapsedSinceSettle < config.settleIntervalSecs + DEFAULT_SETTLE_GUARD_SECS) {
        return;
    }
    const settleWindow = Math.floor(now / config.settleIntervalSecs);
    const idempotencyKey = `${stream.address.toBase58()}:${settleWindow}`;
    if (idempotency.has(idempotencyKey)) {
        return;
    }
    // NOTE: Stream-based compliance gating was tied to a stream->wallet mapping file.
    // Expensee pivot uses withdraw requests instead, where the employee requester wallet
    // is available on-chain (WithdrawRequestV2). Compliance checks (if enabled) should be
    // applied to withdraw requests, not here.
    const vaultPda = business.vault.equals(web3_js_1.PublicKey.default)
        ? deriveVaultPda(stream.business)
        : business.vault;
    const vault = await getVault(vaultPda);
    if (!vault)
        throw new Error(`Vault missing for business ${stream.business.toBase58()}`);
    if (delegatedOnChain) {
        const inFlightAt = undelegateInFlight.get(streamKey);
        if (inFlightAt) {
            const info = await getAccountInfoRead(stream.address, 'confirmed');
            if (info && info.owner.equals(PROGRAM_ID)) {
                undelegateInFlight.delete(streamKey);
                const parsed = parseEmployeeStreamV2(stream.address, info.owner, Buffer.from(info.data));
                if (parsed) {
                    stream = parsed;
                    delegatedOnChain = stream.owner.equals(DELEGATION_PROGRAM_ID);
                }
            }
            else {
                const elapsedMs = Date.now() - inFlightAt;
                if (elapsedMs < DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000) {
                    log(`Undelegate pending stream=${streamKey} waited_ms=${elapsedMs} cooldown_ms=${DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000}`);
                    return;
                }
            }
        }
        if (delegatedOnChain) {
            const route = await resolveDelegatedTxConnection(stream.address);
            if (route.skipReason) {
                if (!teeTokenMissingLogged.has(streamKey)) {
                    teeTokenMissingLogged.add(streamKey);
                    log(`Skipping stream=${streamKey} reason=${route.skipReason}`);
                    await deadLetter('delegated_stream_skipped', stream, route.skipReason);
                }
                return;
            }
            const delegatedTxConnection = route.connection;
            try {
                await retry(`commit_and_undelegate_stream_v2 stream=${stream.streamIndex}`, () => sendInstruction('commit_and_undelegate_stream_v2', commitUndelegateIx(stream.business, stream.streamIndex), delegatedTxConnection));
            }
            catch (e) {
                if (isBlockhashNotFoundError(e)) {
                    log(`Skipping stream=${stream.address.toBase58()} reason=blockhash_not_found`);
                    return;
                }
                throw e;
            }
            undelegateInFlight.set(streamKey, Date.now());
            shouldRedelegate = true;
            log(`Waiting undelegate stream=${stream.address.toBase58()} timeout_ms=${DEFAULT_UNDELEGATE_WAIT_ATTEMPTS * DEFAULT_UNDELEGATE_WAIT_MS}`);
            const undelegated = await waitForOwner(stream.address, PROGRAM_ID);
            if (!undelegated) {
                log(`Undelegate still pending stream=${stream.address.toBase58()} reason=callback_delayed`);
                return;
            }
            undelegateInFlight.delete(streamKey);
            const refreshed = await getAccountInfoRead(stream.address, 'confirmed');
            if (refreshed) {
                const parsed = parseEmployeeStreamV2(stream.address, refreshed.owner, Buffer.from(refreshed.data));
                if (parsed) {
                    stream = parsed;
                    delegatedOnChain = stream.owner.equals(DELEGATION_PROGRAM_ID);
                }
            }
        }
    }
    if (!delegatedOnChain && undelegateInFlight.has(streamKey)) {
        const inFlightAt = undelegateInFlight.get(streamKey);
        const info = await getAccountInfoRead(stream.address, 'confirmed');
        if (info && info.owner.equals(PROGRAM_ID)) {
            undelegateInFlight.delete(streamKey);
            shouldRedelegate = true;
            log(`Undelegate finalized stream=${streamKey} waited_ms=${Date.now() - inFlightAt}`);
            const parsed = parseEmployeeStreamV2(stream.address, info.owner, Buffer.from(info.data));
            if (parsed) {
                stream = parsed;
                delegatedOnChain = stream.owner.equals(DELEGATION_PROGRAM_ID);
            }
        }
    }
    if (!delegatedOnChain) {
        await retry(`accrue_v2 stream=${stream.streamIndex}`, () => sendInstruction('accrue_v2', accrueIx(stream.business, stream.streamIndex), readConnection));
    }
    else {
        log(`Skipping accrue_v2 for delegated stream=${stream.address.toBase58()}`);
    }
    let settleConnection = readConnection;
    const settleOwnerInfo = await getAccountInfoRead(stream.address, 'confirmed');
    if (settleOwnerInfo && !settleOwnerInfo.owner.equals(PROGRAM_ID)) {
        const route = await resolveDelegatedTxConnection(stream.address);
        if (route.skipReason) {
            if (!teeTokenMissingLogged.has(streamKey)) {
                teeTokenMissingLogged.add(streamKey);
                log(`Skipping stream=${streamKey} reason=${route.skipReason}`);
                await deadLetter('delegated_stream_skipped', stream, route.skipReason);
            }
            return;
        }
        settleConnection = route.connection;
    }
    try {
        await retry(`auto_settle_stream_v2 stream=${stream.streamIndex}`, () => sendInstruction('auto_settle_stream_v2', autoSettleIx(stream.business, stream.streamIndex, vault.tokenAccount, stream.employeeTokenAccount), settleConnection));
    }
    catch (e) {
        if (!isSettleTooSoonError(e)) {
            throw e;
        }
        log(`Skipping stream=${stream.address.toBase58()} reason=settle_too_soon`);
        if (shouldRedelegate) {
            try {
                await retry(`redelegate_stream_v2 stream=${stream.streamIndex}`, () => sendInstruction('redelegate_stream_v2', redelegateIx(stream.business, stream.streamIndex), readConnection));
            }
            catch (redelegateError) {
                const reason = redelegateError?.message || 'redelegate failed';
                await deadLetter('redelegate_error', stream, reason);
                await sendAlert('redelegate_error', stream, reason);
                log(`Redelegate failed stream=${stream.address.toBase58()} reason=${reason}`);
            }
        }
        return;
    }
    if (shouldRedelegate) {
        try {
            await retry(`redelegate_stream_v2 stream=${stream.streamIndex}`, () => sendInstruction('redelegate_stream_v2', redelegateIx(stream.business, stream.streamIndex), readConnection));
        }
        catch (e) {
            const reason = e?.message || 'redelegate failed';
            await deadLetter('redelegate_error', stream, reason);
            await sendAlert('redelegate_error', stream, reason);
            log(`Redelegate failed stream=${stream.address.toBase58()} reason=${reason}`);
        }
    }
    idempotency.add(idempotencyKey);
    log(`Processed stream=${stream.address.toBase58()} settleWindow=${settleWindow}`);
}
// ============================================================
// Phase 2: Keeper-Relayed Claims
// ============================================================
async function processClaimRelays() {
    const batch = await (0, claims_queue_1.getPendingClaimAuths)(5);
    if (batch.length === 0)
        return;
    log(`Processing ${batch.length} claim relay authorization(s) from DB`);
    for (const auth of batch) {
        try {
            const businessOwner = new web3_js_1.PublicKey(auth.businessOwner);
            const workerPubkey = new web3_js_1.PublicKey(auth.workerPubkey);
            // 1. Cryptographic Authentication
            // The wallet signed: "claim:<streamIndex>:<nonce>:<expiry>"
            const messageStr = `claim:${auth.streamIndex}:${auth.nonce}:${auth.expiry}`;
            const message = new TextEncoder().encode(messageStr);
            try {
                const isValid = ed25519_1.ed25519.verify(new Uint8Array(auth.signature), message, workerPubkey.toBytes());
                if (!isValid) {
                    log(`Claim relay skip: invalid Ed25519 signature stream=${auth.streamIndex} nonce=${auth.nonce}`);
                    await (0, claims_queue_1.markClaimFailed)(auth.streamIndex, auth.nonce, "invalid_signature");
                    continue;
                }
            }
            catch (err) {
                log(`Claim relay skip: signature verification error stream=${auth.streamIndex} nonce=${auth.nonce}`);
                await (0, claims_queue_1.markClaimFailed)(auth.streamIndex, auth.nonce, "signature_error");
                continue;
            }
            const [businessPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('business'), businessOwner.toBuffer()], PROGRAM_ID);
            const streamConfigPda = deriveStreamConfigPda(businessPda);
            const shieldedPayoutPda = deriveShieldedPayoutPda(businessPda, auth.streamIndex, auth.nonce);
            // Read the shielded payout account to get the payout_token_account
            const payoutInfo = await getAccountInfoRead(shieldedPayoutPda);
            if (!payoutInfo) {
                log(`Claim relay skip: shielded payout not found stream=${auth.streamIndex} nonce=${auth.nonce}`);
                continue;
            }
            // ShieldedPayoutV2 layout: disc(8) + business(32) + streamIndex(8) + nonce(8) + employee_auth_hash(32) + encrypted_amount(handle:16+ct:64=80) + bump(1) + claimed(1) + cancelled(1) + expires_at(8) + payout_token_account(32)
            const payoutData = payoutInfo.data;
            const claimed = payoutData[8 + 32 + 8 + 8 + 32 + 80 + 1] !== 0;
            if (claimed) {
                log(`Claim relay skip: already claimed on-chain stream=${auth.streamIndex} nonce=${auth.nonce}`);
                await (0, claims_queue_1.markClaimCompleted)(auth.streamIndex, auth.nonce, "already_claimed");
                continue;
            }
            // Read payout_token_account from the shielded payout PDA state.
            // It's stored by the employee stream — we need the employee's token account.
            // For the destination, we use the employee_token_account from the stream.
            const streamPda = deriveEmployeeStreamPda(businessPda, auth.streamIndex);
            const streamInfo = await getAccountInfoRead(streamPda);
            if (!streamInfo) {
                log(`Claim relay skip: stream not found stream=${auth.streamIndex}`);
                continue;
            }
            // EmployeeStreamV2 layout: disc(8) + business(32) + stream_index(8) + employee_auth_hash(32) + employee_token_account(32) + ...
            const employeeTokenAccount = new web3_js_1.PublicKey(streamInfo.data.subarray(8 + 32 + 8 + 32, 8 + 32 + 8 + 32 + 32));
            // Read payout token account from vault config (it was created during process_withdraw)
            // The payout_token_account is stored in ShieldedPayoutV2 at the end of the account
            // Actually: We need to scan for the Inco token account owned by the shielded payout PDA.
            // For simplicity, derive it the same way processWithdrawRequest does.
            // The account lookup: check accounts owned by the payout PDA via getTokenAccountsByOwner isn't available for Inco.
            // We'll use the token account stored in the withdraw request or look it up from hints.
            // Simplest approach: the payout token account was created during processWithdrawRequest
            // and is stored as an associated lookup. We'll query getAccountInfo on a known lookup.
            // For now, pass the employee_token_account as destination (keeper sends to worker's Inco token account).
            // Build keeper_claim_on_behalf_v2 instruction
            const streamIndexBuf = Buffer.alloc(8);
            streamIndexBuf.writeBigUInt64LE(BigInt(auth.streamIndex));
            const nonceBuf = Buffer.alloc(8);
            nonceBuf.writeBigUInt64LE(BigInt(auth.nonce));
            const expiryBuf = Buffer.alloc(8);
            expiryBuf.writeBigInt64LE(BigInt(auth.expiry));
            // We need to find the payout_token_account.
            // It's stored in the ShieldedPayoutV2's associated Inco token account.
            // During processWithdrawRequest, the keeper created a keypair for it.
            // The shielded payout PDA is the owner. We scan for token accounts owned by the PDA.
            // Since Inco token accounts don't use ATA, we need to read it from the process_withdraw tx.
            // Workaround: store it in the shielded payout state — but it's not stored there.
            // The actual payout_token_account needs to be recovered.
            // Best approach: scan for Inco token accounts owned by shieldedPayoutPda.
            const ownedAccounts = await readConnection.getProgramAccounts(INCO_TOKEN_PROGRAM_ID, {
                filters: [
                    { memcmp: { offset: 40, bytes: shieldedPayoutPda.toBase58() } }, // owner at offset 40 (disc:8 + mint:32)
                ],
            });
            if (ownedAccounts.length === 0) {
                log(`Claim relay skip: no Inco token account found for payout PDA stream=${auth.streamIndex} nonce=${auth.nonce}`);
                continue;
            }
            const payoutTokenAccount = ownedAccounts[0].pubkey;
            const ED25519_PROGRAM_ID = new web3_js_1.PublicKey('Ed25519SigVerify111111111111111111111111111');
            const ix = new web3_js_1.TransactionInstruction({
                keys: [
                    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // keeper
                    { pubkey: businessPda, isSigner: false, isWritable: false }, // business
                    { pubkey: streamConfigPda, isSigner: false, isWritable: false }, // stream_config_v2
                    { pubkey: shieldedPayoutPda, isSigner: false, isWritable: true }, // shielded_payout
                    { pubkey: payoutTokenAccount, isSigner: false, isWritable: true }, // payout_token_account
                    { pubkey: employeeTokenAccount, isSigner: false, isWritable: true }, // destination_token_account
                    { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                    { pubkey: ED25519_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                programId: PROGRAM_ID,
                data: Buffer.concat([
                    KEEPER_CLAIM_ON_BEHALF_V2_DISC,
                    streamIndexBuf,
                    nonceBuf,
                    expiryBuf,
                ]),
            });
            const tx = new web3_js_1.Transaction().add(ix);
            tx.feePayer = payer.publicKey;
            tx.recentBlockhash = (await txConnection.getLatestBlockhash()).blockhash;
            tx.sign(payer);
            const sig = await txConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            await txConnection.confirmTransaction(sig, 'confirmed');
            await (0, claims_queue_1.markClaimCompleted)(auth.streamIndex, auth.nonce, sig);
            log(`✅ Claim relayed stream=${auth.streamIndex} nonce=${auth.nonce} worker=${auth.workerPubkey.slice(0, 8)}... tx=${sig}`);
        }
        catch (e) {
            const reason = e?.message || 'unknown';
            await (0, claims_queue_1.markClaimFailed)(auth.streamIndex, auth.nonce, reason);
            log(`Claim relay failed stream=${auth.streamIndex} nonce=${auth.nonce} reason=${reason}`);
        }
    }
}
async function processWithdrawRelays() {
    const batch = await (0, claims_queue_1.getPendingWithdrawAuths)(5);
    if (batch.length === 0)
        return;
    log(`Processing ${batch.length} withdraw relay authorization(s) from DB`);
    for (const auth of batch) {
        try {
            const businessOwner = new web3_js_1.PublicKey(auth.businessOwner);
            const workerPubkey = new web3_js_1.PublicKey(auth.workerPubkey);
            // 1. Cryptographic Authentication
            // The wallet signed: "withdraw:<streamIndex>:<timestamp>"
            const messageStr = `withdraw:${auth.streamIndex}:${auth.timestamp}`;
            const message = new TextEncoder().encode(messageStr);
            try {
                const isValid = ed25519_1.ed25519.verify(new Uint8Array(auth.signature), message, workerPubkey.toBytes());
                if (!isValid) {
                    log(`Withdraw relay skip: invalid Ed25519 signature stream=${auth.streamIndex} ts=${auth.timestamp}`);
                    await (0, claims_queue_1.markWithdrawFailed)(auth.streamIndex, auth.timestamp, "invalid_signature");
                    continue;
                }
            }
            catch (err) {
                log(`Withdraw relay skip: signature verification error stream=${auth.streamIndex} ts=${auth.timestamp}`);
                await (0, claims_queue_1.markWithdrawFailed)(auth.streamIndex, auth.timestamp, "signature_error");
                continue;
            }
            const [businessPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('business'), businessOwner.toBuffer()], PROGRAM_ID);
            const streamConfigPda = deriveStreamConfigPda(businessPda);
            const streamPda = deriveEmployeeStreamPda(businessPda, auth.streamIndex);
            // We only need to provide withdraw_request_v2 and system_program.
            const [withdrawRequestPda] = web3_js_1.PublicKey.findProgramAddressSync([
                Buffer.from('withdraw_request_v2'),
                businessPda.toBuffer(),
                new Uint8Array(new BigUint64Array([BigInt(auth.streamIndex)]).buffer),
            ], PROGRAM_ID);
            const streamIndexBuf = Buffer.alloc(8);
            streamIndexBuf.writeBigUInt64LE(BigInt(auth.streamIndex));
            const ix = new web3_js_1.TransactionInstruction({
                keys: [
                    { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // keeper
                    { pubkey: businessPda, isSigner: false, isWritable: false }, // business
                    { pubkey: streamConfigPda, isSigner: false, isWritable: false }, // stream_config_v2
                    { pubkey: streamPda, isSigner: false, isWritable: false }, // employee_stream (CHECK, can be delegated)
                    { pubkey: withdrawRequestPda, isSigner: false, isWritable: true }, // withdraw_request_v2
                    { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
                ],
                programId: PROGRAM_ID,
                data: Buffer.concat([
                    KEEPER_REQUEST_WITHDRAW_V2_DISC,
                    streamIndexBuf,
                ]),
            });
            const tx = new web3_js_1.Transaction().add(ix);
            tx.feePayer = payer.publicKey;
            tx.recentBlockhash = (await txConnection.getLatestBlockhash()).blockhash;
            tx.sign(payer);
            const sig = await txConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            await txConnection.confirmTransaction(sig, 'confirmed');
            await (0, claims_queue_1.markWithdrawCompleted)(auth.streamIndex, auth.timestamp, sig);
            log(`✅ Withdraw request relayed stream=${auth.streamIndex} ts=${auth.timestamp} worker=${auth.workerPubkey.slice(0, 8)}... tx=${sig}`);
        }
        catch (e) {
            const reason = e?.message || 'unknown';
            await (0, claims_queue_1.markWithdrawFailed)(auth.streamIndex, auth.timestamp, reason);
            log(`Withdraw relay failed stream=${auth.streamIndex} ts=${auth.timestamp} reason=${reason}`);
        }
    }
}
async function processViewRelays() {
    const batch = await (0, claims_queue_1.getPendingViewAuths)(10);
    if (batch.length === 0)
        return;
    log(`Processing ${batch.length} view logic relay authorization(s) from DB`);
    for (const auth of batch) {
        try {
            const businessOwner = new web3_js_1.PublicKey(auth.businessOwner);
            const workerPubkey = new web3_js_1.PublicKey(auth.workerPubkey);
            const messageStr = `view:${auth.streamIndex}:${auth.timestamp}`;
            const message = new TextEncoder().encode(messageStr);
            try {
                const isValid = ed25519_1.ed25519.verify(new Uint8Array(auth.signature), message, workerPubkey.toBytes());
                if (!isValid) {
                    log(`View relay skip: invalid Ed25519 signature stream=${auth.streamIndex} ts=${auth.timestamp}`);
                    await (0, claims_queue_1.markViewFailed)(auth.streamIndex, auth.timestamp, "invalid_signature");
                    continue;
                }
            }
            catch (err) {
                log(`View relay skip: signature verification error stream=${auth.streamIndex} ts=${auth.timestamp}`);
                await (0, claims_queue_1.markViewFailed)(auth.streamIndex, auth.timestamp, "signature_error");
                continue;
            }
            const [businessPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('business'), businessOwner.toBuffer()], PROGRAM_ID);
            const streamConfigPda = deriveStreamConfigPda(businessPda);
            const streamPda = deriveEmployeeStreamPda(businessPda, auth.streamIndex);
            // Load stream to get handles for allowance PDA derivation
            const streamInfo = await connection.getAccountInfo(streamPda);
            if (!streamInfo) {
                await (0, claims_queue_1.markViewFailed)(auth.streamIndex, auth.timestamp, "stream_not_found");
                continue;
            }
            const salaryHandleBytes = streamInfo.data.slice(72, 88);
            const accruedHandleBytes = streamInfo.data.slice(88, 104);
            const [salaryAllowanceAccount] = web3_js_1.PublicKey.findProgramAddressSync([salaryHandleBytes, workerPubkey.toBuffer()], INCO_LIGHTNING_ID);
            const [accruedAllowanceAccount] = web3_js_1.PublicKey.findProgramAddressSync([accruedHandleBytes, workerPubkey.toBuffer()], INCO_LIGHTNING_ID);
            const streamIndexBuf = Buffer.alloc(8);
            streamIndexBuf.writeBigUInt64LE(BigInt(auth.streamIndex));
            const ix = new web3_js_1.TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                    { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
                    { pubkey: businessPda, isSigner: false, isWritable: false },
                    { pubkey: streamConfigPda, isSigner: false, isWritable: false },
                    { pubkey: streamPda, isSigner: false, isWritable: false },
                    { pubkey: workerPubkey, isSigner: false, isWritable: false },
                    { pubkey: salaryAllowanceAccount, isSigner: false, isWritable: true },
                    { pubkey: accruedAllowanceAccount, isSigner: false, isWritable: true },
                    { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                    { pubkey: web3_js_1.SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: Buffer.concat([
                    GRANT_EMPLOYEE_VIEW_ACCESS_V2_DISC,
                    streamIndexBuf,
                ]),
            });
            const recentBlockhash = await connection.getLatestBlockhash();
            const messageObj = new web3_js_1.TransactionMessage({
                payerKey: keypair.publicKey,
                recentBlockhash: recentBlockhash.blockhash,
                instructions: [ix]
            }).compileToV0Message();
            const tx = new web3_js_1.VersionedTransaction(messageObj);
            tx.sign([keypair]);
            const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
            await connection.confirmTransaction({
                signature: sig,
                ...recentBlockhash
            });
            log(`✅ View relay completed stream=${auth.streamIndex} worker=${auth.workerPubkey.slice(0, 8)} tx=${sig}`);
            await (0, claims_queue_1.markViewCompleted)(auth.streamIndex, auth.timestamp, sig);
        }
        catch (e) {
            const reason = e?.message || 'unknown transaction error';
            log(`View relay failed stream=${auth.streamIndex} reason=${reason}`);
            await (0, claims_queue_1.markViewFailed)(auth.streamIndex, auth.timestamp, reason);
        }
    }
}
async function processTick() {
    if (tickInProgress) {
        log('Tick skipped: previous tick still in progress');
        return;
    }
    if (consecutiveFailures >= DEFAULT_MAX_CONSECUTIVE_FAILURES) {
        log(`Circuit breaker open after ${consecutiveFailures} consecutive failures`);
        return;
    }
    tickInProgress = true;
    clearPerTickCaches();
    try {
        const requests = await listPendingWithdrawRequests();
        if (requests.length === 0) {
            log('No pending withdraw requests');
            consecutiveFailures = 0;
            (0, healthcheck_1.recordTick)();
        }
        else {
            const selected = requests.slice(0, DEFAULT_MAX_STREAMS_PER_TICK);
            const results = await Promise.all(selected.map(async (request) => {
                const jitter = Math.floor(Math.random() * DEFAULT_JITTER_MS);
                await sleep(jitter);
                try {
                    await processWithdrawRequest(request);
                    return { ok: true };
                }
                catch (e) {
                    const reason = e?.message || 'withdraw request processing failed';
                    await deadLetterWithdrawRequest('withdraw_request_error', request, reason);
                    await sendAlertWithdrawRequest('withdraw_request_error', request, reason);
                    log(`Withdraw request failed request=${request.address.toBase58()} reason=${reason}`);
                    return { ok: false, reason, request: request.address.toBase58() };
                }
            }));
            const failed = results.filter((r) => !r.ok);
            if (failed.length === selected.length) {
                // Do not trip the global circuit breaker on per-request failures.
                // Keep processing in future ticks; operator can inspect dead-letter logs.
                log(`Tick all_requests_failed total=${selected.length}`);
            }
            else {
                if (failed.length > 0) {
                    log(`Tick partial_success failed_requests=${failed.length} total_requests=${selected.length}`);
                }
                consecutiveFailures = 0;
                (0, healthcheck_1.recordTick)();
            }
        }
        // Phase 2: Process any pending claim relay authorizations
        try {
            await processClaimRelays();
        }
        catch (e) {
            log(`Claim relay processing failed: ${e?.message || 'unknown'}`);
        }
        // Phase 3: Process any pending withdraw request authorizations (Ghost Mode)
        try {
            await processWithdrawRelays();
        }
        catch (e) {
            log(`Withdraw relay processing failed: ${e?.message || 'unknown'}`);
            // Phase 4: Process any pending view authorizations (Auto-regrant off-chain intent)
            try {
                await processViewRelays();
            }
            catch (e) {
                log(`View relay processing failed: ${e?.message || 'unknown'}`);
            }
        }
        try { }
        catch (e) {
            consecutiveFailures += 1;
            (0, healthcheck_1.recordFailure)();
            log(`Tick failed failures=${consecutiveFailures} reason=${e?.message || 'unknown error'}`);
        }
        finally {
            tickInProgress = false;
        }
    }
    finally {
    }
    async function hydrateDelegationStateOnStartup() {
        undelegateInFlight.clear();
        log('Startup hydration skipped (withdraw-request mode)');
    }
    async function deadLetter(kind, stream, reason) {
        const record = {
            kind,
            time: new Date().toISOString(),
            stream: stream.address.toBase58(),
            business: stream.business.toBase58(),
            streamIndex: stream.streamIndex,
            reason,
        };
        const dir = path_1.default.dirname(DEAD_LETTER_FILE);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.appendFileSync(DEAD_LETTER_FILE, `${JSON.stringify(record)}\n`);
    }
    async function deadLetterWithdrawRequest(kind, request, reason) {
        const record = {
            kind,
            time: new Date().toISOString(),
            request: request.address.toBase58(),
            business: request.business.toBase58(),
            streamIndex: request.streamIndex,
            requester: request.requester.toBase58(),
            requestedAt: request.requestedAt,
            reason,
        };
        const dir = path_1.default.dirname(DEAD_LETTER_FILE);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.appendFileSync(DEAD_LETTER_FILE, `${JSON.stringify(record)}\n`);
    }
    async function sendAlert(kind, stream, reason) {
        if (!ALERT_WEBHOOK_URL || !fetchAny)
            return;
        try {
            await fetchAny(ALERT_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    time: new Date().toISOString(),
                    stream: stream.address.toBase58(),
                    business: stream.business.toBase58(),
                    streamIndex: stream.streamIndex,
                    reason,
                }),
            });
        }
        catch (e) {
            log(`Alert webhook failed: ${e?.message || 'unknown error'}`);
        }
    }
    async function sendAlertWithdrawRequest(kind, request, reason) {
        if (!ALERT_WEBHOOK_URL || !fetchAny)
            return;
        try {
            await fetchAny(ALERT_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    time: new Date().toISOString(),
                    request: request.address.toBase58(),
                    business: request.business.toBase58(),
                    streamIndex: request.streamIndex,
                    requester: request.requester.toBase58(),
                    requestedAt: request.requestedAt,
                    reason,
                }),
            });
        }
        catch (e) {
            log(`Alert webhook failed: ${e?.message || 'unknown error'}`);
        }
    }
    function log(message) {
        const ts = new Date().toISOString();
        console.log(`[keeper ${ts}] ${message}`);
    }
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    async function main() {
        log('Keeper service starting');
        (0, healthcheck_1.startHealthServer)();
        log(`TX RPC: ${TX_RPC_URL}`);
        log(`Router RPC: ${ROUTER_RPC_URL}`);
        log(`READ RPC: ${READ_RPC_URL}`);
        log(`Program: ${PROGRAM_ID.toBase58()}`);
        log(`Keeper payer: ${payer.publicKey.toBase58()}`);
        log(`Magic program: ${MAGIC_PROGRAM_ID.toBase58()}`);
        log(`Delegation program: ${DELEGATION_PROGRAM_ID.toBase58()}`);
        log(`Magic context: ${MAGIC_CONTEXT_ID.toBase58()}`);
        log(`Tick interval: ${DEFAULT_TICK_SECS}s`);
        log(`Compliance checks: ${COMPLIANCE_ENABLED ? 'enabled' : 'disabled'}`);
        log(`Redelegate after withdraw: ${REDELEGATE_AFTER_WITHDRAW ? 'enabled' : 'disabled'}`);
        magicCommitSupported = await detectMagicCommitSupport();
        log(`Magic commit support on read RPC: ${magicCommitSupported ? 'available' : 'unavailable'}`);
        try {
            await hydrateDelegationStateOnStartup();
        }
        catch (e) {
            log(`Startup hydration failed reason=${e?.message || 'unknown error'}`);
        }
        try {
            await (0, claims_queue_1.connectQueue)();
        }
        catch (e) {
            log(`Failed to connect to MongoDB queue: ${e?.message}`);
        }
        await processTick();
        setInterval(() => {
            void processTick();
        }, DEFAULT_TICK_SECS * 1000);
    }
    void main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
