/**
 * Payroll Program Client (v2)
 *
 * Integrates with the deployed Confidential Streaming Payroll program.
 * Program ID: 3P3tYHEUykB2fH5vxpunHQH3C7zi9B3fFXyzaRP38bJn
 *
 * Architecture:
 * - Business PDA: ["business", owner_pubkey]
 * - Vault PDA: ["vault", business_pubkey]
 * - Employee Stream PDA: ["employee_v2", business_pubkey, stream_index (u64)]
 *
 * Features:
 * - Register business with confidential vault
 * - Deposit encrypted tokens to vault via CPI
 * - v2 private real-time streaming with MagicBlock TEE
 * - Withdraw request + keeper settlement
 * - Deactivate individual streams
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { encryptValue } from '@inco/solana-sdk/encryption';
import { hexToBuffer } from '@inco/solana-sdk/utils';

// ============================================================
// Program IDs (from env with fallbacks)
// ============================================================

// NOTE: Hardcoded to the current deploy since it rarely changes,
// but can be overridden by environment variables.
export const PAYROLL_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '3P3tYHEUykB2fH5vxpunHQH3C7zi9B3fFXyzaRP38bJn'
);

export const INCO_LIGHTNING_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
);

export const INCO_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID || '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N'
);

export const PAYUSD_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_PAYUSD_MINT || 'GhCZ59UK4Afg4WGpQ11HyRc8ya4swgWFXMh2BxuWQXHt'
);

// MagicBlock Delegation Program
export const MAGICBLOCK_DELEGATION_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM || 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
);

// MagicBlock core scheduling program + global context
export const MAGICBLOCK_MAGIC_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM || 'Magic11111111111111111111111111111111111111'
);

export const MAGICBLOCK_MAGIC_CONTEXT = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT || 'MagicContext1111111111111111111111111111111'
);

// Default devnet ER validator (EU). Override via NEXT_PUBLIC_MAGICBLOCK_VALIDATOR.
export const TEE_VALIDATOR = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'
);

// MagicBlock devnet TEE identity (token-gated endpoint). Avoid using this as a default.
export const MAGICBLOCK_TEE_VALIDATOR_IDENTITY = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_VALIDATOR || 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'
);

export type MagicblockValidatorRegion = 'eu' | 'us' | 'asia';

function optionalPublicKey(raw: string | undefined): PublicKey | null {
  const value = (raw || '').trim();
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

const MAGICBLOCK_VALIDATOR_US =
  optionalPublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_US);
const MAGICBLOCK_VALIDATOR_ASIA =
  optionalPublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_ASIA) ||
  optionalPublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_AS);

export function isMagicblockValidatorRegionAvailable(
  region: MagicblockValidatorRegion
): boolean {
  if (region === 'eu') return true;
  if (region === 'us') return MAGICBLOCK_VALIDATOR_US !== null;
  return MAGICBLOCK_VALIDATOR_ASIA !== null;
}

export function getMagicblockValidatorForRegion(
  region: MagicblockValidatorRegion
): PublicKey {
  if (region === 'us') return MAGICBLOCK_VALIDATOR_US || TEE_VALIDATOR;
  if (region === 'asia') return MAGICBLOCK_VALIDATOR_ASIA || TEE_VALIDATOR;
  return TEE_VALIDATOR;
}

export function getIncoAllowancePda(handleValue: bigint, allowedAddress: PublicKey): PublicKey {
  // Inco Lightning allowance PDA seeds: [handle_u128_le_16, allowed_address]
  const handleBuf = Buffer.alloc(16);
  let h = handleValue;
  for (let i = 0; i < 16; i += 1) {
    handleBuf[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  const [pda] = PublicKey.findProgramAddressSync([handleBuf, allowedAddress.toBuffer()], INCO_LIGHTNING_ID);
  return pda;
}

/**
 * Check if an Inco decrypt allowance is stale (missing on-chain).
 * Returns true if the allowance PDA does NOT exist — meaning access needs to be re-granted.
 */
export async function checkAllowanceStale(
  connection: Connection,
  handleValue: bigint,
  allowedAddress: PublicKey
): Promise<boolean> {
  if (handleValue === 0n) return false; // handle not initialized yet
  const pda = getIncoAllowancePda(handleValue, allowedAddress);
  try {
    const info = await connection.getAccountInfo(pda, 'confirmed');
    return info === null; // stale if account doesn't exist
  } catch {
    return true; // assume stale on error
  }
}

// ============================================================
// Demo Environment Addresses (from env)
// ============================================================

export function getDemoAddresses() {
  return {
    businessPDA: process.env.NEXT_PUBLIC_PAYROLL_BUSINESS_PDA
      ? new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_BUSINESS_PDA)
      : null,
    vaultPDA: process.env.NEXT_PUBLIC_PAYROLL_VAULT_PDA
      ? new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_VAULT_PDA)
      : null,
    vaultToken: process.env.NEXT_PUBLIC_PAYROLL_VAULT_TOKEN
      ? new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_VAULT_TOKEN)
      : null,
    employeePDA: process.env.NEXT_PUBLIC_PAYROLL_EMPLOYEE_PDA
      ? new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_EMPLOYEE_PDA)
      : null,
    employeeToken: process.env.NEXT_PUBLIC_PAYROLL_EMPLOYEE_TOKEN
      ? new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_EMPLOYEE_TOKEN)
      : null,
  };
}

// ============================================================
// PDA Seeds (matching on-chain program)
// ============================================================

const BUSINESS_SEED = Buffer.from('business');
const VAULT_SEED = Buffer.from('vault');

const VAULT_TOKEN_SEED = Buffer.from('vault_token');
const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');
const WITHDRAW_REQUEST_V2_SEED = Buffer.from('withdraw_request_v2');
const SHIELDED_PAYOUT_V2_SEED = Buffer.from('shielded_payout');
const RATE_HISTORY_V2_SEED = Buffer.from('rate_history_v2');
const BUFFER_SEED = Buffer.from('buffer');
const DELEGATION_SEED = Buffer.from('delegation');
const DELEGATION_METADATA_SEED = Buffer.from('delegation-metadata');

const FALLBACK_READ_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || 'https://api.devnet.solana.com';
const RPC_READ_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_RPC_READ_TIMEOUT_MS || '20000');
// Compliance is disabled by default (especially for devnet/local). Enable explicitly via env.
const COMPLIANCE_ENABLED = (process.env.NEXT_PUBLIC_COMPLIANCE_ENABLED ?? 'false') === 'true';

let fallbackReadConnection: Connection | null = null;

function getFallbackReadConnection(): Connection {
  if (!fallbackReadConnection) {
    fallbackReadConnection = new Connection(FALLBACK_READ_RPC_URL, 'confirmed');
  }
  return fallbackReadConnection;
}

function isAccountNotFoundRpcError(error: unknown): boolean {
  const message = String(error ?? '');
  return message.includes('AccountNotFound');
}

async function getAccountInfoWithFallback(
  connection: Connection,
  address: PublicKey
) {
  try {
    return await withTimeout(
      connection.getAccountInfo(address),
      RPC_READ_TIMEOUT_MS,
      `Reading account ${address.toBase58()}`
    );
  } catch (primaryError) {
    if (connection.rpcEndpoint === FALLBACK_READ_RPC_URL) {
      if (isAccountNotFoundRpcError(primaryError)) {
        return null;
      }
      throw primaryError;
    }

    try {
      return await withTimeout(
        getFallbackReadConnection().getAccountInfo(address),
        RPC_READ_TIMEOUT_MS,
        `Reading fallback account ${address.toBase58()}`
      );
    } catch (fallbackError) {
      if (isAccountNotFoundRpcError(fallbackError) || isAccountNotFoundRpcError(primaryError)) {
        return null;
      }
      throw fallbackError;
    }
  }
}

// ============================================================
// Instruction Discriminators (Anchor-style sha256)
// ============================================================

function disc(bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

const DISCRIMINATORS = {
  // Setup
  register_business: disc([73, 228, 5, 59, 229, 67, 133, 82]),
  init_vault: disc([77, 79, 85, 150, 33, 217, 52, 106]),
  rotate_vault_token_account: disc([229, 88, 174, 100, 140, 129, 2, 213]),

  // Operations
  deposit: disc([242, 35, 198, 137, 82, 225, 242, 182]),
  admin_withdraw_vault_v2: disc([107, 78, 201, 164, 14, 202, 112, 10]),

  // v2 real-time private payroll
  init_stream_config_v2: disc([189, 68, 68, 47, 176, 124, 45, 106]),
  update_keeper_v2: disc([52, 172, 105, 244, 89, 165, 39, 71]),
  add_employee_stream_v2: disc([159, 218, 122, 103, 242, 71, 89, 240]),
  delegate_stream_v2: disc([149, 221, 59, 171, 243, 25, 232, 241]),
  accrue_v2: disc([109, 173, 74, 232, 133, 35, 206, 149]),
  auto_settle_stream_v2: disc([220, 231, 109, 26, 242, 148, 211, 2]),
  commit_and_undelegate_stream_v2: disc([221, 72, 242, 203, 64, 158, 195, 242]),
  redelegate_stream_v2: disc([231, 62, 146, 164, 236, 234, 43, 88]),
  deactivate_stream_v2: disc([18, 228, 219, 116, 117, 114, 136, 3]),
  pause_stream_v2: disc([77, 162, 53, 254, 80, 88, 242, 76]),
  resume_stream_v2: disc([57, 120, 86, 179, 230, 106, 181, 161]),
  init_rate_history_v2: disc([199, 217, 121, 94, 112, 222, 26, 240]),
  update_salary_rate_v2: disc([188, 52, 12, 49, 104, 111, 100, 100]),
  grant_bonus_v2: disc([24, 176, 4, 187, 122, 90, 99, 9]),

  // v2 withdraw request (EWA pull model)
  request_withdraw_v2: disc([177, 251, 0, 3, 73, 86, 101, 32]),
  process_withdraw_request_v2: disc([128, 150, 154, 174, 215, 145, 233, 234]),

  // Inco access control (view permission)
  grant_employee_view_access_v2: disc([201, 191, 208, 133, 117, 221, 125, 147]),
  grant_keeper_view_access_v2: disc([60, 78, 33, 123, 183, 61, 107, 58]),

  // Phase 2: Shielded payout
  claim_payout_v2: disc([173, 130, 104, 210, 0, 178, 203, 83]),
  cancel_expired_payout_v2: disc([97, 13, 123, 62, 246, 36, 146, 99]),

  // Phase 2: Programmable viewing policies + keeper-relayed claims
  revoke_view_access_v2: disc([79, 190, 166, 170, 246, 184, 119, 163]),
  grant_auditor_view_access_v2: disc([169, 70, 78, 218, 59, 114, 203, 200]),
  keeper_claim_on_behalf_v2: disc([161, 194, 33, 127, 138, 221, 153, 84]),
};

// ============================================================
// PDA Derivation Functions
// ============================================================

/**
 * Derive Business PDA
 * Seeds: ["business", owner_pubkey]
 */
export function getBusinessPDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BUSINESS_SEED, owner.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive Vault PDA
 * Seeds: ["vault", business_pubkey]
 */
export function getVaultPDA(business: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, business.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive Vault Token Account PDA
 * Seeds: ["vault_token", vault_pubkey]
 */
export function getVaultTokenPDA(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_SEED, vault.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive v2 stream config PDA
 * Seeds: ["stream_config_v2", business_pubkey]
 */
export function getStreamConfigV2PDA(business: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STREAM_CONFIG_V2_SEED, business.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive v2 employee stream PDA
 * Seeds: ["employee_v2", business_pubkey, stream_index (u64 LE)]
 */
export function getEmployeeStreamV2PDA(business: PublicKey, streamIndex: number): [PublicKey, number] {
  const streamIndexBuffer = Buffer.alloc(8);
  streamIndexBuffer.writeBigUInt64LE(BigInt(streamIndex));
  return PublicKey.findProgramAddressSync(
    [EMPLOYEE_V2_SEED, business.toBuffer(), streamIndexBuffer],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive v2 withdraw request PDA
 * Seeds: ["withdraw_request_v2", business_pubkey, stream_index (u64 LE)]
 */
export function getWithdrawRequestV2PDA(business: PublicKey, streamIndex: number): [PublicKey, number] {
  const streamIndexBuffer = Buffer.alloc(8);
  streamIndexBuffer.writeBigUInt64LE(BigInt(streamIndex));
  return PublicKey.findProgramAddressSync(
    [WITHDRAW_REQUEST_V2_SEED, business.toBuffer(), streamIndexBuffer],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive v2 rate history PDA
 * Seeds: ["rate_history_v2", business_pubkey, stream_index (u64 LE)]
 */
export function getRateHistoryV2PDA(business: PublicKey, streamIndex: number): [PublicKey, number] {
  const streamIndexBuffer = Buffer.alloc(8);
  streamIndexBuffer.writeBigUInt64LE(BigInt(streamIndex));
  return PublicKey.findProgramAddressSync(
    [RATE_HISTORY_V2_SEED, business.toBuffer(), streamIndexBuffer],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive v2 shielded payout PDA
 * Seeds: ["shielded_payout", business_pubkey, stream_index (u64 LE), nonce (u64 LE)]
 */
export function getShieldedPayoutV2PDA(business: PublicKey, streamIndex: number, nonce: number): [PublicKey, number] {
  const streamIndexBuffer = Buffer.alloc(8);
  streamIndexBuffer.writeBigUInt64LE(BigInt(streamIndex));
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SHIELDED_PAYOUT_V2_SEED, business.toBuffer(), streamIndexBuffer, nonceBuffer],
    PAYROLL_PROGRAM_ID
  );
}

/**
 * Derive required delegation PDAs for v2 delegate/redelegate flow.
 */
export function getV2DelegationPDAs(employeeStream: PublicKey): {
  bufferPDA: PublicKey;
  delegationRecordPDA: PublicKey;
  delegationMetadataPDA: PublicKey;
} {
  const [bufferPDA] = PublicKey.findProgramAddressSync(
    [BUFFER_SEED, employeeStream.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
  const [delegationRecordPDA] = PublicKey.findProgramAddressSync(
    [DELEGATION_SEED, employeeStream.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM
  );
  const [delegationMetadataPDA] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_SEED, employeeStream.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM
  );

  return { bufferPDA, delegationRecordPDA, delegationMetadataPDA };
}

// ============================================================
// Account Data Parsing
// ============================================================

/**
 * Parse Business account data
 */
export interface BusinessAccount {
  address: PublicKey;
  owner: PublicKey;
  vault: PublicKey;
  nextEmployeeIndex: number;
  encryptedEmployeeCount: Uint8Array;
  isActive: boolean;
  createdAt: number;
  bump: number;
}

export async function getBusinessAccount(
  connection: Connection,
  owner: PublicKey
): Promise<BusinessAccount | null> {
  const [businessPDA] = getBusinessPDA(owner);
  const accountInfo = await getAccountInfoWithFallback(connection, businessPDA);

  if (!accountInfo) {
    return null;
  }

  // Parse account data
  // Business struct layout:
  // 0-8: discriminator
  // 8-40: owner (32)
  // 40-72: vault (32)
  // 72-80: next_employee_index (u64)
  // 80-112: encrypted_employee_count (32)
  // 112: is_active (1)
  // 113-121: created_at (i64)
  // 121: bump (1)
  const data = accountInfo.data;

  return {
    address: businessPDA,
    owner: new PublicKey(data.slice(8, 40)),
    vault: new PublicKey(data.slice(40, 72)),
    nextEmployeeIndex: Number(data.readBigUInt64LE(72)),
    encryptedEmployeeCount: data.slice(80, 112),
    isActive: data[112] === 1,
    createdAt: Number(data.readBigInt64LE(113)),
    bump: data[121],
  };
}

/**
 * Parse Vault account data
 */
export interface VaultAccount {
  address: PublicKey;
  business: PublicKey;
  mint: PublicKey;
  tokenAccount: PublicKey;
  encryptedBalance: Uint8Array;
  bump: number;
}

export async function getVaultAccount(
  connection: Connection,
  business: PublicKey
): Promise<VaultAccount | null> {
  const [vaultPDA] = getVaultPDA(business);
  const accountInfo = await getAccountInfoWithFallback(connection, vaultPDA);

  if (!accountInfo) {
    return null;
  }

  // Vault struct layout:
  // 0-8: discriminator
  // 8-40: business (32)
  // 40-72: mint (32)
  // 72-104: token_account (32)
  // 104-136: encrypted_balance (32)
  // 136: bump (1)
  const data = accountInfo.data;

  return {
    address: vaultPDA,
    business: new PublicKey(data.slice(8, 40)),
    mint: new PublicKey(data.slice(40, 72)),
    tokenAccount: new PublicKey(data.slice(72, 104)),
    encryptedBalance: data.slice(104, 136),
    bump: data[136],
  };
}


/**
 * Parse v2 BusinessStreamConfig account
 */
export interface BusinessStreamConfigV2Account {
  address: PublicKey;
  business: PublicKey;
  keeperPubkey: PublicKey;
  settleIntervalSecs: number;
  nextStreamIndex: number;
  isPaused: boolean;
  pauseReason: number;
  bump: number;
}

export async function getBusinessStreamConfigV2Account(
  connection: Connection,
  business: PublicKey
): Promise<BusinessStreamConfigV2Account | null> {
  const [streamConfigPDA] = getStreamConfigV2PDA(business);
  const accountInfo = await getAccountInfoWithFallback(connection, streamConfigPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  return {
    address: streamConfigPDA,
    business: new PublicKey(data.slice(8, 40)),
    keeperPubkey: new PublicKey(data.slice(40, 72)),
    settleIntervalSecs: Number(data.readBigUInt64LE(72)),
    nextStreamIndex: Number(data.readBigUInt64LE(80)),
    isPaused: data[88] === 1,
    pauseReason: data[89],
    bump: data[90],
  };
}

/**
 * Parse v2 EmployeeStream account
 */
export interface EmployeeStreamV2Account {
  address: PublicKey;
  owner: PublicKey;
  business: PublicKey;
  streamIndex: number;
  employeeAuthHash: Uint8Array;
  destinationRouteCommitment: Uint8Array;
  hasFixedDestination: boolean;
  employeeTokenAccount: PublicKey;
  encryptedSalaryRate: Uint8Array;
  encryptedAccrued: Uint8Array;
  lastAccrualTime: number;
  lastSettleTime: number;
  isActive: boolean;
  isDelegated: boolean;
  isDelegatedFlag: boolean;
  bump: number;
  /** Pay period start (unix timestamp). 0 = unbounded. */
  periodStart: number;
  /** Pay period end (unix timestamp). 0 = unbounded. */
  periodEnd: number;
}

export async function getEmployeeStreamV2Account(
  connection: Connection,
  business: PublicKey,
  streamIndex: number
): Promise<EmployeeStreamV2Account | null> {
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(business, streamIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, employeeStreamPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  const isDelegatedFlag = data[193] === 1;
  const isDelegatedByOwner = accountInfo.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM);
  const destinationRouteCommitment = data.slice(80, 112);
  const hasFixedDestination = destinationRouteCommitment.some((b) => b !== 0);
  return {
    address: employeeStreamPDA,
    owner: accountInfo.owner,
    business: new PublicKey(data.slice(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    employeeAuthHash: data.slice(48, 80),
    destinationRouteCommitment,
    hasFixedDestination,
    employeeTokenAccount: hasFixedDestination
      ? new PublicKey(destinationRouteCommitment)
      : PublicKey.default,
    encryptedSalaryRate: data.slice(112, 144),
    encryptedAccrued: data.slice(144, 176),
    lastAccrualTime: Number(data.readBigInt64LE(176)),
    lastSettleTime: Number(data.readBigInt64LE(184)),
    isActive: data[192] === 1,
    isDelegated: isDelegatedFlag || isDelegatedByOwner,
    isDelegatedFlag,
    bump: data[194],
    periodStart: Number(data.readBigInt64LE(195)),
    periodEnd: Number(data.readBigInt64LE(203)),
  };
}

/**
 * Parse v2 WithdrawRequest account
 */
export interface WithdrawRequestV2Account {
  address: PublicKey;
  business: PublicKey;
  streamIndex: number;
  requesterAuthHash: Uint8Array;
  requestedAt: number;
  isPending: boolean;
  bump: number;
}

export interface RateHistoryEntryV2 {
  effectiveAt: number;
  salaryHandleValue: bigint;
  salaryHandle: string; // decimal string for Inco attested decrypt
}

export interface RateHistoryV2Account {
  address: PublicKey;
  business: PublicKey;
  streamIndex: number;
  count: number;
  bump: number;
  entries: RateHistoryEntryV2[];
}

function readU128LEFrom32(handle32: Buffer): bigint {
  const b = handle32.subarray(0, 16);
  let out = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    out = out * 256n + BigInt(b[i] || 0);
  }
  return out;
}

export async function getRateHistoryV2Account(
  connection: Connection,
  business: PublicKey,
  streamIndex: number
): Promise<RateHistoryV2Account | null> {
  const [rateHistoryPDA] = getRateHistoryV2PDA(business, streamIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, rateHistoryPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // 0-8 discriminator
  // 8-40 business
  // 40-48 stream_index (u64)
  // 48 count (u8)
  // 49 bump (u8)
  // 50-56 reserved
  // 56.. entries (16 * (i64 + [u8;32]))
  const count = data[48];
  const bump = data[49];
  const entries: RateHistoryEntryV2[] = [];
  const max = Math.min(Number(count), 16);
  let off = 56;
  for (let i = 0; i < max; i += 1) {
    const effectiveAt = Number(data.readBigInt64LE(off));
    off += 8;
    const handle32 = Buffer.from(data.subarray(off, off + 32));
    off += 32;
    const salaryHandleValue = readU128LEFrom32(handle32);
    entries.push({
      effectiveAt,
      salaryHandleValue,
      salaryHandle: salaryHandleValue.toString(),
    });
  }

  return {
    address: rateHistoryPDA,
    business: new PublicKey(data.slice(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    count,
    bump,
    entries,
  };
}

export async function getWithdrawRequestV2Account(
  connection: Connection,
  business: PublicKey,
  streamIndex: number
): Promise<WithdrawRequestV2Account | null> {
  const [withdrawRequestPDA] = getWithdrawRequestV2PDA(business, streamIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, withdrawRequestPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // WithdrawRequestV2 layout:
  // 0-8: discriminator
  // 8-40: business (32)
  // 40-48: stream_index (u64)
  // 48-80: requester_auth_hash (32)
  // 80-88: requested_at (i64)
  // 88: is_pending (u8)
  // 89: bump (u8)
  return {
    address: withdrawRequestPDA,
    business: new PublicKey(data.slice(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    requesterAuthHash: data.slice(48, 80),
    requestedAt: Number(data.readBigInt64LE(80)),
    isPending: data[88] === 1,
    bump: data[89],
  };
}

// ============================================================
// Transaction Helpers
// ============================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} timed out after ${Math.ceil(ms / 1000)}s. If Phantom is waiting, open the extension and approve/reject the pending request.`
        )
      );
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function sendAndConfirmTransaction(
  connection: Connection,
  wallet: WalletContextState,
  instruction: TransactionInstruction,
  label: string = 'transaction'
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected');
  }

  const transaction = new Transaction().add(instruction);
  console.log(`[sendAndConfirm] Fetching latest blockhash for: ${label}`);
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    20_000,
    'Fetching latest blockhash'
  );
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;

  console.log(`[sendAndConfirm] Waiting for signature: ${label}`);
  const signed = await withTimeout(wallet.signTransaction(transaction), 90_000, 'Waiting for Phantom signature');

  console.log(`[sendAndConfirm] Submitting transaction: ${label}`);
  const txid = await withTimeout(
    connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false, // Enable preflight to catch errors early
      maxRetries: 3,
    }),
    30_000,
    'Submitting transaction'
  );

  console.log(`[sendAndConfirm] Confirming transaction: ${txid} (${label})`);
  const confirmation = await withTimeout(
    connection.confirmTransaction(
      {
        blockhash,
        lastValidBlockHeight,
        signature: txid,
      },
      'confirmed'
    ),
    90_000,
    `Confirming transaction ${txid}`
  );

  // Check if transaction actually succeeded
  if (confirmation.value.err) {
    console.error('Transaction failed on-chain:', confirmation.value.err);
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return txid;
}

// ============================================================
// Encryption Helpers
// ============================================================

/**
 * Encrypt a value for Inco FHE
 */
async function encryptForInco(value: bigint): Promise<Buffer> {
  const encryptedHex = await encryptValue(value);
  return hexToBuffer(encryptedHex);
}

/**
 * Hash a pubkey to create encrypted employee ID
 */
async function hashPubkeyForEmployeeId(pubkey: PublicKey): Promise<Buffer> {
  const pubkeyBuffer = pubkey.toBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(pubkeyBuffer));
  return Buffer.from(hashBuffer).slice(0, 32);
}

// ============================================================
// Setup Instructions
// ============================================================

/**
 * Register a new business
 * Creates Business PDA for the owner
 */
export async function registerBusiness(
  connection: Connection,
  wallet: WalletContextState
): Promise<{ txid: string; businessPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);

  // Check if already registered
  const existing = await getAccountInfoWithFallback(connection, businessPDA);
  if (existing) {
    throw new Error('Business already registered');
  }

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: DISCRIMINATORS.register_business,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, businessPDA };
}

/**
 * Initialize the business vault
 * Creates Vault PDA and links to Inco Token account
 *
 * Note: The Inco Token account must be created externally first,
 * with the vault PDA as the owner.
 */
export async function initVault(
  connection: Connection,
  wallet: WalletContextState,
  vaultTokenAccount: PublicKey,
  mint: PublicKey = PAYUSD_MINT
): Promise<{ txid: string; vaultPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [vaultPDA] = getVaultPDA(businessPDA);

  // Verify business exists
  const businessAccount = await getAccountInfoWithFallback(connection, businessPDA);
  if (!businessAccount) {
    throw new Error('Business not registered. Please register first.');
  }

  // Build instruction data: discriminator + mint (32) + vault_token_account (32)
  const data = Buffer.concat([
    DISCRIMINATORS.init_vault,
    mint.toBuffer(),
    vaultTokenAccount.toBuffer(),
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, vaultPDA };
}

/**
 * Rotate/update the vault's mint + token account.
 *
 * Fixes "MintMismatch: Account not associated with this Mint" when your vault was
 * initialized against an old mint/token-account.
 */
export async function rotateVaultTokenAccount(
  connection: Connection,
  wallet: WalletContextState,
  newVaultTokenAccount: PublicKey,
  newMint: PublicKey = PAYUSD_MINT
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [vaultPDA] = getVaultPDA(businessPDA);

  // Instruction data: discriminator + new_mint (32)
  const data = Buffer.concat([DISCRIMINATORS.rotate_vault_token_account, newMint.toBuffer()]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: newVaultTokenAccount, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

// ============================================================
// Vault Token Account Creation
// ============================================================

// Inco Confidential Token: initialize_account discriminator (Anchor sha256("global:initialize_account")[0..8])
const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);

/**
 * Create an Inco Confidential Token account for a given owner.
 *
 * The payer is the connected wallet. The token account itself is a new keypair
 * that signs only for initialization; the *owner* is the authority that can
 * later spend from this token account.
 */
export async function createIncoTokenAccount(
  connection: Connection,
  wallet: WalletContextState,
  owner: PublicKey,
  mint: PublicKey = PAYUSD_MINT
): Promise<{ txid: string; tokenAccount: PublicKey }> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected');
  }

  // Generate a new keypair for the token account address.
  const tokenAccountKeypair = Keypair.generate();

  const instruction = new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccountKeypair.publicKey, isSigner: true, isWritable: true }, // token_account
      { pubkey: mint, isSigner: false, isWritable: false }, // mint
      { pubkey: owner, isSigner: false, isWritable: false }, // owner (authority)
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
  });

  const transaction = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    connection.getLatestBlockhash('confirmed'),
    20_000,
    'Fetching latest blockhash'
  );
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;

  // Sign with both wallet and the new token account keypair.
  transaction.partialSign(tokenAccountKeypair);
  const signed = await withTimeout(
    wallet.signTransaction(transaction),
    90_000,
    'Waiting for Phantom signature'
  );

  const txid = await withTimeout(
    connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    }),
    30_000,
    'Submitting transaction'
  );

  const confirmation = await withTimeout(
    connection.confirmTransaction(
      {
        blockhash,
        lastValidBlockHeight,
        signature: txid,
      },
      'confirmed'
    ),
    90_000,
    `Confirming transaction ${txid}`
  );

  if (confirmation.value.err) {
    throw new Error(`Token account creation failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return { txid, tokenAccount: tokenAccountKeypair.publicKey };
}

/**
 * Create Inco Token account for vault (automatic setup)
 *
 * This creates a new Inco Token account owned by the vault PDA.
 * The user pays for account creation but doesn't need vault PDA to sign.
 *
 * @returns The new token account public key
 */
export async function createVaultTokenAccount(
  connection: Connection,
  wallet: WalletContextState,
  vaultPDA: PublicKey,
  mint: PublicKey = PAYUSD_MINT
): Promise<{ txid: string; tokenAccount: PublicKey }> {
  return createIncoTokenAccount(connection, wallet, vaultPDA, mint);
}

// ============================================================
// Deposit Instruction
// ============================================================

/**
 * Deposit encrypted tokens to business vault
 *
 * PRIVACY: Amount is encrypted using Inco FHE
 */
export async function deposit(
  connection: Connection,
  wallet: WalletContextState,
  depositorTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  amount: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [vaultPDA] = getVaultPDA(businessPDA);

  // Verify business and vault exist
  const business = await getBusinessAccount(connection, wallet.publicKey);
  if (!business) {
    throw new Error('Business not registered');
  }

  // Encrypt amount (9 decimals)
  const amountLamports = BigInt(Math.floor(amount * 1_000_000_000));
  const encryptedAmount = await encryptForInco(amountLamports);

  // Build instruction data: discriminator + encrypted_amount (Vec<u8>)
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(encryptedAmount.length);
  const data = Buffer.concat([DISCRIMINATORS.deposit, lengthBytes, encryptedAmount]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Owner-only admin withdrawal of unused funds from vault.
 *
 * Transfers encrypted amount from vault token account to destination token account.
 */
export async function adminWithdrawVaultV2(
  connection: Connection,
  wallet: WalletContextState,
  destinationTokenAccount: PublicKey,
  amount: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [vaultPDA] = getVaultPDA(businessPDA);

  // Verify business and vault exist
  const business = await getBusinessAccount(connection, wallet.publicKey);
  if (!business) {
    throw new Error('Business not registered');
  }
  const vault = await getVaultAccount(connection, businessPDA);
  if (!vault) {
    throw new Error('Vault not initialized');
  }

  // Encrypt amount (9 decimals)
  const amountLamports = BigInt(Math.floor(amount * 1_000_000_000));
  const encryptedAmount = await encryptForInco(amountLamports);

  // Build instruction data: discriminator + encrypted_amount (Vec<u8>)
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(encryptedAmount.length);
  const data = Buffer.concat([DISCRIMINATORS.admin_withdraw_vault_v2, lengthBytes, encryptedAmount]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: vault.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

// ============================================================
// Employee Management
// ============================================================

/**
 * Add an employee with encrypted salary rate
 *
 * PRIVACY: Uses INDEX-based PDA derivation - no employee pubkey on-chain!
 *
 * @param employeeWallet - Employee's wallet (hashed and encrypted, not stored directly)
 * @param salaryRatePerSecond - Salary per second in Confidential Token (encrypted)
 */

// ============================================================
// v2 Private Real-Time Payroll
// ============================================================

/**
 * Fail-closed compliance screening used for v2 create/activate flow.
 */
async function requireRangeCompliance(address: string): Promise<void> {
  if (!COMPLIANCE_ENABLED) {
    return;
  }

  const { rangeClient } = await import('./range');

  if (!rangeClient.isConfigured()) {
    throw new Error('Range API key is required for v2 fail-closed compliance policy');
  }

  let compliance;
  try {
    compliance = await rangeClient.fullComplianceCheckFailClosed(address);
  } catch (error: any) {
    throw new Error(`Compliance check unavailable for ${address}: ${error?.message || 'unknown error'}`);
  }

  if (!compliance.isCompliant) {
    throw new Error(
      `Compliance check failed for ${address} (risk=${compliance.riskScore}, blacklisted=${compliance.isBlacklisted}, ofac=${compliance.isOFACSanctioned})`
    );
  }
}

/**
 * Compute 32-byte auth hash for employee wallet.
 */
export async function hashEmployeeAuthV2(employeeWallet: PublicKey): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(employeeWallet.toBytes()));
  return new Uint8Array(digest).slice(0, 32);
}

/**
 * Init v2 stream config for a business.
 */
export async function initStreamConfigV2(
  connection: Connection,
  wallet: WalletContextState,
  keeperPubkey: PublicKey,
  settleIntervalSecs: number = 10
): Promise<{ txid: string; streamConfigPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);

  const existing = await getAccountInfoWithFallback(connection, streamConfigPDA);
  if (existing) {
    throw new Error('v2 stream config already initialized');
  }

  const intervalBuf = Buffer.alloc(8);
  intervalBuf.writeBigUInt64LE(BigInt(settleIntervalSecs));
  const data = Buffer.concat([
    DISCRIMINATORS.init_stream_config_v2,
    keeperPubkey.toBuffer(),
    intervalBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, streamConfigPDA };
}

/**
 * Rotate keeper wallet for an existing v2 stream config.
 * Requires business owner signature.
 */
export async function updateKeeperV2(
  connection: Connection,
  wallet: WalletContextState,
  keeperPubkey: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);

  const existing = await getAccountInfoWithFallback(connection, streamConfigPDA);
  if (!existing) {
    throw new Error('v2 stream config not initialized');
  }

  const data = Buffer.concat([DISCRIMINATORS.update_keeper_v2, keeperPubkey.toBuffer()]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Add a v2 employee stream.
 * Pass `PublicKey.default` as `employeeTokenAccount` for privacy mode
 * (no fixed destination in stream state; destination is provided at claim-time).
 * Enforces fail-closed compliance checks before stream creation.
 */
export async function addEmployeeStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  employeeWallet: PublicKey,
  employeeTokenAccount: PublicKey,
  salaryRatePerSecond: number,
  /** Pay period start (unix timestamp). 0 = unbounded (legacy). */
  periodStart: number = 0,
  /** Pay period end (unix timestamp). 0 = unbounded (legacy). */
  periodEnd: number = 0
): Promise<{ txid: string; employeeStreamPDA: PublicKey; streamIndex: number; employeeAuthHash: Uint8Array }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  if (!employeeTokenAccount.equals(PublicKey.default)) {
    throw new Error('Direct worker destination is disabled. Use private shield route.');
  }

  await requireRangeCompliance(wallet.publicKey.toBase58());
  await requireRangeCompliance(employeeWallet.toBase58());

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const streamConfig = await getBusinessStreamConfigV2Account(connection, businessPDA);

  if (!streamConfig) {
    throw new Error('v2 stream config not initialized');
  }
  if (streamConfig.isPaused) {
    throw new Error(`v2 stream config is paused (reason=${streamConfig.pauseReason})`);
  }

  const streamIndex = streamConfig.nextStreamIndex;
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const employeeAuthHash = await hashEmployeeAuthV2(employeeWallet);
  const salaryLamports = BigInt(Math.floor(salaryRatePerSecond * 1_000_000_000));
  const encryptedSalary = await encryptForInco(salaryLamports);

  const salaryLen = Buffer.alloc(4);
  salaryLen.writeUInt32LE(encryptedSalary.length);

  // Serialize period_start and period_end as i64 LE.
  const periodStartBuf = Buffer.alloc(8);
  periodStartBuf.writeBigInt64LE(BigInt(periodStart));
  const periodEndBuf = Buffer.alloc(8);
  periodEndBuf.writeBigInt64LE(BigInt(periodEnd));

  const data = Buffer.concat([
    DISCRIMINATORS.add_employee_stream_v2,
    Buffer.from(employeeAuthHash),
    employeeTokenAccount.toBuffer(),
    salaryLen,
    encryptedSalary,
    periodStartBuf,
    periodEndBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, employeeStreamPDA, streamIndex, employeeAuthHash };
}

export async function initRateHistoryV2(
  connection: Connection,
  wallet: WalletContextState,
  streamIndex: number
): Promise<{ txid: string; rateHistoryPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const [rateHistoryPDA] = getRateHistoryV2PDA(businessPDA, streamIndex);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const data = Buffer.concat([DISCRIMINATORS.init_rate_history_v2, streamIndexBuf]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: rateHistoryPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, rateHistoryPDA };
}

export async function updateSalaryRateV2(
  connection: Connection,
  wallet: WalletContextState,
  streamIndex: number,
  salaryRatePerSecond: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const [rateHistoryPDA] = getRateHistoryV2PDA(businessPDA, streamIndex);

  const salaryLamports = BigInt(Math.floor(salaryRatePerSecond * 1_000_000_000));
  const encryptedSalary = await encryptForInco(salaryLamports);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(encryptedSalary.length);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.update_salary_rate_v2,
    streamIndexBuf,
    lenBuf,
    encryptedSalary,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: rateHistoryPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // unused, kept for parity with program accounts
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export async function grantBonusV2(
  connection: Connection,
  wallet: WalletContextState,
  streamIndex: number,
  bonusAmount: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const bonusLamports = BigInt(Math.floor(bonusAmount * 1_000_000_000));
  const encryptedBonus = await encryptForInco(bonusLamports);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(encryptedBonus.length);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.grant_bonus_v2,
    streamIndexBuf,
    lenBuf,
    encryptedBonus,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // unused, kept for parity with program accounts
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Delegate v2 stream account to a MagicBlock ER validator (EU/US/Asia recommended on devnet).
 */
export async function delegateStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  validator: PublicKey = TEE_VALIDATOR
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  await requireRangeCompliance(wallet.publicKey.toBase58());
  if (validator.equals(MAGICBLOCK_TEE_VALIDATOR_IDENTITY)) {
    throw new Error(
      'TEE validator is token-gated on devnet (tee.magicblock.app). Use EU/US/Asia ER validator identity instead.'
    );
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV2DelegationPDAs(employeeStreamPDA);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }
  if (!stream.isActive) {
    throw new Error(`v2 employee stream ${streamIndex} is inactive`);
  }
  if (stream.isDelegated) {
    throw new Error(`v2 employee stream ${streamIndex} already delegated`);
  }

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.delegate_stream_v2,
    streamIndexBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: bufferPDA, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: validator, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PAYROLL_PROGRAM_ID, isSigner: false, isWritable: false }, // owner_program
      { pubkey: MAGICBLOCK_DELEGATION_PROGRAM, isSigner: false, isWritable: false }, // delegation_program
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Keeper accrual step for v2 stream.
 */
export async function accrueV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV2DelegationPDAs(employeeStreamPDA);
  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.accrue_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export interface AutoSettleV2Params {
  businessOwner: PublicKey;
  streamIndex: number;
  magicContext?: PublicKey;
  magicProgram?: PublicKey;
}

/**
 * Keeper settle step for v2 stream.
 */
export async function autoSettleStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  params: AutoSettleV2Params
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(params.businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [vaultPDA] = getVaultPDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, params.streamIndex);

  const business = await getBusinessAccount(connection, params.businessOwner);
  if (!business) {
    throw new Error('Business not found');
  }
  const vault = await getVaultAccount(connection, businessPDA);
  if (!vault) {
    throw new Error('Vault not initialized');
  }
  const stream = await getEmployeeStreamV2Account(connection, businessPDA, params.streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${params.streamIndex} not found`);
  }
  if (!stream.hasFixedDestination) {
    throw new Error('This payroll record uses claim-time destination privacy mode; auto-settle is disabled.');
  }

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(params.streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: vault.tokenAccount, isSigner: false, isWritable: true },
      { pubkey: stream.employeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: params.magicProgram || MAGICBLOCK_MAGIC_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: params.magicContext || MAGICBLOCK_MAGIC_CONTEXT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.auto_settle_stream_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Commit pending delegated state and undelegate stream back to base layer.
 */
export async function commitAndUndelegateStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  magicContext: PublicKey = MAGICBLOCK_MAGIC_CONTEXT
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }
  if (!stream.isDelegated) {
    throw new Error(`v2 employee stream ${streamIndex} is not delegated`);
  }

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_MAGIC_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: magicContext, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.commit_and_undelegate_stream_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Re-delegate a v2 stream after settlement commit.
 */
export async function redelegateStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  validator: PublicKey = TEE_VALIDATOR
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  if (validator.equals(MAGICBLOCK_TEE_VALIDATOR_IDENTITY)) {
    throw new Error(
      'TEE validator is token-gated on devnet (tee.magicblock.app). Use EU/US/Asia ER validator identity instead.'
    );
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV2DelegationPDAs(employeeStreamPDA);
  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: bufferPDA, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
      { pubkey: validator, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PAYROLL_PROGRAM_ID, isSigner: false, isWritable: false }, // owner_program
      { pubkey: MAGICBLOCK_DELEGATION_PROGRAM, isSigner: false, isWritable: false }, // delegation_program
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.redelegate_stream_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Grant the employee wallet permission to decrypt salary/accrued handles (Inco allow).
 *
 * This lets the employee use attested decrypt in the UI. It creates/updates two allowance PDAs:
 * one for salary handle, one for accrued handle.
 */
export async function grantEmployeeViewAccessV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  employeeWallet: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }

  const handles = getEmployeeStreamV2DecryptHandles(stream);
  const salaryHandleValue = handles.salaryHandleValue;
  const accruedHandleValue = handles.accruedHandleValue;
  const salaryAllowance = getIncoAllowancePda(salaryHandleValue, employeeWallet);
  const accruedAllowance = getIncoAllowancePda(accruedHandleValue, employeeWallet);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: false }, // stream (read-only)
      { pubkey: employeeWallet, isSigner: false, isWritable: false }, // allowed address
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: accruedAllowance, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.grant_employee_view_access_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Grant the configured keeper permission to decrypt the salary-rate handle (Inco allow).
 *
 * This is required for the real-world op model where:
 * - business owner key is cold
 * - keeper is an always-online hot key
 *
 * NOTE: We only grant access to the salary-rate handle (not accrued) because the keeper uses the
 * rate-only withdraw computation on devnet for reliability.
 */
export async function grantKeeperViewAccessV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  keeperWallet: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }

  const handles = getEmployeeStreamV2DecryptHandles(stream);
  const salaryHandleValue = handles.salaryHandleValue;
  const salaryAllowance = getIncoAllowancePda(salaryHandleValue, keeperWallet);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: false }, // stream (read-only)
      { pubkey: keeperWallet, isSigner: false, isWritable: false }, // allowed keeper address
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.grant_keeper_view_access_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Employee requests a v2 withdraw (withdraw-all). Keeper buffers payout in a shielded PDA.
 * Final destination is chosen at claim-time.
 */
export async function requestWithdrawV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);
  const [withdrawRequestPDA] = getWithdrawRequestV2PDA(businessPDA, streamIndex);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // employee_signer
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: false }, // can be delegated
      { pubkey: withdrawRequestPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.request_withdraw_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Pause all v2 streams for a business.
 * reason: 1 manual, 2 compliance
 */
export async function pauseStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  reason: 1 | 2
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const data = Buffer.concat([
    DISCRIMINATORS.pause_stream_v2,
    Buffer.from([reason]),
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Resume all v2 streams for a business.
 */
export async function resumeStreamV2(
  connection: Connection,
  wallet: WalletContextState
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: DISCRIMINATORS.resume_stream_v2,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Deactivate a single v2 employee stream.
 *
 * Owner-only. Sets is_active = false on the stream to stop accrual.
 * Stream must be undelegated (on base layer) before deactivation.
 */
export async function deactivateStreamV2(
  connection: Connection,
  wallet: WalletContextState,
  streamIndex: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(wallet.publicKey);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.deactivate_stream_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Get the next employee index from a business
 */
export async function getNextEmployeeIndex(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  const business = await getBusinessAccount(connection, owner);
  if (!business) {
    throw new Error('Business not registered');
  }
  return business.nextEmployeeIndex;
}

/**
 * Check if a business is registered
 */
export async function isBusinessRegistered(
  connection: Connection,
  owner: PublicKey
): Promise<boolean> {
  const [businessPDA] = getBusinessPDA(owner);
  const accountInfo = await getAccountInfoWithFallback(connection, businessPDA);
  return accountInfo !== null;
}

/**
 * Check if vault is initialized
 */
export async function isVaultInitialized(
  connection: Connection,
  owner: PublicKey
): Promise<boolean> {
  const business = await getBusinessAccount(connection, owner);
  if (!business) return false;
  return !business.vault.equals(PublicKey.default);
}

// ============================================================
// Explorer Link Utilities (OrbMarkets only)
// ============================================================

/**
 * Generate OrbMarkets explorer link for a transaction
 *
 * IMPORTANT: Use only OrbMarkets - no Solscan/Sol Explorer
 */
export function getExplorerTxLink(signature: string, cluster: 'devnet' | 'mainnet-beta' = 'devnet'): string {
  return `https://orbmarkets.io/tx/${signature}?cluster=${cluster}`;
}

/**
 * Generate OrbMarkets explorer link for an account
 */
export function getExplorerAccountLink(address: string | PublicKey, cluster: 'devnet' | 'mainnet-beta' = 'devnet'): string {
  const addressStr = typeof address === 'string' ? address : address.toBase58();
  return `https://orbmarkets.io/account/${addressStr}?cluster=${cluster}`;
}

// ============================================================
// Conversion Utilities
// ============================================================

export function tokenToLamports(amount: number): bigint {
  return BigInt(Math.floor(amount * 1_000_000_000));
}

export function lamportsToToken(lamports: bigint): number {
  return Number(lamports) / 1_000_000_000;
}

/**
 * Calculate salary per second from monthly rate
 */
export function monthlyToPerSecond(monthlyRate: number): number {
  // Assume 30 days per month
  const secondsPerMonth = 30 * 24 * 60 * 60;
  return monthlyRate / secondsPerMonth;
}

/**
 * Calculate monthly from per-second rate
 */
export function perSecondToMonthly(perSecond: number): number {
  const secondsPerMonth = 30 * 24 * 60 * 60;
  return perSecond * secondsPerMonth;
}



// ============================================================
// Employee Encrypted Data Extraction
// ============================================================



export interface EmployeeStreamV2DecryptHandles {
  accruedHandle: string;
  salaryHandle: string;
  accruedHandleValue: bigint;
  salaryHandleValue: bigint;
}

export function getEmployeeStreamV2DecryptHandles(
  stream: EmployeeStreamV2Account
): EmployeeStreamV2DecryptHandles {
  const accruedBytes = stream.encryptedAccrued.slice(0, 16);
  const salaryBytes = stream.encryptedSalaryRate.slice(0, 16);

  let accrued = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    accrued = accrued * BigInt(256) + BigInt(accruedBytes[i]);
  }

  let salary = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    salary = salary * BigInt(256) + BigInt(salaryBytes[i]);
  }

  return {
    accruedHandle: accrued.toString(),
    salaryHandle: salary.toString(),
    accruedHandleValue: accrued,
    salaryHandleValue: salary,
  };
}

// ============================================================
// Phase 2: Shielded Payout (Claim Flow)
// ============================================================

export interface ShieldedPayoutV2Account {
  address: PublicKey;
  business: PublicKey;
  streamIndex: number;
  nonce: number;
  employeeAuthHash: Uint8Array;
  encryptedAmount: Uint8Array;
  claimed: boolean;
  cancelled: boolean;
  createdAt: number;
  expiresAt: number;
  payoutTokenAccount: PublicKey;
  bump: number;
}

/**
 * Fetch and parse a ShieldedPayoutV2 account.
 * Returns null if the account doesn't exist.
 */
export async function getShieldedPayoutV2Account(
  connection: Connection,
  business: PublicKey,
  streamIndex: number,
  nonce: number
): Promise<ShieldedPayoutV2Account | null> {
  const [payoutPDA] = getShieldedPayoutV2PDA(business, streamIndex, nonce);
  const accountInfo = await getAccountInfoWithFallback(connection, payoutPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // ShieldedPayoutV2 layout:
  // 0-8: discriminator
  // 8-40: business (32)
  // 40-48: stream_index (u64)
  // 48-56: nonce (u64)
  // 56-88: employee_auth_hash (32)
  // 88-120: encrypted_amount (EncryptedHandle = 32)
  // 120: claimed (u8)
  // 121: cancelled (u8)
  // 122-130: created_at (i64)
  // 130-138: expires_at (i64)
  // 138-170: payout_token_account (32)
  // 170: bump (u8)
  return {
    address: payoutPDA,
    business: new PublicKey(data.slice(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    nonce: Number(data.readBigUInt64LE(48)),
    employeeAuthHash: data.slice(56, 88),
    encryptedAmount: data.slice(88, 120),
    claimed: data[120] === 1,
    cancelled: data[121] === 1,
    createdAt: Number(data.readBigInt64LE(122)),
    expiresAt: Number(data.readBigInt64LE(130)),
    payoutTokenAccount: new PublicKey(data.slice(138, 170)),
    bump: data[170],
  };
}

// ShieldedPayoutV2 account discriminator: sha256("account:ShieldedPayoutV2")[0..8]
const SHIELDED_PAYOUT_V2_DISCRIMINATOR = Buffer.from([154, 229, 205, 213, 206, 30, 155, 114]);

/**
 * Parse raw account data into a ShieldedPayoutV2Account.
 */
function parseShieldedPayoutV2(address: PublicKey, data: Buffer): ShieldedPayoutV2Account {
  return {
    address,
    business: new PublicKey(data.slice(8, 40)),
    streamIndex: Number(data.readBigUInt64LE(40)),
    nonce: Number(data.readBigUInt64LE(48)),
    employeeAuthHash: data.slice(56, 88),
    encryptedAmount: data.slice(88, 120),
    claimed: data[120] === 1,
    cancelled: data[121] === 1,
    createdAt: Number(data.readBigInt64LE(122)),
    expiresAt: Number(data.readBigInt64LE(130)),
    payoutTokenAccount: new PublicKey(data.slice(138, 170)),
    bump: data[170],
  };
}

/**
 * Auto-detect all pending (unclaimed, uncancelled, not expired) payouts for a worker.
 * Uses getProgramAccounts with memcmp filters on discriminator + business.
 * Client-side verifies SHA-256(worker) matches the employee_auth_hash.
 */
export async function getPendingPayoutsForWorker(
  connection: Connection,
  business: PublicKey,
  workerWallet: PublicKey,
): Promise<ShieldedPayoutV2Account[]> {
  // Compute worker's auth hash client-side.
  const workerDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(workerWallet.toBytes()));
  const workerAuthHash = new Uint8Array(workerDigest);

  // Filter: discriminator at offset 0 + business pubkey at offset 8.
  const accounts = await connection.getProgramAccounts(PAYROLL_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SHIELDED_PAYOUT_V2_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: business.toBase58() } },
    ],
  });

  const now = Math.floor(Date.now() / 1000);
  const pending: ShieldedPayoutV2Account[] = [];

  for (const { pubkey, account } of accounts) {
    const payout = parseShieldedPayoutV2(pubkey, account.data as Buffer);

    // Skip already claimed or cancelled.
    if (payout.claimed || payout.cancelled) continue;

    // Skip expired.
    if (payout.expiresAt > 0 && now > payout.expiresAt) continue;

    // Verify auth hash matches this worker.
    const hashMatch = workerAuthHash.length === payout.employeeAuthHash.length &&
      workerAuthHash.every((b, i) => b === payout.employeeAuthHash[i]);
    if (!hashMatch) continue;

    pending.push(payout);
  }

  // Sort by creation time (newest first).
  pending.sort((a, b) => b.createdAt - a.createdAt);
  return pending;
}
/**
 * Worker claims a shielded payout (Hop 2 of 2-hop).
 * ShieldedPayoutV2 PDA signs the transfer from payout_token_account to claimer.
 * NO vault or employer accounts in this tx = full metadata break.
 */
export async function claimPayoutV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  nonce: number,
  payoutTokenAccount: PublicKey,
  claimerTokenAccount: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [shieldedPayoutPDA] = getShieldedPayoutV2PDA(businessPDA, streamIndex, nonce);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },   // claimer
      { pubkey: businessPDA, isSigner: false, isWritable: false },      // business
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: true }, // shielded_payout
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },// payout_token_account
      { pubkey: claimerTokenAccount, isSigner: false, isWritable: true }, // claimer_token_account
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.claim_payout_v2, streamIndexBuf, nonceBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

// ============================================================
// Phase 2: Programmable Viewing Policies
// ============================================================

/**
 * Revoke decrypt access for a wallet on a stream's salary + accrued handles.
 * Only the business owner can call this.
 */
export async function revokeViewAccessV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  targetWallet: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }

  const handles = getEmployeeStreamV2DecryptHandles(stream);
  const salaryAllowance = getIncoAllowancePda(handles.salaryHandleValue, targetWallet);
  const accruedAllowance = getIncoAllowancePda(handles.accruedHandleValue, targetWallet);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: false },
      { pubkey: targetWallet, isSigner: false, isWritable: false },
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: accruedAllowance, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.revoke_view_access_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Grant an auditor wallet read-only access to salary + accrued handles.
 * Only the business owner can call this.
 */
export async function grantAuditorViewAccessV2(
  connection: Connection,
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  auditorWallet: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [businessPDA] = getBusinessPDA(businessOwner);
  const [streamConfigPDA] = getStreamConfigV2PDA(businessPDA);
  const [employeeStreamPDA] = getEmployeeStreamV2PDA(businessPDA, streamIndex);

  const stream = await getEmployeeStreamV2Account(connection, businessPDA, streamIndex);
  if (!stream) {
    throw new Error(`v2 employee stream ${streamIndex} not found`);
  }

  const handles = getEmployeeStreamV2DecryptHandles(stream);
  const salaryAllowance = getIncoAllowancePda(handles.salaryHandleValue, auditorWallet);
  const accruedAllowance = getIncoAllowancePda(handles.accruedHandleValue, auditorWallet);

  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPDA, isSigner: false, isWritable: false },
      { pubkey: auditorWallet, isSigner: false, isWritable: false },
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: accruedAllowance, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.grant_auditor_view_access_v2, streamIndexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

// ============================================================
// Phase 2: Keeper-Relayed Claims
// ============================================================

/**
 * Worker signs an off-chain claim authorization message.
 * Returns the signed message and signature for the keeper to submit on-chain.
 *
 * Message format (preferred):
 * "claim:<businessOwner>:<streamIndex>:<nonce>:<expiry>:<destinationTokenAccount>"
 */
export async function signClaimAuthorization(
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  nonce: number,
  destinationTokenAccount: PublicKey,
  expiry: number = 0
): Promise<{ message: Uint8Array; signature: Uint8Array; publicKey: PublicKey }> {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error('Wallet not connected or does not support signMessage');
  }

  const messageStr = `claim:${businessOwner.toBase58()}:${streamIndex}:${nonce}:${expiry}:${destinationTokenAccount.toBase58()}`;
  const message = new TextEncoder().encode(messageStr);
  const signature = await wallet.signMessage(message);

  return {
    message,
    signature,
    publicKey: wallet.publicKey,
  };
}

/**
 * Worker signs an off-chain withdrawal request authorization message (Ghost Mode).
 * Returns the signed message and signature for the keeper to submit on-chain.
 *
 * Message format: "withdraw:<businessOwner>:<streamIndex>:<timestamp>"
 */
export async function signWithdrawAuthorization(
  wallet: WalletContextState,
  businessOwner: PublicKey,
  streamIndex: number,
  timestamp: number
): Promise<{ message: Uint8Array; signature: Uint8Array; publicKey: PublicKey }> {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error('Wallet not connected or does not support signMessage');
  }

  const messageStr = `withdraw:${businessOwner.toBase58()}:${streamIndex}:${timestamp}`;
  const message = new TextEncoder().encode(messageStr);
  const signature = await wallet.signMessage(message);

  return {
    message,
    signature,
    publicKey: wallet.publicKey,
  };
}
