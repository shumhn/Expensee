import path from 'path';
import dotenv from 'dotenv';

// Load env from current dir or backend/keeper/.env if running from root
dotenv.config(); 
dotenv.config({ path: path.resolve(process.cwd(), 'backend/keeper/.env') });
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk';
import { createHash } from 'crypto';
import { startHealthServer, recordTick, recordFailure, ClaimAuthRecord } from './healthcheck';
import {
  connectQueue,
  getPendingClaimAuths,
  markClaimCompleted,
  markClaimFailed,
  getPendingWithdrawAuths,
  markWithdrawCompleted,
  markWithdrawFailed,
  getPendingViewAuths,
  markViewCompleted,
  markViewFailed,
  getViewAccessTargets,
  getWorkerPubkeyForStream
} from './claims-queue';
import fs from 'fs';


import { ed25519 } from '@noble/curves/ed25519';

const fetchAny: any = (globalThis as any).fetch;

const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const BUSINESS_SEED = Buffer.from('business');
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');
const VAULT_SEED = Buffer.from('vault');
const BUFFER_SEED = Buffer.from('buffer');
const DELEGATION_SEED = Buffer.from('delegation');
const DELEGATION_METADATA_SEED = Buffer.from('delegation-metadata');
const SHIELDED_PAYOUT_V2_SEED = Buffer.from('shielded_payout');
const ED25519_PROGRAM_ID = new PublicKey('Ed25519SigVerify111111111111111111111111111');

const INCO_LIGHTNING_ID = new PublicKey(
  process.env.KEEPER_INCO_LIGHTNING_ID ||
  process.env.NEXT_PUBLIC_INCO_PROGRAM_ID ||
  '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
);

const INCO_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.KEEPER_INCO_TOKEN_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID ||
  '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N'
);

const PAYUSD_MINT = new PublicKey(
  process.env.KEEPER_PAYUSD_MINT ||
  process.env.NEXT_PUBLIC_PAYUSD_MINT ||
  'GhCZ59UK4Afg4WGpQ11HyRc8ya4swgWFXMh2BxuWQXHt'
);

// Inco Confidential Token: initialize_account discriminator
const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);
const KEEPER_CLAIM_ON_BEHALF_V2_DISC = Buffer.from([161, 194, 33, 127, 138, 221, 153, 84]);
const KEEPER_REQUEST_WITHDRAW_V2_DISC = Buffer.from([241, 181, 94, 57, 32, 108, 61, 165]);
const GRANT_EMPLOYEE_VIEW_ACCESS_V2_DISC = Buffer.from([201, 191, 208, 133, 117, 221, 125, 147]);
const REVOKE_VIEW_ACCESS_V2_DISC = Buffer.from([79, 190, 166, 170, 246, 184, 119, 163]);
const UPDATE_KEEPER_V2_DISC = Buffer.from([52, 172, 105, 244, 89, 165, 39, 71]);

const MAGIC_PROGRAM_ID = new PublicKey(
  process.env.KEEPER_MAGIC_CORE_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM ||
  'Magic11111111111111111111111111111111111111'
);

const DELEGATION_PROGRAM_ID = new PublicKey(
  process.env.KEEPER_DELEGATION_PROGRAM_ID ||
  process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM ||
  process.env.KEEPER_MAGIC_PROGRAM_ID ||
  'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
);

const MAGIC_CONTEXT_ID = new PublicKey(
  process.env.KEEPER_MAGIC_CONTEXT ||
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT ||
  'MagicContext1111111111111111111111111111111'
);

const DEFAULT_VALIDATOR = new PublicKey(
  process.env.KEEPER_VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'
);

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
// Privacy-first default: do not auto-claim buffered payouts to a fixed destination unless explicitly enabled.
const AUTO_CLAIM_ON_BUFFER = process.env.KEEPER_AUTO_CLAIM_ON_BUFFER === 'true';
// Privacy-first default: disable blind auto-claim sweep unless explicitly enabled.
const AUTO_CLAIM_SWEEP_ENABLED = process.env.KEEPER_AUTO_CLAIM_SWEEP === 'true';
// Privacy-first default: disable worker view-relay grants unless explicitly enabled.
const ENABLE_VIEW_RELAY = process.env.KEEPER_ENABLE_VIEW_RELAY === 'true';
type PrivacyPayoutRouteMode = 'off' | 'shadow' | 'enforced';
const PRIVACY_PAYOUT_ROUTE_MODE = parsePrivacyPayoutRouteMode(
  process.env.KEEPER_PRIVACY_PAYOUT_ROUTE_MODE || 'off'
);
const UMBRA_RELAY_URL = (process.env.KEEPER_UMBRA_RELAY_URL || '').trim();
const UMBRA_POOL_ID = (process.env.KEEPER_UMBRA_POOL_ID || '').trim();
const UMBRA_RELAYER_KEY_ID = (process.env.KEEPER_UMBRA_RELAYER_KEY_ID || '').trim();
const UMBRA_RELAY_API_KEY = (process.env.KEEPER_UMBRA_RELAY_API_KEY || '').trim();
const UMBRA_ROUTE_TIMEOUT_MS = Number(process.env.KEEPER_UMBRA_ROUTE_TIMEOUT_MS || '7000');
const UMBRA_ROUTE_RETRIES = Number(process.env.KEEPER_UMBRA_ROUTE_RETRIES || '3');
const UMBRA_FORWARD_SIGNED_CLAIM = process.env.KEEPER_UMBRA_FORWARD_SIGNED_CLAIM === 'true';
const UMBRA_FORWARD_URL = resolveUmbraForwardUrl(UMBRA_RELAY_URL, process.env.KEEPER_UMBRA_FORWARD_URL || '');
const UMBRA_ROUTE_ENABLED = PRIVACY_PAYOUT_ROUTE_MODE !== 'off';
const UMBRA_ROUTE_CONFIGURED = UMBRA_RELAY_URL.length > 0 && UMBRA_POOL_ID.length > 0;
// If a stream is delegated, attempt to run accrue_v2 on the ER endpoint before commit+undelegate.
// This makes MagicBlock the compute engine for the accrual checkpoint.
const ACCRUE_ON_ER_BEFORE_COMMIT = process.env.KEEPER_ACCRUE_ON_ER_BEFORE_COMMIT !== 'false';

const EMPLOYEE_STREAM_V2_ACCOUNT_LEN = 243;
const WITHDRAW_REQUEST_V2_ACCOUNT_LEN = 122;
const BUSINESS_ACCOUNT_LEN = 154;
const VAULT_ACCOUNT_LEN = 169;
const STREAM_CONFIG_V2_ACCOUNT_LEN = 123;

const PAUSE_REASON_COMPLIANCE = 2;

const PROGRAM_ID = new PublicKey(requiredEnv('KEEPER_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID));
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
const READ_RPC_PRIMARY_URL =
  process.env.KEEPER_READ_RPC_URL ||
  process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
  'https://api.devnet.solana.com';
const READ_RPC_FALLBACK_URL =
  process.env.KEEPER_READ_RPC_FALLBACK_URL || 'https://api.devnet.solana.com';
// Optional: comma-separated list to fully control failover order.
// Example:
// KEEPER_READ_RPC_URLS="https://devnet.helius-rpc.com/?api-key=XXX,https://api.devnet.solana.com"
const READ_RPC_URLS = (process.env.KEEPER_READ_RPC_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ENFORCE_MAGIC_CONTEXT_CHECK = process.env.KEEPER_ENFORCE_MAGIC_CONTEXT_CHECK === 'true';

function resolveKeeperFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  const cwdNormalized = process.cwd().replace(/\\/g, '/');
  let candidate = normalized;

  // Avoid resolving to ".../backend/keeper/backend/keeper/*" when running from backend/keeper.
  if (normalized.startsWith('backend/keeper/') && cwdNormalized.endsWith('/backend/keeper')) {
    candidate = normalized.slice('backend/keeper/'.length);
  }

  return path.resolve(candidate);
}

const DEAD_LETTER_FILE =
  process.env.KEEPER_DEAD_LETTER_FILE
    ? resolveKeeperFilePath(process.env.KEEPER_DEAD_LETTER_FILE)
    : path.resolve(process.cwd(), 'dead-letter.log');
const ALERT_WEBHOOK_URL = process.env.KEEPER_ALERT_WEBHOOK_URL || '';
const RANGE_API_KEY = process.env.KEEPER_RANGE_API_KEY || process.env.RANGE_API_KEY || process.env.NEXT_PUBLIC_RANGE_API_KEY || '';
const TEE_AUTH_TOKEN =
  (process.env.KEEPER_TEE_AUTH_TOKEN || process.env.MAGICBLOCK_TEE_TOKEN || '').trim();

function isMagicBlockRpcUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return (
      host === 'devnet-router.magicblock.app' ||
      host === 'devnet-eu.magicblock.app' ||
      host === 'devnet-us.magicblock.app' ||
      host === 'devnet-as.magicblock.app' ||
      host === 'tee.magicblock.app'
    );
  } catch {
    return false;
  }
}

function createRpcConnection(url: string): Connection {
  const normalized = normalizeRpcUrl(url);
  if (isMagicBlockRpcUrl(normalized)) {
    return new ConnectionMagicRouter(normalized, 'confirmed');
  }
  return new Connection(normalized, 'confirmed');
}

const txConnection = createRpcConnection(TX_RPC_URL);
const readUrlsRaw =
  READ_RPC_URLS.length > 0 ? READ_RPC_URLS : [READ_RPC_PRIMARY_URL, READ_RPC_FALLBACK_URL];
const readUrls: string[] = [];
for (const url of readUrlsRaw) {
  const normalized = normalizeRpcUrl(url);
  if (normalized.length === 0) continue;
  if (readUrls.some((u) => normalizeRpcUrl(u) === normalized)) continue;
  readUrls.push(url);
}
const readConnections = readUrls.map((url) => createRpcConnection(url));
if (readConnections.length === 0) {
  // Should never happen because defaults include api.devnet.solana.com
  throw new Error('No READ RPC URLs configured');
}
// Back-compat aliases used throughout the keeper for logs and base-layer txs.
// Primary = first URL in the failover list.
const READ_RPC_URL = readUrls[0];
const readConnection = readConnections[0];
const txConnectionCache = new Map<string, Connection>();
txConnectionCache.set(normalizeRpcUrl(TX_RPC_URL), txConnection);
const payer = loadPayer();
const payerSigner: Signer = payer;

// @inco/solana-sdk is now a direct dependency of the keeper (see package.json).
// Note: encryptValue and attested-decrypt removed — blind keeper does not
// decrypt or re-encrypt. Kept for reference only if rollback is needed.

type EmployeeStreamV2Record = {
  address: PublicKey;
  owner: PublicKey;
  business: PublicKey;
  streamIndex: number;
  destinationRouteCommitment: Buffer;
  hasFixedDestination: boolean;
  employeeTokenAccount: PublicKey;
  lastSettleTime: number;
  salaryHandle: bigint;
  accruedHandle: bigint;
  isActive: boolean;
  isDelegated: boolean;
  periodStart: number;
  periodEnd: number;
};

type BusinessRecord = {
  owner: PublicKey;
  vault: PublicKey;
};

type VaultRecord = {
  tokenAccount: PublicKey;
};

type StreamConfigRecord = {
  keeper: PublicKey;
  settleIntervalSecs: number;
  isPaused: boolean;
  pauseReason: number;
};

type ComplianceCacheRecord = {
  checkedAt: number;
  isCompliant: boolean;
};

type DelegationStatusResponse = {
  delegated?: boolean;
  isDelegated?: boolean;
  fqdn?: string;
  endpoint?: string;
  delegation?: {
    fqdn?: string;
    endpoint?: string;
    delegated?: boolean | number;
  };
};

type WithdrawRequestV2Record = {
  address: PublicKey;
  business: PublicKey;
  streamIndex: number;
  requesterAuthHash: Buffer;
  requestedAt: number;
  isPending: boolean;
};

type UmbraRouteDecision = {
  handled: boolean;
  reason: string;
};

type UmbraRouteInput = {
  request: WithdrawRequestV2Record;
  stream: EmployeeStreamV2Record;
  payoutNonce: number;
  shieldedPayout: PublicKey;
  payoutTokenAccount: PublicKey;
  routeOwnerPubkey?: string | null;
};

type UmbraRouteRelayResult = {
  ok: boolean;
  reason: string;
  statusCode?: number;
  jobId?: string;
  relayStatus?: string;
  destinationTokenAccount?: string;
  deferClaim?: boolean;
};

type UmbraForwardResult = {
  ok: boolean;
  reason: string;
  statusCode?: number;
  relayTxSignature?: string;
  relayerPublicKey?: string;
  jobId?: string;
};

const idempotency = new Set<string>();
const withdrawDecryptRetryAfter = new Map<string, number>();
const complianceCache = new Map<string, ComplianceCacheRecord>();
const delegatedUnsupportedLogged = new Set<string>();
const teeTokenMissingLogged = new Set<string>();
const undelegateInFlight = new Map<string, number>();
const autoResumeCooldownByBusiness = new Map<string, number>();

const businessCache = new Map<string, BusinessRecord>();
const vaultCache = new Map<string, VaultRecord>();
const streamConfigCache = new Map<string, StreamConfigRecord>();
const delegatedRouteCache = new Map<string, { endpoint: string; cachedAtMs: number }>();

let tickInProgress = false;
let consecutiveFailures = 0;
let magicCommitSupported = false;

function requiredEnv(name: string, fallback?: string): string {
  const value = fallback || process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function parsePrivacyPayoutRouteMode(input: string): PrivacyPayoutRouteMode {
  const normalized = String(input || '')
    .trim()
    .toLowerCase();
  if (normalized === 'shadow') return 'shadow';
  if (normalized === 'enforced') return 'enforced';
  return 'off';
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid_url';
  }
}

function resolveUmbraForwardUrl(routeUrl: string, explicitForwardUrl: string): string {
  const explicit = (explicitForwardUrl || '').trim();
  if (explicit.length > 0) return explicit;
  const route = (routeUrl || '').trim();
  if (!route) return '';
  if (route.endsWith('/route')) return `${route.slice(0, -'/route'.length)}/forward-claim`;
  return `${route.replace(/\/+$/, '')}/forward-claim`;
}

function isRetryableReadRpcError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('enotfound')
  );
}

async function getAccountInfoRead(pubkey: PublicKey, commitment: any = 'confirmed') {
  let primaryErr: any = null;
  for (let i = 0; i < readConnections.length; i++) {
    const conn = readConnections[i];
    const endpoint = rpcEndpoint(conn);
    try {
      return await conn.getAccountInfo(pubkey, commitment);
    } catch (e: any) {
      if (i === 0) primaryErr = e;
      // If it's not retryable, fail fast (caller likely passed bad args).
      if (!isRetryableReadRpcError(e)) throw e;
      // Otherwise try the next configured READ RPC.
      log(`READ RPC failed endpoint=${endpoint} op=getAccountInfo reason=${e?.message || 'unknown'}`);
    }
  }
  const urls = readUrls.map(normalizeRpcUrl).join(', ');
  throw new Error(
    `READ RPC failover exhausted op=getAccountInfo urls=[${urls}] reason=${primaryErr?.message || 'unknown'}`
  );
}

async function getProgramAccountsRead(programId: PublicKey, config: any) {
  let primaryErr: any = null;
  for (let i = 0; i < readConnections.length; i++) {
    const conn = readConnections[i];
    const endpoint = rpcEndpoint(conn);
    try {
      return await conn.getProgramAccounts(programId, config);
    } catch (e: any) {
      if (i === 0) primaryErr = e;
      if (!isRetryableReadRpcError(e)) throw e;
      log(`READ RPC failed endpoint=${endpoint} op=getProgramAccounts reason=${e?.message || 'unknown'}`);
    }
  }
  const urls = readUrls.map(normalizeRpcUrl).join(', ');
  throw new Error(
    `READ RPC failover exhausted op=getProgramAccounts urls=[${urls}] reason=${primaryErr?.message || 'unknown'}`
  );
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

async function detectMagicCommitSupport(): Promise<boolean> {
  try {
    const [magicProgram, magicContext] = await Promise.all([
      getAccountInfoRead(MAGIC_PROGRAM_ID, 'confirmed'),
      getAccountInfoRead(MAGIC_CONTEXT_ID, 'confirmed'),
    ]);

    if (!magicProgram || !magicProgram.executable) return false;
    if (!magicContext) return false;
    return true;
  } catch {
    return false;
  }
}

function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function hashWorkerPubkey(workerPubkey: PublicKey): Buffer {
  return createHash('sha256').update(workerPubkey.toBuffer()).digest();
}

function authHashMatchesWorker(requesterAuthHash: Uint8Array, workerPubkey: PublicKey): boolean {
  const expected = hashWorkerPubkey(workerPubkey);
  return Buffer.from(requesterAuthHash).equals(expected);
}

function authHashHex(requesterAuthHash: Uint8Array): string {
  return Buffer.from(requesterAuthHash).toString('hex');
}

function deriveStreamConfigPda(business: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([STREAM_CONFIG_V2_SEED, business.toBuffer()], PROGRAM_ID)[0];
}

function deriveEmployeeStreamPda(business: PublicKey, streamIndex: number): PublicKey {
  const index = Buffer.alloc(8);
  index.writeBigUInt64LE(BigInt(streamIndex));
  return PublicKey.findProgramAddressSync([EMPLOYEE_V2_SEED, business.toBuffer(), index], PROGRAM_ID)[0];
}

function deriveVaultPda(business: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, business.toBuffer()], PROGRAM_ID)[0];
}

function deriveShieldedPayoutPda(business: PublicKey, streamIndex: number, nonce: number): PublicKey {
  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SHIELDED_PAYOUT_V2_SEED, business.toBuffer(), streamIndexBuf, nonceBuf],
    PROGRAM_ID,
  )[0];
}

function deriveMagicContext(_employeeStreamPda: PublicKey): PublicKey {
  return MAGIC_CONTEXT_ID;
}

function deriveBufferPda(employeeStreamPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([BUFFER_SEED, employeeStreamPda.toBuffer()], PROGRAM_ID)[0];
}

function deriveDelegationRecordPda(employeeStreamPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DELEGATION_SEED, employeeStreamPda.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}

function deriveDelegationMetadataPda(employeeStreamPda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DELEGATION_METADATA_SEED, employeeStreamPda.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}

function readU128LE(buffer: Buffer, offset: number): bigint {
  let out = 0n;
  for (let i = 0; i < 16; i += 1) {
    out |= BigInt(buffer[offset + i] || 0) << (BigInt(i) * 8n);
  }
  return out;
}

function isAllZero32(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  for (let i = 0; i < 32; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function parseEmployeeStreamV2(address: PublicKey, owner: PublicKey, data: Buffer): EmployeeStreamV2Record | null {
  if (data.length < EMPLOYEE_STREAM_V2_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(accountDiscriminator('EmployeeStreamV2'))) return null;
  const destinationRouteCommitment = Buffer.from(data.subarray(80, 112));
  const hasFixedDestination = !isAllZero32(destinationRouteCommitment);

  return {
    address,
    owner,
    business: new PublicKey(data.subarray(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    destinationRouteCommitment,
    hasFixedDestination,
    // Legacy route compatibility: when a fixed route exists, interpret bytes as pubkey.
    employeeTokenAccount: hasFixedDestination
      ? new PublicKey(destinationRouteCommitment)
      : PublicKey.default,
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

function parseBusiness(data: Buffer): BusinessRecord | null {
  if (data.length < BUSINESS_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(accountDiscriminator('Business'))) return null;

  return {
    owner: new PublicKey(data.subarray(8, 40)),
    vault: new PublicKey(data.subarray(40, 72)),
  };
}

function parseVault(data: Buffer): VaultRecord | null {
  if (data.length < VAULT_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(accountDiscriminator('BusinessVault'))) return null;

  return {
    tokenAccount: new PublicKey(data.subarray(72, 104)),
  };
}

function parseStreamConfig(data: Buffer): StreamConfigRecord | null {
  if (data.length < STREAM_CONFIG_V2_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(accountDiscriminator('BusinessStreamConfigV2'))) return null;

  return {
    keeper: new PublicKey(data.subarray(40, 72)),
    settleIntervalSecs: Number(data.readBigUInt64LE(72)),
    isPaused: data[88] === 1,
    pauseReason: data[89],
  };
}

function parseWithdrawRequestV2(address: PublicKey, data: Buffer): WithdrawRequestV2Record | null {
  if (data.length < WITHDRAW_REQUEST_V2_ACCOUNT_LEN) return null;
  if (!data.subarray(0, 8).equals(accountDiscriminator('WithdrawRequestV2'))) return null;

  return {
    address,
    business: new PublicKey(data.subarray(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    requesterAuthHash: Buffer.from(data.subarray(48, 80)),
    requestedAt: Number(data.readBigInt64LE(80)),
    isPending: data[88] === 1,
  };
}

async function getBusiness(businessPda: PublicKey): Promise<BusinessRecord | null> {
  const key = businessPda.toBase58();
  if (businessCache.has(key)) return businessCache.get(key)!;

  let account;
  try {
    account = await getAccountInfoRead(businessPda, 'confirmed');
  } catch (e: any) {
    throw new Error(
      `read_rpc_getAccountInfo_business_failed url=${normalizeRpcUrl(READ_RPC_URL)} business=${businessPda.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }
  if (!account) return null;

  const parsed = parseBusiness(Buffer.from(account.data));
  if (!parsed) return null;
  businessCache.set(key, parsed);
  return parsed;
}

async function getVault(vaultPda: PublicKey): Promise<VaultRecord | null> {
  const key = vaultPda.toBase58();
  if (vaultCache.has(key)) return vaultCache.get(key)!;

  let account;
  try {
    account = await getAccountInfoRead(vaultPda, 'confirmed');
  } catch (e: any) {
    throw new Error(
      `read_rpc_getAccountInfo_vault_failed url=${normalizeRpcUrl(READ_RPC_URL)} vault=${vaultPda.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }
  if (!account) return null;

  const parsed = parseVault(Buffer.from(account.data));
  if (!parsed) return null;
  vaultCache.set(key, parsed);
  return parsed;
}

async function getStreamConfig(businessPda: PublicKey): Promise<StreamConfigRecord | null> {
  const key = businessPda.toBase58();
  if (streamConfigCache.has(key)) return streamConfigCache.get(key)!;

  const pda = deriveStreamConfigPda(businessPda);
  let account;
  try {
    account = await getAccountInfoRead(pda, 'confirmed');
  } catch (e: any) {
    throw new Error(
      `read_rpc_getAccountInfo_stream_config_failed url=${normalizeRpcUrl(READ_RPC_URL)} stream_config=${pda.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }
  if (!account) return null;

  const parsed = parseStreamConfig(Buffer.from(account.data));
  if (!parsed) return null;
  streamConfigCache.set(key, parsed);
  return parsed;
}

function clearPerTickCaches(): void {
  businessCache.clear();
  vaultCache.clear();
  streamConfigCache.clear();
}

async function listPendingWithdrawRequests(): Promise<WithdrawRequestV2Record[]> {
  let requestAccounts;
  try {
    requestAccounts = await getProgramAccountsRead(PROGRAM_ID, {
      filters: [{ dataSize: WITHDRAW_REQUEST_V2_ACCOUNT_LEN }],
      commitment: 'confirmed',
    });
  } catch (e: any) {
    throw new Error(
      `read_rpc_getProgramAccounts_withdraw_requests_failed url=${normalizeRpcUrl(READ_RPC_URL)} program=${PROGRAM_ID.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }

  const pending: WithdrawRequestV2Record[] = [];
  for (const account of requestAccounts) {
    const parsed = parseWithdrawRequestV2(account.pubkey, Buffer.from(account.account.data));
    if (parsed && parsed.isPending) pending.push(parsed);
  }

  pending.sort((a, b) => a.requestedAt - b.requestedAt);
  return pending;
}

async function listActiveStreams(): Promise<EmployeeStreamV2Record[]> {
  const byAddress = new Map<string, EmployeeStreamV2Record>();

  let programOwned;
  try {
    programOwned = await getProgramAccountsRead(PROGRAM_ID, {
      filters: [{ dataSize: EMPLOYEE_STREAM_V2_ACCOUNT_LEN }],
      commitment: 'confirmed',
    });
  } catch (e: any) {
    throw new Error(
      `read_rpc_getProgramAccounts_failed url=${normalizeRpcUrl(READ_RPC_URL)} program=${PROGRAM_ID.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }
  for (const account of programOwned) {
    const parsed = parseEmployeeStreamV2(account.pubkey, PROGRAM_ID, Buffer.from(account.account.data));
    if (parsed && parsed.isActive) {
      byAddress.set(parsed.address.toBase58(), parsed);
    }
  }

  return Array.from(byAddress.values());
}

async function listAllStreams(): Promise<EmployeeStreamV2Record[]> {
  const byAddress = new Map<string, EmployeeStreamV2Record>();

  let programOwned;
  try {
    programOwned = await getProgramAccountsRead(PROGRAM_ID, {
      filters: [{ dataSize: EMPLOYEE_STREAM_V2_ACCOUNT_LEN }],
      commitment: 'confirmed',
    });
  } catch (e: any) {
    throw new Error(
      `read_rpc_getProgramAccounts_failed url=${normalizeRpcUrl(READ_RPC_URL)} program=${PROGRAM_ID.toBase58()} reason=${e?.message || 'unknown'}`
    );
  }
  for (const account of programOwned) {
    const parsed = parseEmployeeStreamV2(account.pubkey, PROGRAM_ID, Buffer.from(account.account.data));
    if (parsed) {
      byAddress.set(parsed.address.toBase58(), parsed);
    }
  }

  return Array.from(byAddress.values());
}

function buildStreamIndexArg(streamIndex: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(streamIndex));
  return b;
}

async function sendInstruction(
  label: string,
  instruction: TransactionInstruction,
  connection: Connection = txConnection,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const isRouterSend = connection instanceof ConnectionMagicRouter;
  const candidateConnections: Connection[] = [];
  if (isRouterSend) {
    const initialEndpoint = rpcEndpoint(connection);
    const endpoints = [initialEndpoint, ...ROUTER_RPC_URLS]
      .map((url) => normalizeRpcUrl(url))
      .filter((url) => url && url !== 'unknown');
    for (const endpoint of endpoints) {
      if (candidateConnections.some((c) => rpcEndpoint(c) === endpoint)) continue;
      candidateConnections.push(connectionForRpc(endpoint));
    }
    if (candidateConnections.length === 0) {
      candidateConnections.push(connection);
    }
  } else {
    candidateConnections.push(connection);
  }

  let lastError: Error | null = null;
  const attemptedEndpoints: string[] = [];

  for (let i = 0; i < candidateConnections.length; i += 1) {
    const conn = candidateConnections[i]!;
    const endpoint = rpcEndpoint(conn);
    attemptedEndpoints.push(endpoint);
    const tx = new Transaction().add(instruction);
    tx.feePayer = payer.publicKey;

    try {
      if (conn instanceof ConnectionMagicRouter) {
        const signature = await conn.sendAndConfirmTransaction(
          tx,
          [payerSigner, ...extraSigners],
          {
            commitment: 'confirmed',
            preflightCommitment: 'processed',
          },
        );
        log(`${label} tx=${signature} rpc=${endpoint} via=magic_router`);
        return signature;
      }

      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
      tx.recentBlockhash = blockhash;
      tx.sign(payerSigner, ...extraSigners);

      const signature = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'processed',
      });
      await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      log(`${label} tx=${signature} rpc=${endpoint}`);
      return signature;
    } catch (e: any) {
      let programLogs = '';
      if (e instanceof SendTransactionError && typeof e.getLogs === 'function') {
        try {
          const logs = await e.getLogs(conn);
          if (logs && logs.length > 0) {
            programLogs = logs.slice(-20).join(' | ');
          }
        } catch {
          // Keep original error if log extraction fails.
        }
      }
      const logsSuffix = programLogs.length > 0 ? ` | program_logs=${programLogs}` : '';
      const err = new Error(
        `${label} failed rpc=${endpoint} reason=${e?.message || 'unknown'}${logsSuffix}`,
      );
      lastError = err;
      const isLast = i === candidateConnections.length - 1;
      if (!isLast) {
        log(`${label} send failed on rpc=${endpoint}; attempting failover`);
        continue;
      }
    }
  }

  if (lastError) {
    throw new Error(`${lastError.message} | attempted_rpcs=${attemptedEndpoints.join(',')}`);
  }
  throw new Error(`${label} failed with unknown send error`);
}

function accrueIx(business: PublicKey, streamIndex: number): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);
  const employee = deriveEmployeeStreamPda(business, streamIndex);

  return new TransactionInstruction({
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

function autoSettleIx(
  business: PublicKey,
  streamIndex: number,
  vaultTokenAccount: PublicKey,
  employeeTokenAccount: PublicKey,
): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);
  const vault = deriveVaultPda(business);
  const employee = deriveEmployeeStreamPda(business, streamIndex);
  const magicContext = deriveMagicContext(employee);

  return new TransactionInstruction({
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
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      instructionDiscriminator('auto_settle_stream_v2'),
      buildStreamIndexArg(streamIndex),
    ]),
  });
}

function processWithdrawRequestIx(
  request: WithdrawRequestV2Record,
  nonce: number,
  vaultTokenAccount: PublicKey,
  payoutTokenAccount: PublicKey,
): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(request.business);
  const vault = deriveVaultPda(request.business);
  const employee = deriveEmployeeStreamPda(request.business, request.streamIndex);
  const shieldedPayout = deriveShieldedPayoutPda(request.business, request.streamIndex, nonce);

  // Phase 2b: 2-hop — vault → payout_token_account.
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  return new TransactionInstruction({
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
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      instructionDiscriminator('process_withdraw_request_v2'),
      buildStreamIndexArg(request.streamIndex),
      nonceBuf,
    ]),
  });
}

function keeperClaimOnBehalfIx(
  business: PublicKey,
  streamIndex: number,
  payoutNonce: number,
  shieldedPayout: PublicKey,
  payoutTokenAccount: PublicKey,
  destinationTokenAccount: PublicKey,
  expiry: number = 0,
): TransactionInstruction {
  const streamConfigPda = deriveStreamConfigPda(business);
  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(payoutNonce));
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(BigInt(expiry));

  return new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // keeper
      { pubkey: business, isSigner: false, isWritable: false }, // business
      { pubkey: streamConfigPda, isSigner: false, isWritable: false }, // stream_config_v2
      { pubkey: shieldedPayout, isSigner: false, isWritable: true }, // shielded_payout
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true }, // payout_token_account
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true }, // destination_token_account
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: ED25519_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([
      KEEPER_CLAIM_ON_BEHALF_V2_DISC,
      streamIndexBuf,
      nonceBuf,
      expiryBuf,
    ]),
  });
}

async function sendKeeperClaimOnBehalf(
  business: PublicKey,
  streamIndex: number,
  payoutNonce: number,
  shieldedPayout: PublicKey,
  payoutTokenAccount: PublicKey,
  destinationTokenAccount: PublicKey,
  expiry: number = 0,
): Promise<string> {
  const ix = keeperClaimOnBehalfIx(
    business,
    streamIndex,
    payoutNonce,
    shieldedPayout,
    payoutTokenAccount,
    destinationTokenAccount,
    expiry,
  );
  const txBase64 = await buildSignedKeeperClaimOnBehalfTxBase64(ix);
  const sig = await readConnection.sendRawTransaction(Buffer.from(txBase64, 'base64'), { skipPreflight: false });
  await readConnection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function buildSignedKeeperClaimOnBehalfTxBase64(ix: TransactionInstruction): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await readConnection.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  return tx.serialize().toString('base64');
}

/**
 * Read the mint from an on-chain Inco token account.
 * Inco token account layout: discriminator(8) + mint(32) + owner(32) + ...
 * Returns null if the account can't be read or parsed.
 */
async function readTokenAccountMint(tokenAccount: PublicKey): Promise<PublicKey | null> {
  try {
    const info = await getAccountInfoRead(tokenAccount, 'confirmed');
    if (info && info.data.length >= 40) {
      const data = Buffer.from(info.data);
      return new PublicKey(data.subarray(8, 40));
    }
  } catch (e: any) {
    log(`[PREFLIGHT] readTokenAccountMint failed for ${tokenAccount.toBase58()}: ${e?.message || 'unknown'}`);
  }
  return null;
}

type PreflightResult = { ok: true } | { ok: false; reason: string; remediation: string };

/**
 * Run preflight checks before processing a withdraw request.
 * Validates that the vault's on-chain state is consistent with the platform's canonical mint.
 * Returns { ok: true } if all checks pass, or { ok: false, reason, remediation } on failure.
 */
async function runWithdrawPreflight(
  vault: VaultRecord,
  request: WithdrawRequestV2Record,
): Promise<PreflightResult> {
  // Check 1: Vault token account exists on-chain
  const vaultTokenInfo = await getAccountInfoRead(vault.tokenAccount, 'confirmed').catch(() => null);
  if (!vaultTokenInfo) {
    return {
      ok: false,
      reason: `[PREFLIGHT] Vault token account ${vault.tokenAccount.toBase58()} not found on-chain.`,
      remediation:
        'Re-create the vault token account in the Employer Portal (Advanced Controls > Step 2: Create Vault Token Account).',
    };
  }

  // Check 2: Vault mint matches platform canonical PAYUSD_MINT
  const vaultMint = await readTokenAccountMint(vault.tokenAccount);
  if (!vaultMint) {
    return {
      ok: false,
      reason: `[PREFLIGHT] Could not read mint from vault token account ${vault.tokenAccount.toBase58()}.`,
      remediation:
        'The vault token account may be corrupted. Re-create it in the Employer Portal.',
    };
  }

  if (!vaultMint.equals(PAYUSD_MINT)) {
    return {
      ok: false,
      reason:
        `[PREFLIGHT] CRITICAL Mint mismatch! Vault uses ${vaultMint.toBase58()} but platform requires ${PAYUSD_MINT.toBase58()}.`,
      remediation:
        'Open the Employer Portal > Advanced Controls and click "Fix Vault Mint" to rotate the vault to the correct mint. This requires the employer wallet signature.',
    };
  }

  return { ok: true };
}

/**
 * Create an Inco token account for the shielded payout PDA.
 * Returns the Keypair (address) and the TransactionInstruction.
 * Uses the provided mint so it always matches the vault's token account.
 */
function createPayoutTokenAccountIx(
  payerPubkey: PublicKey,
  owner: PublicKey,
  mint: PublicKey = PAYUSD_MINT,
): { keypair: Keypair; instruction: TransactionInstruction } {
  const keypair = Keypair.generate();
  const instruction = new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: payerPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
  });
  return { keypair, instruction };
}

function commitUndelegateIx(business: PublicKey, streamIndex: number): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);
  const employee = deriveEmployeeStreamPda(business, streamIndex);
  const magicContext = deriveMagicContext(employee);

  return new TransactionInstruction({
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

function redelegateIx(business: PublicKey, streamIndex: number): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);
  const employee = deriveEmployeeStreamPda(business, streamIndex);
  const bufferEmployee = deriveBufferPda(employee);
  const delegationRecordEmployee = deriveDelegationRecordPda(employee);
  const delegationMetadataEmployee = deriveDelegationMetadataPda(employee);

  return new TransactionInstruction({
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
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // owner_program
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false }, // delegation_program
    ],
    data: Buffer.concat([
      instructionDiscriminator('redelegate_stream_v2'),
      buildStreamIndexArg(streamIndex),
    ]),
  });
}

function pauseComplianceIx(business: PublicKey): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);

  return new TransactionInstruction({
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

function resumeStreamIx(business: PublicKey): TransactionInstruction {
  const streamConfig = deriveStreamConfigPda(business);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: business, isSigner: false, isWritable: false },
      { pubkey: streamConfig, isSigner: false, isWritable: true },
    ],
    data: instructionDiscriminator('resume_stream_v2'),
  });
}

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: any;
  while (attempt < DEFAULT_MAX_RETRIES) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      attempt += 1;
      if (attempt >= DEFAULT_MAX_RETRIES) break;
      const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
      log(`${label} failed attempt=${attempt}, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function waitForOwner(
  account: PublicKey,
  expectedOwner: PublicKey,
  attempts = DEFAULT_UNDELEGATE_WAIT_ATTEMPTS,
  delayMs = DEFAULT_UNDELEGATE_WAIT_MS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const info = await getAccountInfoRead(account, 'confirmed');
    if (info && info.owner.equals(expectedOwner)) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function connectionForRpc(url: string): Connection {
  const normalized = normalizeRpcUrl(url);
  const existing = txConnectionCache.get(normalized);
  if (existing) return existing;
  const created = createRpcConnection(normalized);
  txConnectionCache.set(normalized, created);
  return created;
}

function rpcEndpoint(connection: Connection): string {
  const endpoint = (connection as any).rpcEndpoint;
  if (typeof endpoint === 'string' && endpoint.length > 0) {
    return normalizeRpcUrl(endpoint);
  }
  return 'unknown';
}

function parseDelegationEndpoint(result: DelegationStatusResponse | null | undefined): string | null {
  if (!result) return null;
  const delegated =
    Boolean(result.delegated) ||
    Boolean(result.isDelegated) ||
    Boolean(result.delegation?.delegated);
  if (!delegated) return null;

  const raw =
    result.delegation?.fqdn ||
    result.delegation?.endpoint ||
    result.fqdn ||
    result.endpoint;
  if (!raw || typeof raw !== 'string') return null;
  const withProtocol = raw.startsWith('http') ? raw : `https://${raw}`;
  return normalizeRpcUrl(withProtocol);
}

function isSettleTooSoonError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return (
    message.includes('SettleTooSoon') ||
    message.includes('0x177d') ||
    message.includes('Error Number: 6013')
  );
}

function isAccrualNotFreshError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return (
    message.includes('AccrualNotFresh') ||
    message.includes('0x178c') ||
    message.includes('Error Number: 6028') ||
    message.includes('Accrual must be fresh')
  );
}

function isBlockhashNotFoundError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return message.includes('Blockhash not found');
}

async function getChainUnixTime(): Promise<number> {
  try {
    const slot = await readConnection.getSlot('processed');
    const blockTime = await readConnection.getBlockTime(slot);
    if (typeof blockTime === 'number' && blockTime > 0) return blockTime;
  } catch {
    // Fall back to local wall clock if block time lookup fails.
  }
  return Math.floor(Date.now() / 1000);
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return '';
  }
}

function isRetryableRouterStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableUmbraStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function routerStatusFetch(url: string, body: string): Promise<any> {
  if (!fetchAny) throw new Error('fetch unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTER_STATUS_TIMEOUT_MS);
  try {
    return await fetchAny(normalizeRpcUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function postUmbraRelay(payload: Record<string, any>): Promise<UmbraRouteRelayResult> {
  if (!fetchAny) {
    return { ok: false, reason: 'fetch_unavailable' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (UMBRA_RELAY_API_KEY) {
    headers.Authorization = `Bearer ${UMBRA_RELAY_API_KEY}`;
  }

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= UMBRA_ROUTE_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UMBRA_ROUTE_TIMEOUT_MS);
    try {
      const res = await fetchAny(UMBRA_RELAY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let parsed: any = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }

      if (res.ok) {
        const ok = parsed?.ok !== false;
        if (ok) {
          const destinationTokenAccount =
            typeof parsed?.destinationTokenAccount === 'string'
              ? parsed.destinationTokenAccount
              : undefined;
          const deferClaim = parsed?.deferClaim === true;
          return {
            ok: true,
            reason: 'accepted',
            statusCode: res.status,
            jobId: parsed?.jobId ? String(parsed.jobId) : undefined,
            relayStatus: parsed?.status ? String(parsed.status) : undefined,
            destinationTokenAccount,
            deferClaim,
          };
        }
        lastReason = String(parsed?.error || parsed?.reason || 'relay_rejected');
        if (attempt < UMBRA_ROUTE_RETRIES) {
          const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }
        return { ok: false, reason: lastReason, statusCode: res.status };
      }

      const retryable = isRetryableUmbraStatus(res.status);
      lastReason = String(parsed?.error || parsed?.reason || `http_${res.status}`);
      if (retryable && attempt < UMBRA_ROUTE_RETRIES) {
        const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      return { ok: false, reason: lastReason, statusCode: res.status };
    } catch (e: any) {
      lastReason = e?.name === 'AbortError' ? 'relay_timeout' : String(e?.message || 'relay_request_failed');
      if (attempt < UMBRA_ROUTE_RETRIES) {
        const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      return { ok: false, reason: lastReason };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, reason: lastReason };
}

async function postUmbraForward(payload: Record<string, any>): Promise<UmbraForwardResult> {
  if (!fetchAny) {
    return { ok: false, reason: 'fetch_unavailable' };
  }
  if (!UMBRA_FORWARD_URL) {
    return { ok: false, reason: 'forward_url_missing' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (UMBRA_RELAY_API_KEY) {
    headers.Authorization = `Bearer ${UMBRA_RELAY_API_KEY}`;
  }

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= UMBRA_ROUTE_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UMBRA_ROUTE_TIMEOUT_MS);
    try {
      const res = await fetchAny(UMBRA_FORWARD_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      let parsed: any = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }

      if (res.ok && parsed?.ok !== false) {
        return {
          ok: true,
          reason: 'forwarded',
          statusCode: res.status,
          relayTxSignature: parsed?.relayTxSignature ? String(parsed.relayTxSignature) : undefined,
          relayerPublicKey: parsed?.relayerPublicKey ? String(parsed.relayerPublicKey) : undefined,
          jobId: parsed?.jobId ? String(parsed.jobId) : undefined,
        };
      }

      const retryable = isRetryableUmbraStatus(res.status);
      lastReason = String(parsed?.error || parsed?.reason || `http_${res.status}`);
      if (retryable && attempt < UMBRA_ROUTE_RETRIES) {
        const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      return { ok: false, reason: lastReason, statusCode: res.status };
    } catch (e: any) {
      lastReason = e?.name === 'AbortError' ? 'forward_timeout' : String(e?.message || 'forward_failed');
      if (attempt < UMBRA_ROUTE_RETRIES) {
        const delay = DEFAULT_BACKOFF_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      return { ok: false, reason: lastReason };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, reason: lastReason };
}

async function getDelegationStatusWithRetry(
  streamAccount: PublicKey
): Promise<{ payload: any; usedUrl: string } | null> {
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
          if (isRetryableRouterStatus(res.status)) continue;
          log(`getDelegationStatus failed stream=${streamAccount.toBase58()} ${lastReason}`);
          return null;
        }
        const payload = await res.json();
        return { payload, usedUrl: normalizeRpcUrl(url) };
      } catch (e: any) {
        lastReason = `url=${normalizeRpcUrl(url)} reason=${e?.message || 'unknown'}`;
      }
    }
    if (attempt < ROUTER_STATUS_RETRIES) {
      const delay = ROUTER_STATUS_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  log(
    `getDelegationStatus exhausted retries stream=${streamAccount.toBase58()} attempts=${ROUTER_STATUS_RETRIES} ${lastReason}`
  );
  return null;
}

function withTeeTokenIfNeeded(endpoint: string): string | null {
  const host = endpointHost(endpoint);
  const isTee = host === 'tee.magicblock.app';
  if (!isTee) return endpoint;

  try {
    const url = new URL(endpoint);
    if (url.searchParams.get('token')) return normalizeRpcUrl(url.toString());
    if (!TEE_AUTH_TOKEN) return null;
    url.searchParams.set('token', TEE_AUTH_TOKEN);
    return normalizeRpcUrl(url.toString());
  } catch {
    return null;
  }
}

type DelegatedTxRoute = {
  connection: Connection;
  skipReason?: string;
};

async function resolveDelegatedTxConnection(streamAccount: PublicKey): Promise<DelegatedTxRoute> {
  if (!fetchAny) return { connection: txConnection };
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
        log(
          `getDelegationStatus unavailable stream=${streamKey}; using cached delegated endpoint=${cached.endpoint} age_ms=${ageMs}`
        );
        return { connection: connectionForRpc(cached.endpoint) };
      }
      return { connection: txConnection };
    }
    const statusResult = status.payload?.result as DelegationStatusResponse | undefined;
    const parsedEndpoint = parseDelegationEndpoint(statusResult);
    const delegatedNoEndpoint =
      Boolean(statusResult?.delegated) ||
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
  } catch (e: any) {
    if (cached) {
      const ageMs = nowMs - cached.cachedAtMs;
      log(
        `getDelegationStatus error stream=${streamKey} reason=${e?.message || 'unknown'}; using cached delegated endpoint=${cached.endpoint} age_ms=${ageMs}`
      );
      return { connection: connectionForRpc(cached.endpoint) };
    }
    log(`getDelegationStatus error stream=${streamKey} reason=${e?.message || 'unknown'}; using default TX RPC`);
    return { connection: txConnection };
  }
}

type ComplianceDecision = {
  ok: boolean;
  reason: string;
  hardFail: boolean;
};

async function checkComplianceFailClosed(wallet: string): Promise<ComplianceDecision> {
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

    const isCompliant =
      Number(risk?.riskScore || 10) <= 3 &&
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
  } catch (e: any) {
    return {
      ok: false,
      reason: `Range check failed: ${e?.message || 'unknown error'}`,
      hardFail: false,
    };
  }
}

function isNoAccruedBalanceError(error: unknown): boolean {
  const message = String(error ?? '');
  return message.includes('NoAccruedBalance') || message.includes('No accrued balance');
}

async function maybeHandleUmbraPayoutRouting(input: UmbraRouteInput): Promise<UmbraRouteDecision> {
  if (!UMBRA_ROUTE_ENABLED) {
    return { handled: false, reason: 'mode_off' };
  }

  if (!UMBRA_ROUTE_CONFIGURED) {
    const reason = 'umbra_not_configured';
    const remediation = 'Set KEEPER_UMBRA_RELAY_URL and KEEPER_UMBRA_POOL_ID';
    if (PRIVACY_PAYOUT_ROUTE_MODE === 'enforced') {
      log(
        `[umbra-route] stream=${input.stream.streamIndex} nonce=${input.payoutNonce} ` +
          `mode=enforced reason=${reason}; payout remains buffered`
      );
      await deadLetterWithdrawRequest('umbra_route_pending', input.request, `${reason}; ${remediation}`);
      return { handled: true, reason };
    }

    log(
      `[umbra-route] stream=${input.stream.streamIndex} nonce=${input.payoutNonce} ` +
        `mode=shadow reason=${reason}; continuing current claim path`
    );
    return { handled: false, reason };
  }

  const relayHost = hostFromUrl(UMBRA_RELAY_URL);
  const relayerLabel = UMBRA_RELAYER_KEY_ID || 'default';
  const relayPayload = {
    version: 1,
    dryRun: PRIVACY_PAYOUT_ROUTE_MODE === 'shadow',
    poolId: UMBRA_POOL_ID,
    relayerKeyId: UMBRA_RELAYER_KEY_ID || null,
    business: input.request.business.toBase58(),
    streamIndex: input.request.streamIndex,
    requestAddress: input.request.address.toBase58(),
    requesterAuthHash: authHashHex(input.request.requesterAuthHash),
    requestedAt: input.request.requestedAt,
    payoutNonce: input.payoutNonce,
    shieldedPayout: input.shieldedPayout.toBase58(),
    payoutTokenAccount: input.payoutTokenAccount.toBase58(),
    mint: PAYUSD_MINT.toBase58(),
    keeper: payer.publicKey.toBase58(),
    routeOwnerPubkey: input.routeOwnerPubkey || '',
    createdAt: Math.floor(Date.now() / 1000),
  };
  const baseLog =
    `[umbra-route] stream=${input.stream.streamIndex} nonce=${input.payoutNonce} ` +
    `payout_token=${input.payoutTokenAccount.toBase58()} relay=${relayHost} pool=${UMBRA_POOL_ID} relayer=${relayerLabel}`;

  if (PRIVACY_PAYOUT_ROUTE_MODE === 'shadow') {
    const result = await postUmbraRelay(relayPayload);
    if (result.ok) {
      const destinationLabel = result.destinationTokenAccount || 'n/a';
      log(
        `${baseLog} mode=shadow dry_run=true status=${result.relayStatus || 'accepted'} ` +
          `job_id=${result.jobId || 'n/a'} route_destination=${destinationLabel}`
      );
      return { handled: false, reason: 'shadow_accepted' };
    }
    log(`${baseLog} mode=shadow dry_run=true failed=${result.reason}; continuing current claim path`);
    return { handled: false, reason: 'shadow_failed' };
  }

  const result = await postUmbraRelay(relayPayload);
  if (result.ok) {
    const destination = result.destinationTokenAccount?.trim();
    if (destination && !result.deferClaim) {
      let destinationTokenAccount: PublicKey;
      try {
        destinationTokenAccount = new PublicKey(destination);
      } catch {
        const reason = `invalid_route_destination: ${destination}`;
        await deadLetterWithdrawRequest('umbra_route_failed', input.request, reason);
        await sendAlertWithdrawRequest('umbra_route_failed', input.request, reason);
        log(`${baseLog} mode=enforced failed=${reason}; payout remains buffered`);
        return { handled: true, reason: 'enforced_invalid_destination' };
      }

      try {
        const claimIx = keeperClaimOnBehalfIx(
          input.request.business,
          input.request.streamIndex,
          input.payoutNonce,
          input.shieldedPayout,
          input.payoutTokenAccount,
          destinationTokenAccount,
          0,
        );

        if (UMBRA_FORWARD_SIGNED_CLAIM) {
          const signedTxBase64 = await buildSignedKeeperClaimOnBehalfTxBase64(claimIx);
          const forwardResult = await postUmbraForward({
            version: 1,
            poolId: UMBRA_POOL_ID,
            business: input.request.business.toBase58(),
            streamIndex: input.request.streamIndex,
            payoutNonce: input.payoutNonce,
            destinationTokenAccount: destinationTokenAccount.toBase58(),
            signedTransactionBase64: signedTxBase64,
            createdAt: Math.floor(Date.now() / 1000),
          });
          if (forwardResult.ok) {
            log(
              `${baseLog} mode=enforced status=${result.relayStatus || 'accepted'} ` +
                `job_id=${result.jobId || 'n/a'} route_destination=${destinationTokenAccount.toBase58()} ` +
                `forwarded_tx=${forwardResult.relayTxSignature || 'pending'} relayer=${forwardResult.relayerPublicKey || 'n/a'}`
            );
            return { handled: true, reason: 'enforced_routed_forwarded' };
          }

          const forwardModeMismatch = String(forwardResult.reason || '')
            .toLowerCase()
            .includes('forward_mode_requires_umbra-network');
          if (!forwardModeMismatch) {
            const reason = `forward_claim_failed: ${forwardResult.reason}`;
            await deadLetterWithdrawRequest('umbra_route_failed', input.request, reason);
            await sendAlertWithdrawRequest('umbra_route_failed', input.request, reason);
            log(`${baseLog} mode=enforced failed=${reason}; payout remains buffered`);
            return { handled: true, reason: 'enforced_forward_failed' };
          }

          // Safety fallback: if relay is in destination mode, direct claim is still valid.
          log(
            `${baseLog} mode=enforced status=${result.relayStatus || 'accepted'} ` +
              `job_id=${result.jobId || 'n/a'} route_destination=${destinationTokenAccount.toBase58()} ` +
              `forward_unavailable=${forwardResult.reason}; fallback=direct_claim`
          );
        }

        const claimSig = await retry(
          `umbra_claim_intermediate stream=${input.request.streamIndex} nonce=${input.payoutNonce}`,
          () =>
            sendKeeperClaimOnBehalf(
              input.request.business,
              input.request.streamIndex,
              input.payoutNonce,
              input.shieldedPayout,
              input.payoutTokenAccount,
              destinationTokenAccount,
              0,
            ),
        );
        log(
          `${baseLog} mode=enforced status=${result.relayStatus || 'accepted'} ` +
            `job_id=${result.jobId || 'n/a'} route_destination=${destinationTokenAccount.toBase58()} ` +
            `claim_tx=${claimSig}`
        );
        return { handled: true, reason: 'enforced_routed_claimed' };
      } catch (e: any) {
        const reason = `intermediate_claim_failed: ${e?.message || 'unknown'}`;
        await deadLetterWithdrawRequest('umbra_route_failed', input.request, reason);
        await sendAlertWithdrawRequest('umbra_route_failed', input.request, reason);
        log(`${baseLog} mode=enforced failed=${reason}; payout remains buffered`);
        return { handled: true, reason: 'enforced_claim_failed' };
      }
    }

    log(
      `${baseLog} mode=enforced status=${result.relayStatus || 'accepted'} ` +
        `job_id=${result.jobId || 'n/a'} deferred=${result.deferClaim ? 'true' : 'false'}`
    );
    return { handled: true, reason: 'enforced_routed_async' };
  }

  const reason = `enforced route failed: ${result.reason}`;
  await deadLetterWithdrawRequest('umbra_route_failed', input.request, reason);
  await sendAlertWithdrawRequest('umbra_route_failed', input.request, reason);
  log(`${baseLog} mode=enforced failed=${result.reason}; payout remains buffered`);
  return { handled: true, reason: 'enforced_failed' };
}




async function processWithdrawRequest(request: WithdrawRequestV2Record): Promise<void> {
  const requestKey = `${request.address.toBase58()}:${request.requestedAt}`;
  if (idempotency.has(requestKey)) return;
  const retryAt = withdrawDecryptRetryAfter.get(requestKey) || 0;
  if (retryAt > Date.now()) return;

  const business = await getBusiness(request.business);
  if (!business) {
    log(`Skipping withdraw_request=${request.address.toBase58()} reason=business_missing`);
    return;
  }

  const config = await getStreamConfig(request.business);
  if (!config) throw new Error(`v2 stream config missing for ${request.business.toBase58()}`);

  if (config.isPaused) {
    // Devnet quality-of-life: if compliance is disabled but the business is stuck in a
    // compliance pause (reason=2), auto-resume with a cooldown so the app doesn't feel broken.
    if (!COMPLIANCE_ENABLED && config.pauseReason === PAUSE_REASON_COMPLIANCE) {
      const key = request.business.toBase58();
      const last = autoResumeCooldownByBusiness.get(key) || 0;
      const now = Date.now();
      if (now - last >= 60_000) {
        autoResumeCooldownByBusiness.set(key, now);
        try {
          await retry(`resume_stream_v2 business=${key}`, () =>
            sendInstruction('resume_stream_v2', resumeStreamIx(request.business), readConnection)
          );
          log(`Auto-resumed business=${key} reason=compliance_disabled`);
        } catch (e: any) {
          log(`Auto-resume failed business=${key} reason=${e?.message || 'unknown'}`);
        }
      }
    }
    log(
      `Skipping withdraw_request=${request.address.toBase58()} reason=config_paused pause_reason=${config.pauseReason}`
    );
    return;
  }

  if (!(payer.publicKey.equals(config.keeper) || payer.publicKey.equals(business.owner))) {
    log(`Skipping withdraw_request=${request.address.toBase58()} reason=keeper_not_authorized`);
    return;
  }

  // Resolve worker wallet (from signed auth queue) for private route destination ownership.
  let workerPubkeyStr: string | null = null;
  try {
    workerPubkeyStr = await getWorkerPubkeyForStream(
      request.streamIndex,
      business.owner.toBase58(),
    );
  } catch {
    workerPubkeyStr = null;
  }

  if (COMPLIANCE_ENABLED) {
    let compliance: ComplianceDecision;
    if (!workerPubkeyStr) {
      compliance = {
        ok: false,
        reason: 'worker_identity_unavailable_for_compliance',
        hardFail: false,
      };
    } else {
      const workerPubkey = new PublicKey(workerPubkeyStr);
      if (!authHashMatchesWorker(request.requesterAuthHash, workerPubkey)) {
        compliance = {
          ok: false,
          reason: 'requester_auth_hash_mismatch',
          hardFail: true,
        };
      } else {
        compliance = await checkComplianceFailClosed(workerPubkey.toBase58());
      }
    }

    if (!compliance.ok) {
      if (!compliance.hardFail && !PAUSE_ON_COMPLIANCE_SOFT_FAIL) {
        const reason = `compliance_soft_fail_skip: ${compliance.reason}`;
        await deadLetterWithdrawRequest('compliance_soft_fail', request, reason);
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=${reason}`);
        return;
      }

      await retry(`pause_stream_v2 business=${request.business.toBase58()}`, () =>
        sendInstruction('pause_stream_v2', pauseComplianceIx(request.business), readConnection)
      );

      const reason = `compliance_fail_closed: ${compliance.reason}`;
      await deadLetterWithdrawRequest('compliance_pause', request, reason);
      await sendAlertWithdrawRequest('compliance_pause', request, reason);
      log(`Paused business=${request.business.toBase58()} reason=${reason}`);
      return;
    }
  }

  const vaultPda = business.vault.equals(PublicKey.default)
    ? deriveVaultPda(request.business)
    : business.vault;
  const vault = await getVault(vaultPda);
  if (!vault) throw new Error(`Vault missing for business ${request.business.toBase58()}`);

  const employeePda = deriveEmployeeStreamPda(request.business, request.streamIndex);
  let employeeInfo = await getAccountInfoRead(employeePda, 'confirmed');
  if (!employeeInfo) {
    log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_stream_missing`);
    return;
  }

  let delegatedOnChain = employeeInfo.owner.equals(DELEGATION_PROGRAM_ID);
  const delegatedOriginally = delegatedOnChain;
  let accruedOnEr = false;
  let employeeParsed =
    parseEmployeeStreamV2(employeePda, employeeInfo.owner, Buffer.from(employeeInfo.data));
  if (!employeeParsed) {
    log(`Skipping withdraw_request=${request.address.toBase58()} reason=employee_parse_failed`);
    return;
  }

  if (delegatedOnChain && ENFORCE_MAGIC_CONTEXT_CHECK && !magicCommitSupported) {
    if (!delegatedUnsupportedLogged.has(employeePda.toBase58())) {
      delegatedUnsupportedLogged.add(employeePda.toBase58());
      const reason =
        'delegated_stream_requires_magic_commit_context (Magic program/context unavailable on configured RPC)';
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
        log(
          `Undelegate pending stream=${employeePda.toBase58()} waited_ms=${elapsedMs} cooldown_ms=${DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000}`
        );
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
        await retry(`accrue_v2(er) stream=${request.streamIndex}`, () =>
          sendInstruction(
            'accrue_v2',
            accrueIx(request.business, request.streamIndex),
            route.connection,
          )
        );
        accruedOnEr = true;
      } catch (e: any) {
        const reason = e?.message || 'unknown';
        log(
          `accrue_v2(er) failed stream=${employeePda.toBase58()} reason=${reason}; falling back to base-layer accrual`
        );
      }
    }

    try {
      await retry(`commit_and_undelegate_stream_v2 stream=${request.streamIndex}`, () =>
        sendInstruction(
          'commit_and_undelegate_stream_v2',
          commitUndelegateIx(request.business, request.streamIndex),
          route.connection,
        )
      );
    } catch (e: any) {
      if (isBlockhashNotFoundError(e)) {
        log(`Skipping withdraw_request=${request.address.toBase58()} reason=blockhash_not_found`);
        return;
      }
      throw e;
    }

    undelegateInFlight.set(employeePda.toBase58(), Date.now());
    log(
      `Waiting undelegate stream=${employeePda.toBase58()} timeout_ms=${DEFAULT_UNDELEGATE_WAIT_ATTEMPTS * DEFAULT_UNDELEGATE_WAIT_MS}`
    );
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

  // ALWAYS checkpoint accrual before settling — required by the on-chain freshness guard.
  // We always accrue here regardless of prior ER accrual to guarantee freshness.
  await retry(`accrue_v2 stream=${request.streamIndex}`, () =>
    sendInstruction('accrue_v2', accrueIx(request.business, request.streamIndex), readConnection)
  );

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
    const { reason, remediation } = preflight as { ok: false; reason: string; remediation: string };
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
  const { keypair: payoutTokenKeypair, instruction: createPayoutAcctIx } =
    createPayoutTokenAccountIx(payer.publicKey, shieldedPayoutPda, PAYUSD_MINT);

  log(
    `settle_audit stream=${employeePda.toBase58()} ` +
    `accrued_handle=${employeeParsed.accruedHandle.toString()} ` +
    `nonce=${payoutNonce} payout_token=${payoutTokenKeypair.publicKey.toBase58()} mode=2hop_shielded`
  );

  try {
    // Step 1: Create the payout token account.
    await retry(`create_payout_token_account nonce=${payoutNonce}`, () =>
      sendInstruction(
        'create_payout_token_account',
        createPayoutAcctIx,
        readConnection,
        [payoutTokenKeypair],
      )
    );

    // Step 2: Buffer the payout (vault → payout_token_account).
    const sendSettle = () =>
      sendInstruction(
        'process_withdraw_request_v2',
        processWithdrawRequestIx(request, payoutNonce, vault.tokenAccount, payoutTokenKeypair.publicKey),
        readConnection,
      );

    try {
      await retry(`process_withdraw_request_v2 stream=${request.streamIndex}`, sendSettle);
    } catch (settleErr: any) {
      // Self-heal freshness race in the same tick:
      // if settle sees AccrualNotFresh, accrue once more immediately and retry settle.
      if (!isAccrualNotFreshError(settleErr)) throw settleErr;
      log(
        `[freshness-recover] stream=${request.streamIndex} nonce=${payoutNonce} reason=accrual_not_fresh; ` +
          'running immediate accrue+settle retry'
      );
      await retry(`accrue_v2(refresh) stream=${request.streamIndex}`, () =>
        sendInstruction('accrue_v2', accrueIx(request.business, request.streamIndex), readConnection)
      );
      await retry(`process_withdraw_request_v2(refresh) stream=${request.streamIndex}`, sendSettle);
    }

    const umbraRoute = await maybeHandleUmbraPayoutRouting({
      request,
      stream: employeeParsed,
      payoutNonce,
      shieldedPayout: shieldedPayoutPda,
      payoutTokenAccount: payoutTokenKeypair.publicKey,
      routeOwnerPubkey: workerPubkeyStr,
    });

    if (!umbraRoute.handled) {
      if (AUTO_CLAIM_ON_BUFFER) {
        if (!employeeParsed.hasFixedDestination) {
          log(
            `Buffered payout created stream=${request.streamIndex} nonce=${payoutNonce}; ` +
              'auto-claim skipped (no fixed destination route)'
          );
        } else {
          // Optional legacy mode: auto-claim buffered payouts to stream destination.
          try {
            await retry(`keeper_claim_auto stream=${request.streamIndex} nonce=${payoutNonce}`, () =>
              sendKeeperClaimOnBehalf(
                request.business,
                request.streamIndex,
                payoutNonce,
                shieldedPayoutPda,
                payoutTokenKeypair.publicKey,
                employeeParsed.employeeTokenAccount,
                0,
              )
            );
            log(
              `✅ Auto-claim completed stream=${request.streamIndex} nonce=${payoutNonce} ` +
                `→ ${employeeParsed.employeeTokenAccount.toBase58()}`
            );
          } catch (claimErr: any) {
            // Non-fatal: the worker can still manually claim later
            log(`[auto-claim] Failed stream=${request.streamIndex} nonce=${payoutNonce}: ${claimErr?.message || 'unknown'}`);
          }
        }
      } else {
        log(`Buffered payout awaiting worker claim stream=${request.streamIndex} nonce=${payoutNonce}`);
      }
    } else {
      log(
        `Private route handled stream=${request.streamIndex} nonce=${payoutNonce} ` +
          `route=umbra reason=${umbraRoute.reason}`
      );
    }
  } catch (e: any) {
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
    // Self-healing: refresh legacy withdraw request state into auth-hash format.
    if (String(e?.message || '').includes('0x1784') || String(e?.message || '').includes('InvalidWithdrawRequester')) {
      log(`[auto-heal] InvalidWithdrawRequester detected stream=${request.streamIndex} — refreshing PDA`);
      try {
        const [businessPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('business'), business.owner.toBuffer()],
          PROGRAM_ID,
        );
        const streamConfigPda = deriveStreamConfigPda(businessPda);
        const streamPda = deriveEmployeeStreamPda(businessPda, request.streamIndex);
        const [withdrawRequestPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('withdraw_request_v2'),
            businessPda.toBuffer(),
            new Uint8Array(new BigUint64Array([BigInt(request.streamIndex)]).buffer),
          ],
          PROGRAM_ID
        );

        const streamIndexBuf = Buffer.alloc(8);
        streamIndexBuf.writeBigUInt64LE(BigInt(request.streamIndex));

        const ix = new TransactionInstruction({
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: businessPda, isSigner: false, isWritable: false },
            { pubkey: streamConfigPda, isSigner: false, isWritable: false },
            { pubkey: streamPda, isSigner: false, isWritable: false },
            { pubkey: withdrawRequestPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: PROGRAM_ID,
          data: Buffer.concat([
            KEEPER_REQUEST_WITHDRAW_V2_DISC,
            streamIndexBuf,
          ]),
        });

        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await readConnection.getLatestBlockhash()).blockhash;
        tx.sign(payer);
        const sig = await readConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        await readConnection.confirmTransaction(sig, 'confirmed');
        log(`[auto-heal] ✅ PDA refreshed with auth-hash format stream=${request.streamIndex} tx=${sig}`);
        return; // next tick will pick up the fixed PDA and succeed
      } catch (healErr: any) {
        log(`[auto-heal] Failed to refresh PDA stream=${request.streamIndex}: ${healErr?.message}`);
      }
    }
    throw e;
  }

  if (REDELEGATE_AFTER_WITHDRAW && delegatedOriginally) {
    try {
      await retry(`redelegate_stream_v2 stream=${request.streamIndex}`, () =>
        sendInstruction('redelegate_stream_v2', redelegateIx(request.business, request.streamIndex), readConnection)
      );
    } catch (e: any) {
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

const revokedStreams = new Set<string>();

async function revokeViewAccess(stream: EmployeeStreamV2Record, targetWallet: PublicKey): Promise<void> {
  const streamInfo = await txConnection.getAccountInfo(stream.address, 'confirmed');
  if (!streamInfo) throw new Error("Stream not found for revoke");

  const salaryHandleBytes = streamInfo.data.slice(112, 128);
  const accruedHandleBytes = streamInfo.data.slice(144, 160);

  const [salaryAllowanceAccount] = PublicKey.findProgramAddressSync(
    [salaryHandleBytes, targetWallet.toBuffer()],
    INCO_LIGHTNING_ID
  );
  const [accruedAllowanceAccount] = PublicKey.findProgramAddressSync(
    [accruedHandleBytes, targetWallet.toBuffer()],
    INCO_LIGHTNING_ID
  );

  const [streamConfigPda] = PublicKey.findProgramAddressSync(
    [STREAM_CONFIG_V2_SEED, stream.business.toBuffer()],
    PROGRAM_ID
  );

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(stream.streamIndex));

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: stream.business, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: false },
      { pubkey: stream.address, isSigner: false, isWritable: false },
      { pubkey: targetWallet, isSigner: false, isWritable: false }, // target_wallet
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // keeper_wallet
      { pubkey: salaryAllowanceAccount, isSigner: false, isWritable: true },
      { pubkey: accruedAllowanceAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      REVOKE_VIEW_ACCESS_V2_DISC,
      streamIndexBuf,
    ]),
  });

  const recentBlockhash = await txConnection.getLatestBlockhash();
  const messageObj = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: recentBlockhash.blockhash,
    instructions: [ix]
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageObj);
  tx.sign([payer]);

  const sig = await txConnection.sendTransaction(tx, { maxRetries: 3 });
  await txConnection.confirmTransaction({
    signature: sig,
    ...recentBlockhash
  });
  log(`Keeper revoked view access stream=${stream.streamIndex} target=${targetWallet.toBase58().slice(0, 8)} tx=${sig}`);
}

async function processRevocations(): Promise<void> {
  const allStreams = await listAllStreams();
  const now = Math.floor(Date.now() / 1000);

  for (const stream of allStreams) {
    const isCompleted = stream.periodEnd > 0 && now >= stream.periodEnd;
    const isInactive = !stream.isActive;

    if (isCompleted || isInactive) {
      if (revokedStreams.has(stream.address.toBase58())) continue;

      try {
        let targets: string[] = [];
        try {
          const business = await getBusiness(stream.business);
          if (!business) {
            log(`[revoke] business missing for stream=${stream.streamIndex}, skipping`);
            continue;
          }
          targets = await getViewAccessTargets(stream.streamIndex, business.owner.toBase58());
        } catch (_importErr) {
          // Fallback: skip revocation if the function is unavailable due to CJS interop
          log(`[revoke] getViewAccessTargets unavailable for stream=${stream.streamIndex}, skipping`);
          continue;
        }
        for (const target of targets) {
          await revokeViewAccess(stream, new PublicKey(target));
        }
        revokedStreams.add(stream.address.toBase58());
      } catch (e: any) {
        log(`Failed to revoke view access stream=${stream.streamIndex} reason=${e.message}`);
      }
    }
  }
}

async function processStream(inputStream: EmployeeStreamV2Record): Promise<void> {
  let stream = inputStream;
  const streamKey = stream.address.toBase58();
  let delegatedOnChain = stream.owner.equals(DELEGATION_PROGRAM_ID);
  let shouldRedelegate = delegatedOnChain || undelegateInFlight.has(streamKey);

  // Always refresh owner from chain at stream start to avoid stale delegation state.
  const latestInfo = await getAccountInfoRead(stream.address, 'confirmed');
  if (latestInfo) {
    delegatedOnChain = latestInfo.owner.equals(DELEGATION_PROGRAM_ID);
    const parsedLatest = parseEmployeeStreamV2(
      stream.address,
      latestInfo.owner,
      Buffer.from(latestInfo.data)
    );
    if (parsedLatest) {
      stream = parsedLatest;
    }
    shouldRedelegate = delegatedOnChain || shouldRedelegate;
  }

  if (delegatedOnChain && ENFORCE_MAGIC_CONTEXT_CHECK && !magicCommitSupported) {
    if (!delegatedUnsupportedLogged.has(streamKey)) {
      delegatedUnsupportedLogged.add(streamKey);
      const reason =
        'delegated_stream_requires_magic_commit_context (Magic program/context unavailable on configured RPC)';
      log(`Skipping stream=${streamKey} reason=${reason}`);
      await deadLetter('delegated_stream_skipped', stream, reason);
    }
    return;
  }

  const business = await getBusiness(stream.business);
  if (!business) throw new Error(`Business account missing for ${stream.business.toBase58()}`);

  const config = await getStreamConfig(stream.business);
  if (!config) throw new Error(`v2 stream config missing for ${stream.business.toBase58()}`);

  if (config.isPaused) {
    log(
      `Skipping stream=${stream.address.toBase58()} reason=config_paused pause_reason=${config.pauseReason}`
    );
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

  if (!stream.hasFixedDestination) {
    // Privacy mode streams settle through explicit withdraw-request flow only.
    // Skip periodic settle loop to avoid unnecessary undelegate/redelegate churn.
    idempotency.add(idempotencyKey);
    return;
  }

  // NOTE: Stream-based compliance gating was tied to a stream->wallet mapping file.
  // Expensee pivot uses withdraw requests with auth-hash commitments (no raw worker pubkey)
  // on-chain. Compliance checks (if enabled) are applied during withdraw request processing.

  const vaultPda = business.vault.equals(PublicKey.default)
    ? deriveVaultPda(stream.business)
    : business.vault;
  const vault = await getVault(vaultPda);
  if (!vault) throw new Error(`Vault missing for business ${stream.business.toBase58()}`);

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
      } else {
        const elapsedMs = Date.now() - inFlightAt;
        if (elapsedMs < DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000) {
          log(
            `Undelegate pending stream=${streamKey} waited_ms=${elapsedMs} cooldown_ms=${DEFAULT_UNDELEGATE_RETRY_COOLDOWN_SECS * 1000}`
          );
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
        await retry(`commit_and_undelegate_stream_v2 stream=${stream.streamIndex}`, () =>
          sendInstruction(
            'commit_and_undelegate_stream_v2',
            commitUndelegateIx(stream.business, stream.streamIndex),
            delegatedTxConnection,
          )
        );
      } catch (e: any) {
        if (isBlockhashNotFoundError(e)) {
          log(`Skipping stream=${stream.address.toBase58()} reason=blockhash_not_found`);
          return;
        }
        throw e;
      }
      undelegateInFlight.set(streamKey, Date.now());
      shouldRedelegate = true;

      log(
        `Waiting undelegate stream=${stream.address.toBase58()} timeout_ms=${DEFAULT_UNDELEGATE_WAIT_ATTEMPTS * DEFAULT_UNDELEGATE_WAIT_MS}`
      );
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
    const inFlightAt = undelegateInFlight.get(streamKey)!;
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
    await retry(`accrue_v2 stream=${stream.streamIndex}`, async () => {
      await sendInstruction('accrue_v2', accrueIx(stream.business, stream.streamIndex), readConnection);
    });
  } else {
    log(`Skipping accrue_v2 for delegated stream=${stream.address.toBase58()}`);
  }

  let settleConnection: Connection = readConnection;
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
    await retry(`auto_settle_stream_v2 stream=${stream.streamIndex}`, () =>
      sendInstruction(
        'auto_settle_stream_v2',
        autoSettleIx(stream.business, stream.streamIndex, vault.tokenAccount, stream.employeeTokenAccount),
        settleConnection,
      )
    );
  } catch (e: any) {
    if (!isSettleTooSoonError(e)) {
      throw e;
    }
    log(`Skipping stream=${stream.address.toBase58()} reason=settle_too_soon`);

    if (shouldRedelegate) {
      try {
        await retry(`redelegate_stream_v2 stream=${stream.streamIndex}`, () =>
          sendInstruction('redelegate_stream_v2', redelegateIx(stream.business, stream.streamIndex), readConnection)
        );
      } catch (redelegateError: any) {
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
      await retry(`redelegate_stream_v2 stream=${stream.streamIndex}`, () =>
        sendInstruction('redelegate_stream_v2', redelegateIx(stream.business, stream.streamIndex), readConnection)
      );
    } catch (e: any) {
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

async function processClaimRelays(): Promise<void> {
  const batch = await getPendingClaimAuths(5);
  if (batch.length === 0) return;

  log(`Processing ${batch.length} claim relay authorization(s) from DB`);

  for (const auth of batch) {
    try {
      const businessOwner = new PublicKey(auth.businessOwner);
      const workerPubkey = new PublicKey(auth.workerPubkey);
      const destinationTokenAccount = new PublicKey(auth.destinationTokenAccount);

      // 1. Cryptographic Authentication
      // Preferred signed format binds business + destination:
      //   claim:<businessOwner>:<streamIndex>:<nonce>:<expiry>:<destinationTokenAccount>
      // Legacy fallback:
      //   claim:<streamIndex>:<nonce>:<expiry>
      const messagePreferred = new TextEncoder().encode(
        `claim:${auth.businessOwner}:${auth.streamIndex}:${auth.nonce}:${auth.expiry}:${destinationTokenAccount.toBase58()}`
      );
      const messageLegacy = new TextEncoder().encode(
        `claim:${auth.streamIndex}:${auth.nonce}:${auth.expiry}`
      );
      try {
        const signature = new Uint8Array(auth.signature);
        const isValid =
          ed25519.verify(signature, messagePreferred, workerPubkey.toBytes()) ||
          ed25519.verify(signature, messageLegacy, workerPubkey.toBytes());
        if (!isValid) {
          log(`Claim relay skip: invalid Ed25519 signature stream=${auth.streamIndex} nonce=${auth.nonce}`);
          await markClaimFailed(auth.businessOwner, auth.streamIndex, auth.nonce, "invalid_signature");
          continue;
        }
      } catch (err: any) {
        log(`Claim relay skip: signature verification error stream=${auth.streamIndex} nonce=${auth.nonce}`);
        await markClaimFailed(auth.businessOwner, auth.streamIndex, auth.nonce, "signature_error");
        continue;
      }

      const [businessPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('business'), businessOwner.toBuffer()],
        PROGRAM_ID,
      );
      const shieldedPayoutPda = deriveShieldedPayoutPda(businessPda, auth.streamIndex, auth.nonce);

      // Read the shielded payout account to get the payout_token_account
      const payoutInfo = await getAccountInfoRead(shieldedPayoutPda);
      if (!payoutInfo) {
        log(`Claim relay skip: shielded payout not found stream=${auth.streamIndex} nonce=${auth.nonce}`);
        continue;
      }

      // ShieldedPayoutV2 layout:
      // disc(8) + business(32) + streamIndex(8) + nonce(8) + employee_auth_hash(32)
      // + encrypted_amount(32) + claimed(1) + cancelled(1) + created_at(8)
      // + expires_at(8) + payout_token_account(32) + bump(1)
      const payoutData = payoutInfo.data;
      const claimed = payoutData[120] !== 0;
      if (claimed) {
        log(`Claim relay skip: already claimed on-chain stream=${auth.streamIndex} nonce=${auth.nonce}`);
        await markClaimCompleted(auth.businessOwner, auth.streamIndex, auth.nonce, "already_claimed");
        continue;
      }
      const payoutEmployeeAuthHash = Buffer.from(payoutData.subarray(56, 88));
      if (!authHashMatchesWorker(payoutEmployeeAuthHash, workerPubkey)) {
        log(`Claim relay skip: worker auth hash mismatch stream=${auth.streamIndex} nonce=${auth.nonce}`);
        await markClaimFailed(auth.businessOwner, auth.streamIndex, auth.nonce, "worker_auth_hash_mismatch");
        continue;
      }

      const payoutTokenAccount = new PublicKey(payoutData.subarray(138, 170));
      const sig = await sendKeeperClaimOnBehalf(
        businessPda,
        auth.streamIndex,
        auth.nonce,
        shieldedPayoutPda,
        payoutTokenAccount,
        destinationTokenAccount,
        auth.expiry,
      );

      await markClaimCompleted(auth.businessOwner, auth.streamIndex, auth.nonce, sig);
      log(`✅ Claim relayed stream=${auth.streamIndex} nonce=${auth.nonce} tx=${sig}`);
    } catch (e: any) {
      const reason = e?.message || 'unknown';
      await markClaimFailed(auth.businessOwner, auth.streamIndex, auth.nonce, reason);
      log(`Claim relay failed stream=${auth.streamIndex} nonce=${auth.nonce} reason=${reason}`);
    }
  }
}

async function processWithdrawRelays(): Promise<void> {
  const batch = await getPendingWithdrawAuths(5);
  if (batch.length === 0) return;

  log(`Processing ${batch.length} withdraw relay authorization(s) from DB`);

  for (const auth of batch) {
    try {
      const businessOwner = new PublicKey(auth.businessOwner);
      const workerPubkey = new PublicKey(auth.workerPubkey);

      // 1. Cryptographic Authentication
      // Preferred signed format binds to business owner:
      //   withdraw:<businessOwner>:<streamIndex>:<timestamp>
      // Legacy fallback kept for old queued auths:
      //   withdraw:<streamIndex>:<timestamp>
      const messagePreferred = new TextEncoder().encode(
        `withdraw:${auth.businessOwner}:${auth.streamIndex}:${auth.timestamp}`
      );
      const messageLegacy = new TextEncoder().encode(
        `withdraw:${auth.streamIndex}:${auth.timestamp}`
      );
      try {
        const signature = new Uint8Array(auth.signature);
        const isValid =
          ed25519.verify(signature, messagePreferred, workerPubkey.toBytes()) ||
          ed25519.verify(signature, messageLegacy, workerPubkey.toBytes());
        if (!isValid) {
          log(`Withdraw relay skip: invalid Ed25519 signature stream=${auth.streamIndex} ts=${auth.timestamp}`);
          await markWithdrawFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, "invalid_signature");
          continue;
        }
      } catch (err: any) {
        log(`Withdraw relay skip: signature verification error stream=${auth.streamIndex} ts=${auth.timestamp}`);
        await markWithdrawFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, "signature_error");
        continue;
      }

      const [businessPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('business'), businessOwner.toBuffer()],
        PROGRAM_ID,
      );
      const streamConfigPda = deriveStreamConfigPda(businessPda);
      const streamPda = deriveEmployeeStreamPda(businessPda, auth.streamIndex);

      // We only need to provide withdraw_request_v2 and system_program.
      const [withdrawRequestPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('withdraw_request_v2'),
          businessPda.toBuffer(),
          new Uint8Array(new BigUint64Array([BigInt(auth.streamIndex)]).buffer),
        ],
        PROGRAM_ID
      );

      const streamIndexBuf = Buffer.alloc(8);
      streamIndexBuf.writeBigUInt64LE(BigInt(auth.streamIndex));

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },    // keeper
          { pubkey: businessPda, isSigner: false, isWritable: false },      // business
          { pubkey: streamConfigPda, isSigner: false, isWritable: false },  // stream_config_v2
          { pubkey: streamPda, isSigner: false, isWritable: false },        // employee_stream (CHECK, can be delegated)
          { pubkey: withdrawRequestPda, isSigner: false, isWritable: true }, // withdraw_request_v2
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        programId: PROGRAM_ID,
        data: Buffer.concat([
          KEEPER_REQUEST_WITHDRAW_V2_DISC,
          streamIndexBuf,
        ]),
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      // Use base-layer RPC (readConnection) — MagicBlock Router doesn't serve reliable blockhashes for non-delegated txs
      tx.recentBlockhash = (await readConnection.getLatestBlockhash()).blockhash;
      tx.sign(payer);
      const sig = await readConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await readConnection.confirmTransaction(sig, 'confirmed');

      await markWithdrawCompleted(auth.businessOwner, auth.streamIndex, auth.timestamp, sig);
      log(`✅ Withdraw request relayed stream=${auth.streamIndex} ts=${auth.timestamp} tx=${sig}`);
    } catch (e: any) {
      const reason = e?.message || 'unknown';
      await markWithdrawFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, reason);
      log(`Withdraw relay failed stream=${auth.streamIndex} ts=${auth.timestamp} reason=${reason}`);
    }
  }
}

async function processViewRelays(): Promise<void> {
  if (!ENABLE_VIEW_RELAY) return;
  const batch = await getPendingViewAuths(10);
  if (batch.length === 0) return;

  log(`Processing ${batch.length} view logic relay authorization(s) from DB`);

  for (const auth of batch) {
    try {
      const businessOwner = new PublicKey(auth.businessOwner);
      const workerPubkey = new PublicKey(auth.workerPubkey);

      const messageStr = `view:${auth.streamIndex}:${auth.timestamp}`;
      const message = new TextEncoder().encode(messageStr);
      try {
        const isValid = ed25519.verify(new Uint8Array(auth.signature), message, workerPubkey.toBytes());
        if (!isValid) {
          log(`View relay skip: invalid Ed25519 signature stream=${auth.streamIndex} ts=${auth.timestamp}`);
          await markViewFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, "invalid_signature");
          continue;
        }
      } catch (err: any) {
        log(`View relay skip: signature verification error stream=${auth.streamIndex} ts=${auth.timestamp}`);
        await markViewFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, "signature_error");
        continue;
      }

      const [businessPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('business'), businessOwner.toBuffer()],
        PROGRAM_ID,
      );
      const streamConfigPda = deriveStreamConfigPda(businessPda);
      const streamPda = deriveEmployeeStreamPda(businessPda, auth.streamIndex);

      // Load stream to get handles for allowance PDA derivation
      const streamInfo = await txConnection.getAccountInfo(streamPda);
      if (!streamInfo) {
        await markViewFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, "stream_not_found");
        continue;
      }

      const salaryHandleBytes = streamInfo.data.slice(112, 128);
      const accruedHandleBytes = streamInfo.data.slice(144, 160);

      const [salaryAllowanceAccount] = PublicKey.findProgramAddressSync(
        [salaryHandleBytes, workerPubkey.toBuffer()],
        INCO_LIGHTNING_ID
      );
      const [accruedAllowanceAccount] = PublicKey.findProgramAddressSync(
        [accruedHandleBytes, workerPubkey.toBuffer()],
        INCO_LIGHTNING_ID
      );

      const streamIndexBuf = Buffer.alloc(8);
      streamIndexBuf.writeBigUInt64LE(BigInt(auth.streamIndex));

      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: businessPda, isSigner: false, isWritable: false },
          { pubkey: streamConfigPda, isSigner: false, isWritable: false },
          { pubkey: streamPda, isSigner: false, isWritable: false },
          { pubkey: workerPubkey, isSigner: false, isWritable: false },
          { pubkey: salaryAllowanceAccount, isSigner: false, isWritable: true },
          { pubkey: accruedAllowanceAccount, isSigner: false, isWritable: true },
          { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          GRANT_EMPLOYEE_VIEW_ACCESS_V2_DISC,
          streamIndexBuf,
        ]),
      });

      // Use base-layer RPC (readConnection) — MagicBlock Router doesn't serve reliable blockhashes for non-delegated txs
      const recentBlockhash = await readConnection.getLatestBlockhash();
      const messageObj = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: recentBlockhash.blockhash,
        instructions: [ix]
      }).compileToV0Message();
      const tx = new VersionedTransaction(messageObj);
      tx.sign([payer]);

      const sig = await readConnection.sendTransaction(tx, { maxRetries: 3 });
      await readConnection.confirmTransaction({
        signature: sig,
        ...recentBlockhash
      });

      log(`✅ View relay completed stream=${auth.streamIndex} tx=${sig}`);
      await markViewCompleted(auth.businessOwner, auth.streamIndex, auth.timestamp, sig);
    } catch (e: any) {
      const reason = e?.message || 'unknown transaction error';
      log(`View relay failed stream=${auth.streamIndex} reason=${reason}`);
      await markViewFailed(auth.businessOwner, auth.streamIndex, auth.timestamp, reason);
    }
  }
}

async function processTick(): Promise<void> {
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
      recordTick();
    } else {
      const selected = requests.slice(0, DEFAULT_MAX_STREAMS_PER_TICK);
      const results = await Promise.all(
        selected.map(async (request) => {
          const jitter = Math.floor(Math.random() * DEFAULT_JITTER_MS);
          await sleep(jitter);
          try {
            await processWithdrawRequest(request);
            return { ok: true as const };
          } catch (e: any) {
            const reason = e?.message || 'withdraw request processing failed';
            await deadLetterWithdrawRequest('withdraw_request_error', request, reason);
            await sendAlertWithdrawRequest('withdraw_request_error', request, reason);
            log(`Withdraw request failed request=${request.address.toBase58()} reason=${reason}`);
            return { ok: false as const, reason, request: request.address.toBase58() };
          }
        })
      );

      const failed = results.filter((r) => !r.ok);
      if (failed.length === selected.length) {
        // Do not trip the global circuit breaker on per-request failures.
        // Keep processing in future ticks; operator can inspect dead-letter logs.
        log(`Tick all_requests_failed total=${selected.length}`);
      } else {
        if (failed.length > 0) {
          log(`Tick partial_success failed_requests=${failed.length} total_requests=${selected.length}`);
        }
        consecutiveFailures = 0;
        recordTick();
      }
    }

    // Phase 2: Process any pending claim relay authorizations
    try {
      await processClaimRelays();
    } catch (e: any) {
      log(`Claim relay processing failed: ${e?.message || 'unknown'}`);
    }

    // Phase 3: Process any pending withdraw request authorizations (Ghost Mode)
    try {
      await processWithdrawRelays();
    } catch (e: any) {
      log(`Withdraw relay processing failed: ${e?.message || 'unknown'}`);
    }

    // Phase 4: Process any pending view authorizations (disabled by default in strict privacy mode)
    if (ENABLE_VIEW_RELAY) {
      try {
        await processViewRelays();
      } catch (e: any) {
        log(`View relay processing failed: ${e?.message || 'unknown'}`);
      }
    }

    // Phase 5: Sweepers
    try {
      await processRevocations();
    } catch (e: any) {
      log(`Revocation sweeper failed: ${e?.message || 'unknown'}`);
    }

    // Phase 6: Auto-claim sweep (disabled by default for privacy-first 2-hop flow)
    if (AUTO_CLAIM_SWEEP_ENABLED) {
      try {
        await autoClaimUnclaimedPayouts();
      } catch (e: any) {
        log(`Auto-claim sweep failed: ${e?.message || 'unknown'}`);
      }
    }

  } catch (e: any) {
    consecutiveFailures += 1;
    recordFailure();
    log(`Tick failed failures=${consecutiveFailures} reason=${e?.message || 'unknown error'}`);
  } finally {
    tickInProgress = false;
  }
}

// ============================================================
// Auto-Claim Sweep: find unclaimed ShieldedPayoutV2 and claim them
// ============================================================

const SHIELDED_PAYOUT_V2_DISCRIMINATOR = Buffer.from([154, 229, 205, 213, 206, 30, 155, 114]);
const autoClaimIdempotency = new Set<string>();

async function autoClaimUnclaimedPayouts(): Promise<void> {
  // Scan for all ShieldedPayoutV2 accounts belonging to our program
  // bs58 v6 is ESM-only; use base64 encoding instead for memcmp filter
  const accounts = await readConnection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: SHIELDED_PAYOUT_V2_DISCRIMINATOR.toString('base64'), encoding: 'base64' as any } },
    ],
  });

  const now = Math.floor(Date.now() / 1000);
  let claimedCount = 0;

  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);

    const claimed = data[120] === 1;
    const cancelled = data[121] === 1;
    const expiresAt = Number(data.readBigInt64LE(130));

    // Skip already claimed, cancelled, or expired payouts
    if (claimed || cancelled) continue;
    if (expiresAt > 0 && now > expiresAt) continue;

    const business = new PublicKey(data.subarray(8, 40));
    const streamIndex = Number(data.readBigUInt64LE(40));
    const nonce = Number(data.readBigUInt64LE(48));
    const payoutTokenAccount = new PublicKey(data.subarray(138, 170));
    const bump = data[170];

    const idempotencyKey = `${streamIndex}:${nonce}`;
    if (autoClaimIdempotency.has(idempotencyKey)) continue;

    // Find the employee stream to get the destination token account
    const employeePda = deriveEmployeeStreamPda(business, streamIndex);
    const streamInfo = await readConnection.getAccountInfo(employeePda, 'confirmed');
    if (!streamInfo) {
      log(`[auto-claim-sweep] Skip: stream not found stream=${streamIndex} nonce=${nonce}`);
      continue;
    }

    // EmployeeStreamV2 layout: disc(8) + business(32) + stream_index(8) + employee_auth_hash(32) + destination_route_commitment(32)
    const destinationRouteCommitment = Buffer.from(
      streamInfo.data.subarray(8 + 32 + 8 + 32, 8 + 32 + 8 + 32 + 32)
    );
    if (isAllZero32(destinationRouteCommitment)) {
      log(`[auto-claim-sweep] Skip: no fixed destination route stream=${streamIndex} nonce=${nonce}`);
      autoClaimIdempotency.add(idempotencyKey);
      continue;
    }
    const employeeTokenAccount = new PublicKey(destinationRouteCommitment);

    const shieldedPayoutPda = pubkey;

    try {
      await retry(`auto-claim-sweep stream=${streamIndex} nonce=${nonce}`, () =>
        sendKeeperClaimOnBehalf(
          business,
          streamIndex,
          nonce,
          shieldedPayoutPda,
          payoutTokenAccount,
          employeeTokenAccount,
          0,
        )
      );
      autoClaimIdempotency.add(idempotencyKey);
      claimedCount++;
      log(`✅ Auto-claim sweep: claimed stream=${streamIndex} nonce=${nonce} → ${employeeTokenAccount.toBase58()}`);
    } catch (e: any) {
      autoClaimIdempotency.add(idempotencyKey); // don't retry same payout forever
      log(`[auto-claim-sweep] Failed stream=${streamIndex} nonce=${nonce}: ${e?.message || 'unknown'}`);
    }
  }

  if (claimedCount > 0) {
    log(`Auto-claim sweep: claimed ${claimedCount} payout(s)`);
  }
}

async function hydrateDelegationStateOnStartup(): Promise<void> {
  undelegateInFlight.clear();

  log('Startup hydration skipped (withdraw-request mode)');
}

async function deadLetter(kind: string, stream: EmployeeStreamV2Record, reason: string): Promise<void> {
  const record = {
    kind,
    time: new Date().toISOString(),
    stream: stream.address.toBase58(),
    business: stream.business.toBase58(),
    streamIndex: stream.streamIndex,
    reason,
  };

  const dir = path.dirname(DEAD_LETTER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(DEAD_LETTER_FILE, `${JSON.stringify(record)}\n`);
}

async function deadLetterWithdrawRequest(
  kind: string,
  request: WithdrawRequestV2Record,
  reason: string
): Promise<void> {
  const record = {
    kind,
    time: new Date().toISOString(),
    request: request.address.toBase58(),
    business: request.business.toBase58(),
    streamIndex: request.streamIndex,
    requesterAuthHash: authHashHex(request.requesterAuthHash),
    requestedAt: request.requestedAt,
    reason,
  };

  const dir = path.dirname(DEAD_LETTER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(DEAD_LETTER_FILE, `${JSON.stringify(record)}\n`);
}

async function sendAlert(kind: string, stream: EmployeeStreamV2Record, reason: string): Promise<void> {
  if (!ALERT_WEBHOOK_URL || !fetchAny) return;

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
  } catch (e: any) {
    log(`Alert webhook failed: ${e?.message || 'unknown error'}`);
  }
}

async function sendAlertWithdrawRequest(
  kind: string,
  request: WithdrawRequestV2Record,
  reason: string
): Promise<void> {
  if (!ALERT_WEBHOOK_URL || !fetchAny) return;

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
        requesterAuthHash: authHashHex(request.requesterAuthHash),
        requestedAt: request.requestedAt,
        reason,
      }),
    });
  } catch (e: any) {
    log(`Alert webhook failed: ${e?.message || 'unknown error'}`);
  }
}

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[keeper ${ts}] ${message}`);
}

async function syncOnChainKeeperConfig(): Promise<void> {
  const businessOwnerRaw = (process.env.KEEPER_BUSINESS_OWNER || '').trim();
  if (!businessOwnerRaw) {
    log('Automated Sync: KEEPER_BUSINESS_OWNER not set skip.');
    return;
  }

  try {
    const owner = new PublicKey(businessOwnerRaw);
    const [businessPDA] = PublicKey.findProgramAddressSync(
      [BUSINESS_SEED, owner.toBuffer()],
      PROGRAM_ID
    );
    const [streamConfigPDA] = PublicKey.findProgramAddressSync(
      [STREAM_CONFIG_V2_SEED, businessPDA.toBuffer()],
      PROGRAM_ID
    );

    // Use a fresh connection for the on-chain presence check.
    const checkConnection = new Connection('https://api.devnet.solana.com', 'confirmed');
    const configInfo = await checkConnection.getAccountInfo(streamConfigPDA);
    if (!configInfo) {
      log('Automated Sync: Stream config record not found on-chain skip.');
      return;
    }

    // keeper_pubkey is at offset 8 (after discriminator) + 32 (business pubkey) = 40
    const onChainKeeper = new PublicKey(configInfo.data.slice(40, 72));
    const localKeeper = payer.publicKey;

    if (onChainKeeper.equals(localKeeper)) {
      log('Automated Sync: Keeper identity is already synchronized on-chain.');
      return;
    }

    log(`Automated Sync: Identity mismatch detected (On-chain: ${onChainKeeper.toBase58()}, Active: ${localKeeper.toBase58()}). Synchronizing...`);

    const data = Buffer.concat([UPDATE_KEEPER_V2_DISC, localKeeper.toBuffer()]);
    const instruction = new TransactionInstruction({
      keys: [
        { pubkey: localKeeper, isSigner: true, isWritable: true }, // authority (Signer)
        { pubkey: businessPDA, isSigner: false, isWritable: false },
        { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const { blockhash } = await readConnection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: localKeeper,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([payer]);

    const txid = await txConnection.sendTransaction(tx);
    log(`Automated Sync: Success! Transaction sent: ${txid}`);
    
    // Wait for confirmation to ensure it's picked up before ticker starts
    await readConnection.confirmTransaction(txid, 'confirmed');
    log('Automated Sync: Transaction confirmed.');
  } catch (e: any) {
    log(`Automated Sync: Failed with error: ${e?.message || 'unknown'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  log('Keeper service starting');
  startHealthServer();
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
  log(`View relay: ${ENABLE_VIEW_RELAY ? 'enabled' : 'disabled (strict privacy default)'}`);
  log(
    `Privacy payout route: mode=${PRIVACY_PAYOUT_ROUTE_MODE} ` +
      `umbra_configured=${UMBRA_ROUTE_CONFIGURED ? 'yes' : 'no'}`
  );
  log(`Umbra signed-claim forwarding: ${UMBRA_FORWARD_SIGNED_CLAIM ? 'enabled' : 'disabled'}`);
  if (UMBRA_RELAY_URL) {
    log(`Umbra relay host: ${hostFromUrl(UMBRA_RELAY_URL)}`);
  }
  if (UMBRA_FORWARD_URL) {
    log(`Umbra forward host: ${hostFromUrl(UMBRA_FORWARD_URL)}`);
  }
  if (UMBRA_POOL_ID) {
    log(`Umbra pool id: ${UMBRA_POOL_ID}`);
  }
  magicCommitSupported = await detectMagicCommitSupport();
  log(`Magic commit support on read RPC: ${magicCommitSupported ? 'available' : 'unavailable'}`);
  try {
    await hydrateDelegationStateOnStartup();
  } catch (e: any) {
    log(`Startup hydration failed reason=${e?.message || 'unknown error'}`);
  }

  try {
    await connectQueue();
  } catch (e: any) {
    log(`Failed to connect to MongoDB queue: ${e?.message}`);
  }

  // DEEP-LEVEL FIX: Autonomous Heartbeat Sync
  // Check if this keeper's identity matches the on-chain registration for the company.
  // If not, use the new contract permission to "claim" the role automatically.
  await syncOnChainKeeperConfig();

  await processTick();
  setInterval(() => {
    void processTick();
  }, DEFAULT_TICK_SECS * 1000);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
