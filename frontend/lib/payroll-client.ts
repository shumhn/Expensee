/**
 * Payroll Program Client (v4 – Pooled Vault)
 *
 * Integrates with the deployed Confidential Streaming Payroll program.
 * Program ID: 97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU
 *
 * Architecture:
 * - Business PDA: ["business", owner_pubkey]
 * - Vault PDA: ["vault", business_pubkey]
 * - Employee PDA: ["employee_v4", business_pubkey, employee_index (u64)]
 *
 * Features:
 * - Register business with confidential vault
 * - Deposit encrypted tokens to vault via CPI
 * - v4 pooled vault private streaming with MagicBlock TEE
 * - Withdraw request + keeper settlement
 * - Deactivate individual streams
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, AccountInfo } from '@solana/web3.js';
import { WalletContextState } from '@solana/wallet-adapter-react';
import bs58 from 'bs58';
import { encryptValue } from '@inco/solana-sdk/encryption';
import { hexToBuffer } from '@inco/solana-sdk/utils';
import { createMagicBlockClient } from './magicblock';

if (typeof Buffer !== 'undefined') {
  if (!Buffer.prototype.writeBigUInt64LE) {
    Buffer.prototype.writeBigUInt64LE = function (value: bigint, offset = 0) {
      const low = Number(value & 0xffffffffn);
      const high = Number((value >> 32n) & 0xffffffffn);
      this.writeUInt32LE(low, offset);
      this.writeUInt32LE(high, offset + 4);
      return offset + 8;
    };
  }
  if (!Buffer.prototype.writeBigInt64LE) {
    Buffer.prototype.writeBigInt64LE = function (value: bigint, offset = 0) {
      const unsigned = value < 0n ? value + 18446744073709551616n : value;
      return this.writeBigUInt64LE(unsigned, offset);
    };
  }
  if (!Buffer.prototype.readBigUInt64LE) {
    Buffer.prototype.readBigUInt64LE = function (offset = 0) {
      const low = BigInt(this.readUInt32LE(offset));
      const high = BigInt(this.readUInt32LE(offset + 4));
      return (high << 32n) + low;
    };
  }
  if (!Buffer.prototype.readBigInt64LE) {
    Buffer.prototype.readBigInt64LE = function (offset = 0) {
      const val = this.readBigUInt64LE(offset);
      return val >= 9223372036854775808n ? val - 18446744073709551616n : val;
    };
  }
}

// ============================================================
// Program IDs (from env with fallbacks)
// ============================================================

// NOTE: Hardcoded to the current deploy since it rarely changes,
// but can be overridden by environment variables.
export const PAYROLL_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU'
);

export const INCO_LIGHTNING_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
);

// Backwards-compatible alias used across the app.
export const INCO_PROGRAM_ID = INCO_LIGHTNING_ID;

export const INCO_TOKEN_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID || '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N'
);

export const CONFIDENTIAL_USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT ||
  process.env.NEXT_PUBLIC_PAYUSD_MINT ||
  'GhCZ59UK4Afg4WGpQ11HyRc8ya4swgWFXMh2BxuWQXHt'
);

// Backwards-compatible alias used across the app.
export const PAYUSD_MINT = CONFIDENTIAL_USDC_MINT;

// MagicBlock Delegation Program
export const MAGICBLOCK_DELEGATION_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM || 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
);

// MagicBlock Permission Program (ACL)
export const MAGICBLOCK_PERMISSION_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_PERMISSION_PROGRAM || 'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1'
);

// MagicBlock core scheduling program + global context
export const MAGICBLOCK_MAGIC_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM || 'Magic11111111111111111111111111111111111111'
);

export const MAGICBLOCK_MAGIC_CONTEXT = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT || 'MagicContext1111111111111111111111111111111'
);

// MagicBlock Magic Router Program
export const MAGICBLOCK_MAGIC_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM_ID || 'Magic11111111111111111111111111111111111111'
);

// Default devnet ER validator (EU). Override via NEXT_PUBLIC_MAGICBLOCK_VALIDATOR.
export const TEE_VALIDATOR = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'
);

// MagicBlock devnet TEE identity (token-gated endpoint). Avoid using this as a default.
export const MAGICBLOCK_TEE_VALIDATOR_IDENTITY = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_VALIDATOR || 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'
);
const MAGICBLOCK_TEE_ENABLED = process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED === 'true';
const MAGICBLOCK_TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL || 'https://tee.magicblock.app';
const TEE_MODE_STORAGE_KEY = 'expensee_tee_mode_v4';
const TEE_TOKEN_STORAGE_PREFIX = 'expensee_tee_token_v4:';

function assertTeeAllowed(validator: PublicKey): void {
  if (MAGICBLOCK_TEE_ENABLED) return;
  if (validator.equals(MAGICBLOCK_TEE_VALIDATOR_IDENTITY)) {
    throw new Error(
      'TEE validator is token-gated on devnet (tee.magicblock.app). Set NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED=true to allow.'
    );
  }
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function isMagicblockTeeModeEnabled(): boolean {
  if (!isBrowser()) return false;
  return window.localStorage.getItem(TEE_MODE_STORAGE_KEY) === 'true';
}

export function setMagicblockTeeModeEnabled(enabled: boolean): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(TEE_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
}

function getTeeTokenStorageKey(pubkey: PublicKey): string {
  return `${TEE_TOKEN_STORAGE_PREFIX}${pubkey.toBase58()}`;
}

function decodeJwtExp(token: string): number | null {
  if (!isBrowser()) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const json = JSON.parse(atob(padded));
    if (!json || typeof json.exp !== 'number') return null;
    return json.exp;
  } catch {
    return null;
  }
}

function isTeeTokenValid(token: string): boolean {
  const exp = decodeJwtExp(token);
  if (!exp) return true; // If we can't parse, treat as valid and let RPC reject if needed.
  const now = Math.floor(Date.now() / 1000);
  return exp - 60 > now;
}

export function isStoredTeeTokenValid(pubkey: PublicKey): boolean {
  const token = getStoredTeeToken(pubkey);
  if (!token) return false;
  return isTeeTokenValid(token);
}

export function getStoredTeeToken(pubkey: PublicKey): string | null {
  if (!isBrowser()) return null;
  const key = getTeeTokenStorageKey(pubkey);
  const token = window.localStorage.getItem(key);
  return token && token.trim().length > 0 ? token : null;
}

export async function ensureTeeAuthToken(wallet: WalletContextState): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  if (!wallet.signMessage) {
    throw new Error('Wallet does not support message signing (required for TEE auth).');
  }
  const cached = getStoredTeeToken(wallet.publicKey);
  if (cached && isTeeTokenValid(cached)) return cached;

  const client = createMagicBlockClient();
  const token = await client.getTeeAuthToken(wallet.publicKey, wallet.signMessage);
  if (isBrowser()) {
    window.localStorage.setItem(getTeeTokenStorageKey(wallet.publicKey), token);
  }
  return token;
}

async function getTeeConnectionForWallet(wallet: WalletContextState): Promise<Connection | null> {
  if (!MAGICBLOCK_TEE_ENABLED) return null;
  if (!isMagicblockTeeModeEnabled()) return null;
  const token = await ensureTeeAuthToken(wallet);
  const url = `${MAGICBLOCK_TEE_URL}?token=${token}`;
  return new Connection(url, 'confirmed');
}

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

export function getMagicblockPreferredRegion(): MagicblockValidatorRegion {
  const envRegion = (process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_REGION || '')
    .trim()
    .toLowerCase();
  if (envRegion === 'us' && isMagicblockValidatorRegionAvailable('us')) return 'us';
  if (envRegion === 'asia' && isMagicblockValidatorRegionAvailable('asia')) return 'asia';
  if (envRegion === 'eu') return 'eu';
  if (isMagicblockValidatorRegionAvailable('us')) return 'us';
  if (isMagicblockValidatorRegionAvailable('asia')) return 'asia';
  return 'eu';
}

export function getMagicblockEndpointForRegion(region: string): string {
  // Per MagicBlock docs: use specific validator endpoints for direct ER transactions.
  // The Router (devnet-router) doesn't support getLatestBlockhash — only direct endpoints do.
  if (region === 'us') return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT_US || 'https://devnet-us.magicblock.app';
  if (region === 'asia') return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT_ASIA || 'https://devnet-as.magicblock.app';
  return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT || 'https://devnet.magicblock.app';
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

function buildIncoAllowInstruction(
  allowancePda: PublicKey,
  signer: PublicKey,
  allowedAddress: PublicKey,
  handleValue: bigint,
  isAllow: boolean
): TransactionInstruction {
  const handleBuf = Buffer.alloc(16);
  let h = handleValue;
  for (let i = 0; i < 16; i += 1) {
    handleBuf[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  const data = Buffer.concat([
    INCO_ALLOW_DISCRIMINATOR,
    handleBuf,
    Buffer.from([isAllow ? 1 : 0]),
    allowedAddress.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId: INCO_LIGHTNING_ID,
    keys: [
      { pubkey: allowancePda, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: allowedAddress, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
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

/**
 * Grant decrypt access for a single Inco handle to a wallet.
 * Useful for decrypting confidential token balances in the UI.
 */
export async function grantIncoDecryptAccessForHandle(
  connection: Connection,
  wallet: WalletContextState,
  handleValue: bigint,
  targetWallet?: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  const allowed = targetWallet ?? wallet.publicKey;
  const allowancePda = getIncoAllowancePda(handleValue, allowed);
  const allowIx = buildIncoAllowInstruction(
    allowancePda,
    wallet.publicKey,
    allowed,
    handleValue,
    true
  );
  return sendAndConfirmTransaction(connection, wallet, allowIx, 'inco_allow_handle', {
    forceBase: true,
  });
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
const USER_TOKEN_V4_SEED = Buffer.from('user_token_v4');
const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');
const WITHDRAW_REQUEST_V2_SEED = Buffer.from('withdraw_request_v2');
const SHIELDED_PAYOUT_V2_SEED = Buffer.from('shielded_payout');
const RATE_HISTORY_V2_SEED = Buffer.from('rate_history_v2');
const RATE_HISTORY_V4_SEED = Buffer.from('rate_history_v4');
const MASTER_VAULT_V4_SEED = Buffer.from('master_vault_v4b');
const BUSINESS_V4_SEED = Buffer.from('business_v4');
const EMPLOYEE_V4_SEED = Buffer.from('employee_v4');
const STREAM_CONFIG_V4_SEED = Buffer.from('stream_config_v4');
const WITHDRAW_REQUEST_V4_SEED = Buffer.from('withdraw_request_v4');
const SHIELDED_PAYOUT_V4_SEED = Buffer.from('shielded_payout_v4');
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

const INCO_ALLOW_DISCRIMINATOR = disc([60, 103, 140, 65, 110, 109, 147, 164]);

const DISCRIMINATORS = {
  // Setup


  // v4 rate history (selective disclosure)
  init_rate_history_v4: disc([255, 56, 128, 46, 243, 113, 17, 22]),
  update_salary_rate_v4: disc([36, 230, 191, 106, 46, 239, 153, 16]),

  // Legacy v2 discriminators (still referenced by payout receipt scanning)
  process_withdraw_request_v2: disc([128, 150, 154, 174, 215, 145, 233, 234]),
  keeper_claim_on_behalf_v2: disc([161, 194, 33, 127, 138, 221, 153, 84]),
  claim_payout_v2: disc([173, 130, 104, 210, 0, 178, 203, 83]),



  // v4 pooled-vault privacy (global pool)
  init_master_vault_v4: disc([132, 191, 148, 16, 203, 34, 4, 210]),
  set_pool_vault_v4: disc([224, 50, 42, 158, 0, 82, 137, 135]),
  register_business_v4: disc([233, 116, 173, 112, 70, 232, 48, 66]),
  init_stream_config_v4: disc([77, 173, 13, 61, 53, 178, 21, 191]),
  add_employee_v4: disc([106, 44, 252, 137, 63, 129, 219, 138]),
  deposit_v4: disc([103, 220, 242, 73, 166, 167, 198, 55]),
  accrue_v4: disc([180, 109, 120, 73, 213, 155, 105, 135]),
  delegate_stream_v4: disc([249, 77, 175, 123, 163, 136, 126, 58]),
  commit_and_undelegate_stream_v4: disc([185, 44, 136, 7, 161, 192, 116, 224]),
  redelegate_stream_v4: disc([102, 85, 174, 231, 37, 121, 72, 231]),
  schedule_crank_v4: disc([216, 49, 46, 136, 74, 65, 11, 0]),
  request_withdraw_v4: disc([183, 179, 13, 45, 163, 176, 79, 77]),
  process_withdraw_request_v4: disc([63, 83, 36, 110, 192, 199, 14, 18]),
  claim_payout_v4: disc([40, 197, 92, 135, 254, 41, 211, 46]),
  cancel_expired_payout_v4: disc([170, 25, 106, 94, 197, 172, 156, 85]),
  init_user_token_account_v4: disc([170, 62, 69, 71, 104, 44, 4, 15]),
  link_user_token_account_v4: disc([6, 247, 211, 179, 198, 94, 56, 3]),
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
 * Derive v4 user token registry PDA
 * Seeds: ["user_token_v4", owner_pubkey, mint_pubkey]
 */
export function getUserTokenV4PDA(owner: PublicKey, mint: PublicKey = PAYUSD_MINT): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_TOKEN_V4_SEED, owner.toBuffer(), mint.toBuffer()],
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
 * Derive MagicBlock Task Context PDA
 * Seeds: ["task_context", payer_pubkey, task_id (u64 LE)]
 */
export function getTaskContextPDA(payer: PublicKey, taskId: number): [PublicKey, number] {
  const taskIdBuffer = Buffer.alloc(8);
  taskIdBuffer.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('task_context'), payer.toBuffer(), taskIdBuffer],
    MAGICBLOCK_MAGIC_PROGRAM_ID
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
 * Derive v4 rate history PDA
 * Seeds: ["rate_history_v4", business_pubkey, employee_index (u64 LE)]
 */
export function getRateHistoryV4PDA(business: PublicKey, employeeIndex: number): [PublicKey, number] {
  const employeeIndexBuffer = Buffer.alloc(8);
  employeeIndexBuffer.writeBigUInt64LE(BigInt(employeeIndex));
  return PublicKey.findProgramAddressSync(
    [RATE_HISTORY_V4_SEED, business.toBuffer(), employeeIndexBuffer],
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


// ============================================================
// V4 PDA Seeds (Pooled Vault)
// ============================================================

export function getMasterVaultV4PDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MASTER_VAULT_V4_SEED],
    PAYROLL_PROGRAM_ID
  );
}

export function getBusinessV4PDA(masterVault: PublicKey, businessIndex: number): [PublicKey, number] {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(businessIndex));
  return PublicKey.findProgramAddressSync(
    [BUSINESS_V4_SEED, masterVault.toBuffer(), indexBuf],
    PAYROLL_PROGRAM_ID
  );
}

export function getEmployeeV4PDA(business: PublicKey, employeeIndex: number): [PublicKey, number] {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  return PublicKey.findProgramAddressSync(
    [EMPLOYEE_V4_SEED, business.toBuffer(), indexBuf],
    PAYROLL_PROGRAM_ID
  );
}

export function getStreamConfigV4PDA(business: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [STREAM_CONFIG_V4_SEED, business.toBuffer()],
    PAYROLL_PROGRAM_ID
  );
}

export function getWithdrawRequestV4PDA(business: PublicKey, employeeIndex: number): [PublicKey, number] {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  return PublicKey.findProgramAddressSync(
    [WITHDRAW_REQUEST_V4_SEED, business.toBuffer(), indexBuf],
    PAYROLL_PROGRAM_ID
  );
}

export function getShieldedPayoutV4PDA(
  business: PublicKey,
  employeeIndex: number,
  nonce: number
): [PublicKey, number] {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SHIELDED_PAYOUT_V4_SEED, business.toBuffer(), indexBuf, nonceBuf],
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


export function getV4DelegationPDAs(employeeStream: PublicKey): {
  bufferPDA: PublicKey;
  delegationRecordPDA: PublicKey;
  delegationMetadataPDA: PublicKey;
} {
  return getV2DelegationPDAs(employeeStream);
}

export function getPermissionPda(permissionedAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), permissionedAccount.toBuffer()],
    MAGICBLOCK_PERMISSION_PROGRAM
  );
}

export function getPermissionDelegationPDAs(permissionAccount: PublicKey): {
  bufferPDA: PublicKey;
  delegationRecordPDA: PublicKey;
  delegationMetadataPDA: PublicKey;
} {
  const [bufferPDA] = PublicKey.findProgramAddressSync(
    [BUFFER_SEED, permissionAccount.toBuffer()],
    MAGICBLOCK_PERMISSION_PROGRAM
  );
  const [delegationRecordPDA] = PublicKey.findProgramAddressSync(
    [DELEGATION_SEED, permissionAccount.toBuffer()],
    MAGICBLOCK_DELEGATION_PROGRAM
  );
  const [delegationMetadataPDA] = PublicKey.findProgramAddressSync(
    [DELEGATION_METADATA_SEED, permissionAccount.toBuffer()],
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

// ============================================================
// V4 Account Parsing (Pooled Vault)
// ============================================================

export interface MasterVaultV4Account {
  address: PublicKey;
  authority: PublicKey;
  vaultTokenAccount: PublicKey;
  mint: PublicKey;
  useConfidentialTokens: boolean;
  encryptedBusinessCount: Uint8Array;
  encryptedEmployeeCount: Uint8Array;
  encryptedTotalBalance: Uint8Array;
  nextBusinessIndex: number;
  isActive: boolean;
  bump: number;
}

export async function getMasterVaultV4Account(
  connection: Connection
): Promise<MasterVaultV4Account | null> {
  const [masterPDA] = getMasterVaultV4PDA();
  const accountInfo = await getAccountInfoWithFallback(connection, masterPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // Detect layout version based on account data length.
  // Old layout size (no encrypted_total_balance): 211 bytes
  // New layout size (with encrypted_total_balance): 243 bytes
  //
  // Old Layout (deployed on-chain):
  // 0-8 discriminator
  // 8-40 authority
  // 40-72 vault_token_account
  // 72-104 mint
  // 104 use_confidential_tokens
  // 105-137 encrypted_business_count
  // 137-169 encrypted_employee_count
  // 169-177 next_business_index
  // 177 is_active
  // 178 bump
  //
  // New Layout (if redeployed with encrypted_total_balance):
  // 0-8 discriminator
  // 8-40 authority
  // 40-72 vault_token_account
  // 72-104 mint
  // 104 use_confidential_tokens
  // 105-137 encrypted_business_count
  // 137-169 encrypted_employee_count
  // 169-201 encrypted_total_balance
  // 201-209 next_business_index
  // 209 is_active
  // 210 bump

  const useOldLayout = data.length < 240;

  if (useOldLayout) {
    return {
      address: masterPDA,
      authority: new PublicKey(data.slice(8, 40)),
      vaultTokenAccount: new PublicKey(data.slice(40, 72)),
      mint: new PublicKey(data.slice(72, 104)),
      useConfidentialTokens: data[104] === 1,
      encryptedBusinessCount: data.slice(105, 137),
      encryptedEmployeeCount: data.slice(137, 169),
      encryptedTotalBalance: new Uint8Array(32), // not present in old layout
      nextBusinessIndex: Number(data.readBigUInt64LE(169)),
      isActive: data[177] === 1,
      bump: data[178],
    };
  }

  return {
    address: masterPDA,
    authority: new PublicKey(data.slice(8, 40)),
    vaultTokenAccount: new PublicKey(data.slice(40, 72)),
    mint: new PublicKey(data.slice(72, 104)),
    useConfidentialTokens: data[104] === 1,
    encryptedBusinessCount: data.slice(105, 137),
    encryptedEmployeeCount: data.slice(137, 169),
    encryptedTotalBalance: data.slice(169, 201),
    nextBusinessIndex: Number(data.readBigUInt64LE(201)),
    isActive: data[209] === 1,
    bump: data[210],
  };
}

export interface BusinessV4Account {
  address: PublicKey;
  masterVault: PublicKey;
  businessIndex: number;
  encryptedEmployerId: Uint8Array;
  depositAuthority: PublicKey;
  encryptedBalance: Uint8Array;
  encryptedEmployeeCount: Uint8Array;
  nextEmployeeIndex: number;
  isActive: boolean;
  bump: number;
}

export interface UserTokenAccountV4 {
  address: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  incoTokenAccount: PublicKey;
  encryptedBalance: Uint8Array;
  initializedAt: number;
  bump: number;
}

export async function getUserTokenAccountV4(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey = PAYUSD_MINT
): Promise<UserTokenAccountV4 | null> {
  const [userTokenPDA] = getUserTokenV4PDA(owner, mint);
  const accountInfo = await getAccountInfoWithFallback(connection, userTokenPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // Layout:
  // 0-8 discriminator
  // 8-40 owner
  // 40-72 mint
  // 72-104 inco_token_account
  // 104-136 encrypted_balance
  // 136-144 initialized_at
  // 144 bump
  return {
    address: userTokenPDA,
    owner: new PublicKey(data.slice(8, 40)),
    mint: new PublicKey(data.slice(40, 72)),
    incoTokenAccount: new PublicKey(data.slice(72, 104)),
    encryptedBalance: data.slice(104, 136),
    initializedAt: Number(data.readBigInt64LE(136)),
    bump: data[144],
  };
}

export async function getBusinessV4Account(
  connection: Connection,
  masterVault: PublicKey,
  businessIndex: number
): Promise<BusinessV4Account | null> {
  const [businessPDA] = getBusinessV4PDA(masterVault, businessIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, businessPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  const hasDepositAuthority = data.length >= 200;
  if (!hasDepositAuthority) {
    return {
      address: businessPDA,
      masterVault: new PublicKey(data.slice(8, 40)),
      businessIndex: Number(data.readBigUInt64LE(40)),
      encryptedEmployerId: data.slice(48, 80),
      depositAuthority: PublicKey.default,
      encryptedBalance: data.slice(80, 112),
      encryptedEmployeeCount: data.slice(112, 144),
      nextEmployeeIndex: Number(data.readBigUInt64LE(144)),
      isActive: data[152] === 1,
      bump: data[153],
    };
  }

  return {
    address: businessPDA,
    masterVault: new PublicKey(data.slice(8, 40)),
    businessIndex: Number(data.readBigUInt64LE(40)),
    encryptedEmployerId: data.slice(48, 80),
    depositAuthority: new PublicKey(data.slice(80, 112)),
    encryptedBalance: data.slice(112, 144),
    encryptedEmployeeCount: data.slice(144, 176),
    nextEmployeeIndex: Number(data.readBigUInt64LE(176)),
    isActive: data[184] === 1,
    bump: data[185],
  };
}

export async function getBusinessV4AccountByAddress(
  connection: Connection,
  businessPDA: PublicKey
): Promise<BusinessV4Account | null> {
  const accountInfo = await getAccountInfoWithFallback(connection, businessPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  const hasDepositAuthority = data.length >= 200;
  if (!hasDepositAuthority) {
    return {
      address: businessPDA,
      masterVault: new PublicKey(data.slice(8, 40)),
      businessIndex: Number(data.readBigUInt64LE(40)),
      encryptedEmployerId: data.slice(48, 80),
      depositAuthority: PublicKey.default,
      encryptedBalance: data.slice(80, 112),
      encryptedEmployeeCount: data.slice(112, 144),
      nextEmployeeIndex: Number(data.readBigUInt64LE(144)),
      isActive: data[152] === 1,
      bump: data[153],
    };
  }

  return {
    address: businessPDA,
    masterVault: new PublicKey(data.slice(8, 40)),
    businessIndex: Number(data.readBigUInt64LE(40)),
    encryptedEmployerId: data.slice(48, 80),
    depositAuthority: new PublicKey(data.slice(80, 112)),
    encryptedBalance: data.slice(112, 144),
    encryptedEmployeeCount: data.slice(144, 176),
    nextEmployeeIndex: Number(data.readBigUInt64LE(176)),
    isActive: data[184] === 1,
    bump: data[185],
  };
}

export interface EmployeeV4Account {
  address: PublicKey;
  owner: PublicKey;
  business: PublicKey;
  employeeIndex: number;
  encryptedEmployeeId: Uint8Array;
  encryptedSalaryRate: Uint8Array;
  encryptedAccrued: Uint8Array;
  lastAccrualTime: number;
  lastSettleTime: number;
  isActive: boolean;
  isDelegated: boolean;
  bump: number;
  periodStart: number;
  periodEnd: number;
}

export async function getEmployeeV4Account(
  connection: Connection,
  business: PublicKey,
  employeeIndex: number
): Promise<EmployeeV4Account | null> {
  const [employeePDA] = getEmployeeV4PDA(business, employeeIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, employeePDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  const isDelegatedFlag = data[161] === 1;
  const isDelegatedByOwner = accountInfo.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM);
  const isDelegated = isDelegatedFlag || isDelegatedByOwner;
  return {
    address: employeePDA,
    owner: accountInfo.owner,
    business: new PublicKey(data.slice(8, 40)),
    employeeIndex: Number(data.readBigUInt64LE(40)),
    encryptedEmployeeId: data.slice(48, 80),
    encryptedSalaryRate: data.slice(80, 112),
    encryptedAccrued: data.slice(112, 144),
    lastAccrualTime: Number(data.readBigInt64LE(144)),
    lastSettleTime: Number(data.readBigInt64LE(152)),
    isActive: data[160] === 1,
    isDelegated,
    bump: data[162],
    periodStart: Number(data.readBigInt64LE(163)),
    periodEnd: Number(data.readBigInt64LE(171)),
  };
}

export interface BusinessStreamConfigV4Account {
  address: PublicKey;
  business: PublicKey;
  // Legacy field (reserved in program layout).
  keeperPubkey: PublicKey;
  settleIntervalSecs: number;
  isPaused: boolean;
  pauseReason: number;
  bump: number;
}

export async function getBusinessStreamConfigV4Account(
  connection: Connection,
  business: PublicKey
): Promise<BusinessStreamConfigV4Account | null> {
  const [streamConfigPDA] = getStreamConfigV4PDA(business);
  const accountInfo = await getAccountInfoWithFallback(connection, streamConfigPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  return {
    address: streamConfigPDA,
    business: new PublicKey(data.slice(8, 40)),
    keeperPubkey: new PublicKey(data.slice(40, 72)),
    settleIntervalSecs: Number(data.readBigUInt64LE(72)),
    isPaused: data[80] === 1,
    pauseReason: data[81],
    bump: data[82],
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
  encryptedEmployeeId: Uint8Array;
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
    encryptedEmployeeId: data.slice(211, 243),
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

export interface RateHistoryEntryV4 {
  effectiveAt: number;
  salaryHandleValue: bigint;
  salaryHandle: string;
}

export interface RateHistoryV4Account {
  address: PublicKey;
  business: PublicKey;
  employeeIndex: number;
  count: number;
  bump: number;
  entries: RateHistoryEntryV4[];
}

export function extractHandleFromCiphertext32(data: Uint8Array | Buffer): bigint {
  const bytes = Buffer.from(data).subarray(0, 32);
  let result = 0n;
  // Read full 32 bytes for 256-bit handle
  for (let i = 31; i >= 0; i -= 1) {
    result = result * 256n + BigInt(bytes[i] || 0);
  }
  return result;
}

function readU128LEFrom32(handle32: Buffer): bigint {
  const b = handle32.subarray(0, 32);
  let out = 0n;
  // Read full 32 bytes for 256-bit handle
  for (let i = 31; i >= 0; i -= 1) {
    out = out * 256n + BigInt(b[i] || 0);
  }
  return out;
}

function readU128LEFrom16(bytes: Buffer): bigint {
  const b = bytes.subarray(0, 16);
  let out = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    out = out * 256n + BigInt(b[i] || 0);
  }
  return out;
}

/**
 * Read return data (set_return_data) from a confirmed transaction and parse it as a u128 handle.
 * Returns null if no return data is present or parse fails.
 */
export async function getReturnDataU128(
  connection: Connection,
  txid: string
): Promise<bigint | null> {
  try {
    const tx = await connection.getTransaction(txid, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    // type-cast to any to bypass `@solana/web3.js` type definition missing `returnData`
    const data = (tx?.meta as any)?.returnData?.data;
    if (!data || data.length < 1) return null;
    const [base64] = data;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 16) return null;
    return readU128LEFrom16(buf);
  } catch {
    return null;
  }
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

export async function getRateHistoryV4Account(
  connection: Connection,
  business: PublicKey,
  employeeIndex: number
): Promise<RateHistoryV4Account | null> {
  const [rateHistoryPDA] = getRateHistoryV4PDA(business, employeeIndex);
  const accountInfo = await getAccountInfoWithFallback(connection, rateHistoryPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  // 0-8 discriminator
  // 8-40 business
  // 40-48 employee_index (u64)
  // 48 count (u8)
  // 49 bump (u8)
  // 50-56 reserved
  // 56.. entries (16 * (i64 + [u8;32]))
  const count = data[48];
  const bump = data[49];
  const entries: RateHistoryEntryV4[] = [];
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
    employeeIndex: Number(data.readBigUInt64LE(40)),
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

function isMagicblockRouterEndpoint(endpoint: string): boolean {
  return endpoint.includes('magicblock') && endpoint.includes('router');
}

function getWritableAccountsForTx(tx: Transaction): string[] {
  const writable = new Set<string>();
  if (tx.feePayer) writable.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) {
    for (const key of ix.keys) {
      if (key.isWritable) writable.add(key.pubkey.toBase58());
    }
  }
  return Array.from(writable);
}

import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk';

/**
 * Send and confirm a transaction containing one or more instructions
 */
function getBaseWriteConnection(): Connection {
  const url =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
    'https://api.devnet.solana.com';
  return new Connection(url, 'confirmed');
}

async function sendAndConfirmTransaction(
  connection: Connection,
  wallet: WalletContextState,
  instructionOrTransaction: TransactionInstruction | Transaction,
  label: string = 'transaction',
  options?: { forceBase?: boolean; forceProvided?: boolean; skipPreflight?: boolean; maxRetries?: number }
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected');
  }

  let txConnection: Connection;
  if (options?.forceProvided) {
    txConnection = connection;
  } else {
    txConnection = options?.forceBase
      ? getBaseWriteConnection()
      : (await getTeeConnectionForWallet(wallet)) || connection;
    if (!options?.forceBase && txConnection.rpcEndpoint.includes('tee.magicblock.app')) {
      txConnection = getBaseWriteConnection();
    }
  }
  let transaction: Transaction;
  if (instructionOrTransaction instanceof TransactionInstruction) {
    // Wrap the single instruction in a transaction
    transaction = new Transaction().add(instructionOrTransaction);
  } else {
    // It's already a Transaction
    transaction = instructionOrTransaction;
  }
  transaction.feePayer = wallet.publicKey;

  let blockhash: string;
  let lastValidBlockHeight: number;
  let minContextSlot: number | undefined;

  const isRouter = isMagicblockRouterEndpoint(txConnection.rpcEndpoint);
  if (isRouter) {
    console.log(`[sendAndConfirm] Fetching router blockhash for: ${label}`);
    const routerConnection = new ConnectionMagicRouter(txConnection.rpcEndpoint);
    const { blockhash: routerHash, lastValidBlockHeight: routerHeight } = await withTimeout(
      routerConnection.getLatestBlockhashForTransaction(transaction),
      20_000,
      'Fetching router blockhash'
    );
    blockhash = routerHash;
    lastValidBlockHeight = routerHeight;
  } else {
    console.log(`[sendAndConfirm] Fetching latest blockhash for: ${label}`);
    const { context, value } = await withTimeout(
      txConnection.getLatestBlockhashAndContext('confirmed'),
      20_000,
      'Fetching latest blockhash'
    );
    blockhash = value.blockhash;
    lastValidBlockHeight = value.lastValidBlockHeight;
    minContextSlot = context.slot;
  }

  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;

  console.log(`[sendAndConfirm] Waiting for signature: ${label}`);
  const signed = await withTimeout(wallet.signTransaction(transaction), 90_000, 'Waiting for Phantom signature');

  console.log(`[sendAndConfirm] Submitting transaction: ${label}`);
  const txid = await withTimeout(
    txConnection.sendRawTransaction(signed.serialize(), {
      skipPreflight: options?.skipPreflight ?? isRouter,
      minContextSlot,
      maxRetries: options?.maxRetries ?? (isRouter ? 5 : 3),
    }),
    30_000,
    'Submitting transaction'
  );

  console.log(`[sendAndConfirm] Confirming transaction: ${txid} (${label})`);
  let confirmation;
  try {
    confirmation = await withTimeout(
      txConnection.confirmTransaction(
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
  } catch (err: any) {
    const pendingError = new Error(
      `Transaction submitted but confirmation is pending. Check wallet/Explorer for ${txid}.`
    ) as Error & { txid?: string; code?: string };
    pendingError.txid = txid;
    pendingError.code = 'TX_CONFIRM_TIMEOUT';
    throw pendingError;
  }

  // Check if transaction actually succeeded
  if (confirmation.value.err) {
    console.error('Transaction failed on-chain:', confirmation.value.err);
    
    // Fetch logs to show a better error message in the UI instead of a generic InstructionError
    try {
      const txResult = await txConnection.getTransaction(txid, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txResult?.meta?.logMessages) {
        console.error('Transaction Logs:', txResult.meta.logMessages.join('\n'));
        const errMsg = txResult.meta.logMessages[txResult.meta.logMessages.length - 1];
        throw new Error(`Tx Failed: ${errMsg}`);
      }
    } catch (e: any) {
      if (e.message.includes('Tx Failed:')) throw e;
      console.warn('Could not fetch tx logs for detailed error:', e);
    }

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

function u128FromBytesLE(bytes: Uint8Array): bigint {
  let value = 0n;
  const len = Math.min(bytes.length, 16);
  for (let i = 0; i < len; i += 1) {
    value |= BigInt(bytes[i]) << (8n * BigInt(i));
  }
  return value;
}

/**
 * Hash a pubkey into a stable 128-bit identifier (little-endian).
 */
function getPrivacyIdSalt(): Uint8Array | null {
  const raw =
    (process.env.NEXT_PUBLIC_PRIVACY_ID_SALT || process.env.PRIVACY_ID_SALT || '').trim();
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

export async function hashPubkeyToU128(pubkey: PublicKey): Promise<bigint> {
  const pubkeyBuffer = pubkey.toBuffer();
  const salt = getPrivacyIdSalt();
  const input = salt ? new Uint8Array([...salt, ...pubkeyBuffer]) : new Uint8Array(pubkeyBuffer);
  const hashBuffer = await crypto.subtle.digest('SHA-256', input);
  const digest = new Uint8Array(hashBuffer).slice(0, 16);
  return u128FromBytesLE(digest);
}

/**
 * Encrypt a pubkey-derived ID for Inco storage.
 */
async function encryptPubkeyId(pubkey: PublicKey): Promise<Buffer> {
  const idValue = await hashPubkeyToU128(pubkey);
  return encryptForInco(idValue);
}

// ============================================================
// V4 Pooled-Vault Instructions
// ============================================================

/**
 * Fail-closed compliance screening used for delegate flow.
 * When COMPLIANCE_ENABLED is false (the default), this is a no-op.
 */
async function requireRangeCompliance(address: string): Promise<void> {
  if (!COMPLIANCE_ENABLED) {
    return;
  }

  const { rangeClient } = await import('./range');

  if (!rangeClient.isConfigured()) {
    throw new Error('Range API key is required for fail-closed compliance policy');
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

export async function initMasterVaultV4(
  connection: Connection,
  wallet: WalletContextState
): Promise<{ txid: string; masterVaultPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const existing = await getAccountInfoWithFallback(connection, masterVaultPDA);
  if (existing) {
    throw new Error('MasterVaultV4 already initialized');
  }

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: DISCRIMINATORS.init_master_vault_v4,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction, 'init_master_vault_v4', {
    forceBase: true,
  });
  return { txid, masterVaultPDA };
}

export async function setPoolVaultV4(
  connection: Connection,
  wallet: WalletContextState,
  vaultTokenAccount: PublicKey,
  mint: PublicKey = PAYUSD_MINT,
  useConfidentialTokens: boolean = true
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const data = Buffer.concat([
    DISCRIMINATORS.set_pool_vault_v4,
    mint.toBuffer(),
    Buffer.from([useConfidentialTokens ? 1 : 0]),
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction, 'set_pool_vault_v4', {
    forceBase: true,
  });
}

export async function registerBusinessV4(
  connection: Connection,
  wallet: WalletContextState,
  depositAuthority?: PublicKey
): Promise<{ txid: string; masterVaultPDA: PublicKey; businessPDA: PublicKey; businessIndex: number }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const master = await getMasterVaultV4Account(connection);
  if (!master) {
    throw new Error('MasterVaultV4 not initialized. Run initMasterVaultV4 first.');
  }
  if (!master.isActive) {
    throw new Error('MasterVaultV4 is inactive. Reactivate it with the authority wallet.');
  }

  const businessIndex = master.nextBusinessIndex;
  const [businessPDA] = getBusinessV4PDA(master.address, businessIndex);

  const encryptedEmployerId = await encryptPubkeyId(wallet.publicKey);
  const authorityKey = depositAuthority ?? wallet.publicKey;
  const employerIdLen = Buffer.alloc(4);
  employerIdLen.writeUInt32LE(encryptedEmployerId.length);

  const data = Buffer.concat([
    DISCRIMINATORS.register_business_v4,
    employerIdLen,
    encryptedEmployerId,
    authorityKey.toBuffer(),
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: master.address, isSigner: false, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction, 'register_business_v4', {
    forceBase: true,
  });
  return { txid, masterVaultPDA: master.address, businessPDA, businessIndex };
}

export async function initStreamConfigV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  settleIntervalSecs: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const settleBuf = Buffer.alloc(8);
  settleBuf.writeBigUInt64LE(BigInt(settleIntervalSecs));

  const data = Buffer.concat([
    DISCRIMINATORS.init_stream_config_v4,
    settleBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction, 'init_stream_config_v4', {
    forceBase: true,
  });
}

export async function initUserTokenAccountV4(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey = PAYUSD_MINT
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [userTokenPDA] = getUserTokenV4PDA(wallet.publicKey, mint);
  const data = DISCRIMINATORS.init_user_token_account_v4;

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export async function linkUserTokenAccountV4(
  connection: Connection,
  wallet: WalletContextState,
  incoTokenAccount: PublicKey,
  mint: PublicKey = PAYUSD_MINT,
  balanceLamports?: bigint
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [userTokenPDA] = getUserTokenV4PDA(wallet.publicKey, mint);
  const encrypted = balanceLamports !== undefined ? await encryptForInco(balanceLamports) : Buffer.alloc(0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(encrypted.length);
  const data = Buffer.concat([DISCRIMINATORS.link_user_token_account_v4, len, encrypted]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenPDA, isSigner: false, isWritable: true },
      { pubkey: incoTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export async function addEmployeeV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeWallet: PublicKey,
  salaryLamports: bigint,
  periodStart: number,
  periodEnd: number,
  requiredDepositAmount: bigint = 0n
): Promise<{ txid: string; employeePDA: PublicKey; employeeIndex: number }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const master = await getMasterVaultV4Account(connection);
  if (!master) {
    throw new Error('MasterVaultV4 not initialized.');
  }
  const business = await getBusinessV4AccountByAddress(connection, businessPDA);
  if (!business) throw new Error('BusinessV4 account not found.');

  const employeeIndex = business.nextEmployeeIndex;
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);

  const encryptedEmployeeId = await encryptPubkeyId(employeeWallet);
  const encryptedSalary = await encryptForInco(salaryLamports);
  const employeeIdLen = Buffer.alloc(4);
  employeeIdLen.writeUInt32LE(encryptedEmployeeId.length);
  const salaryLen = Buffer.alloc(4);
  salaryLen.writeUInt32LE(encryptedSalary.length);
  const periodStartBuf = Buffer.alloc(8);
  periodStartBuf.writeBigInt64LE(BigInt(periodStart));
  const periodEndBuf = Buffer.alloc(8);
  periodEndBuf.writeBigInt64LE(BigInt(periodEnd));
  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const requiredAmountBuf = Buffer.alloc(8);
  requiredAmountBuf.writeBigUInt64LE(requiredDepositAmount);

  const data = Buffer.concat([
    DISCRIMINATORS.add_employee_v4,
    employeeIndexBuf,
    employeeIdLen,
    encryptedEmployeeId,
    salaryLen,
    encryptedSalary,
    periodStartBuf,
    periodEndBuf,
    requiredAmountBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction, 'add_employee_v4', {
    forceBase: true,
  });
  return { txid, employeePDA, employeeIndex };
}

export async function depositV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  depositorTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  amountLamports: bigint
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const encryptedAmount = await encryptForInco(amountLamports);
  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(encryptedAmount.length);
  const data = Buffer.concat([DISCRIMINATORS.deposit_v4, lengthBytes, encryptedAmount]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  return sendAndConfirmTransaction(connection, wallet, instruction, 'deposit_v4', {
    forceBase: true,
  });
}

export async function accrueV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(BigInt(employeeIndex));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.accrue_v4, indexBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

/**
 * Delegate v4 employee stream to a MagicBlock ER validator.
 */
export async function delegateStreamV4(
  connection: Connection,
  wallet: WalletContextState,
  businessIndex: number,
  employeeIndex: number,
  employeeWallet: PublicKey,
  validator: PublicKey = TEE_VALIDATOR
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  if (!employeeWallet) {
    throw new Error('Employee wallet is required for permission membership');
  }

  await requireRangeCompliance(wallet.publicKey.toBase58());
  assertTeeAllowed(validator);

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [businessPDA] = getBusinessV4PDA(masterVaultPDA, businessIndex);
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const master = await getMasterVaultV4Account(connection);
  if (!master) {
    throw new Error('v4 master vault not found');
  }
  const authority = master.authority;
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV4DelegationPDAs(employeePDA);
  const [permissionPDA] = getPermissionPda(employeePDA);
  const {
    bufferPDA: permissionBufferPDA,
    delegationRecordPDA: permissionDelegationRecordPDA,
    delegationMetadataPDA: permissionDelegationMetadataPDA,
  } = getPermissionDelegationPDAs(permissionPDA);

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) {
    throw new Error(`v4 employee ${employeeIndex} not found`);
  }
  if (!employee.isActive) {
    throw new Error(`v4 employee ${employeeIndex} is inactive`);
  }
  if (employee.isDelegated) {
    throw new Error(`v4 employee ${employeeIndex} already delegated`);
  }

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.delegate_stream_v4,
    employeeIndexBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: bufferPDA, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: permissionBufferPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: permissionPDA, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PERMISSION_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: employeeWallet, isSigner: false, isWritable: false },
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
 * Schedule the auto-execution (tick) of crank_settle_v4 on the Ephemeral Rollup.
 * This MUST be called on the ER RPC endpoint *after* the stream is delegated.
 */
export async function scheduleCrankV4(
  erConnection: Connection,
  wallet: WalletContextState,
  businessIndex: number,
  employeeIndex: number,
  taskId: number
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [businessPDA] = getBusinessV4PDA(masterVaultPDA, businessIndex);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [taskContextPDA] = getTaskContextPDA(wallet.publicKey, taskId);

  // args: task_id (u64), execution_interval_millis (u64), iterations (u64), employee_index (u64)
  const argsBuf = Buffer.alloc(32);
  argsBuf.writeBigUInt64LE(BigInt(taskId), 0);
  argsBuf.writeBigUInt64LE(BigInt(1_000), 8); // 1 second — real-time streaming payroll
  argsBuf.writeBigUInt64LE(BigInt(999_999_999), 16); // High safe number of iterations
  argsBuf.writeBigUInt64LE(BigInt(employeeIndex), 24);

  const data = Buffer.concat([
    DISCRIMINATORS.schedule_crank_v4,
    argsBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: MAGICBLOCK_MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });
  // Per MagicBlock docs: send ER transactions through the MagicBlock Router.
  const routerConnection = new ConnectionMagicRouter(
    process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app'
  );

  const tx = new Transaction().add(instruction);
  tx.feePayer = wallet.publicKey;

  const { blockhash, lastValidBlockHeight } = await routerConnection.getLatestBlockhashForTransaction(tx);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  if (!wallet.signTransaction) throw new Error('Wallet does not support signTransaction');
  const signed = await wallet.signTransaction(tx);

  const txid = await routerConnection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });

  await routerConnection.confirmTransaction(
    { blockhash, lastValidBlockHeight, signature: txid },
    'confirmed'
  );

  // Since we use skipPreflight, we must manually check if the tx actually succeeded on-chain
  const txResult = await routerConnection.getTransaction(txid, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (txResult?.meta?.err) {
    console.error('ER Transaction failed:', txResult.meta.err);
    if (txResult.meta.logMessages) {
      console.error('ER Transaction Logs:', txResult.meta.logMessages.join('\n'));
    }
    const errMsg = txResult.meta.logMessages 
      ? txResult.meta.logMessages[txResult.meta.logMessages.length - 1] 
      : JSON.stringify(txResult.meta.err);
    throw new Error(`ER Tx Failed: ${errMsg}`);
  }

  return txid;
}

/**
 * Commit pending delegated state and undelegate v4 stream back to base layer.
 */
export async function commitAndUndelegateStreamV4(
  connection: Connection,
  wallet: WalletContextState,
  businessIndex: number,
  employeeIndex: number,
  magicContext: PublicKey = MAGICBLOCK_MAGIC_CONTEXT
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [businessPDA] = getBusinessV4PDA(masterVaultPDA, businessIndex);
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);

  // Read account data from the BASE LAYER for delegation checks.
  // The ER may report isDelegated differently since the account lives there now.
  const baseConnection = new Connection(
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    'confirmed'
  );
  const master = await getMasterVaultV4Account(baseConnection);
  if (!master) {
    throw new Error('v4 master vault not found');
  }
  const authority = master.authority;
  const [permissionPDA] = getPermissionPda(employeePDA);

  // Skip isDelegated check — the UI already verified delegation status,
  // and the ER account data may not reflect the base-layer delegation flag.


  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.commit_and_undelegate_stream_v4,
    employeeIndexBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: permissionPDA, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PERMISSION_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: MAGICBLOCK_MAGIC_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: magicContext, isSigner: false, isWritable: true },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  // Per MagicBlock docs: send ER transactions through the MagicBlock Router.
  // The Router listens for ScheduleCommitAndUndelegate and automatically triggers
  // the keeper to finalize the base-layer undelegation via AcceptScheduleCommits.
  const routerConnection = new ConnectionMagicRouter(
    process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app'
  );

  const tx = new Transaction().add(instruction);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await routerConnection.getLatestBlockhashForTransaction(tx);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  if (!wallet.signTransaction) throw new Error('Wallet does not support signTransaction');
  const signed = await wallet.signTransaction(tx);

  const txid = await routerConnection.sendRawTransaction(signed.serialize(), {
    skipPreflight: true,
    maxRetries: 5,
  });

  await routerConnection.confirmTransaction(
    { blockhash, lastValidBlockHeight, signature: txid },
    'confirmed'
  );

  // Since we use skipPreflight, we must manually check if the tx actually succeeded on-chain
  const txResult = await routerConnection.getTransaction(txid, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (txResult?.meta?.err) {
    console.error('ER Transaction failed:', txResult.meta.err);
    if (txResult.meta.logMessages) {
      console.error('ER Transaction Logs:', txResult.meta.logMessages.join('\n'));
    }
    const errMsg = txResult.meta.logMessages 
      ? txResult.meta.logMessages[txResult.meta.logMessages.length - 1] 
      : JSON.stringify(txResult.meta.err);
    throw new Error(`ER Tx Failed: ${errMsg}`);
  }

  return txid;
}

/**
 * Derives a deterministic MagicBlock task ID from on-chain identity data.
 * This guarantees the UI can always find the scheduled crank without needing localStorage.
 * Max safe integer in JS is 2^53 - 1, which fits within the u64 expected by the program.
 */
export async function getDeterministicTaskId(
  operator: PublicKey,
  businessIndex: number,
  employeeIndex: number
): Promise<number> {
  const encoder = new TextEncoder();
  const dataString = `expensee_crank_${operator.toBase58()}_${businessIndex}_${employeeIndex}`;
  const data = encoder.encode(dataString);
  // TypeScript strictly expects an ArrayBuffer, but TextEncoder returns Uint8Array.
  // We can safely coerce it to BufferSource for DOM crypto.
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any as ArrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  // Read first 6 bytes (48 bits) to stay well under JS Number.MAX_SAFE_INTEGER
  let taskId = 0;
  for (let i = 0; i < 6; i++) {
    taskId = taskId * 256 + hashArray[i];
  }
  return taskId;
}

/**
 * Re-delegate a v4 stream after settlement commit.
 */
export async function redelegateStreamV4(
  connection: Connection,
  wallet: WalletContextState,
  businessIndex: number,
  employeeIndex: number,
  validator: PublicKey = TEE_VALIDATOR
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  assertTeeAllowed(validator);

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [businessPDA] = getBusinessV4PDA(masterVaultPDA, businessIndex);
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const master = await getMasterVaultV4Account(connection);
  if (!master) {
    throw new Error('v4 master vault not found');
  }
  const authority = master.authority;
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV4DelegationPDAs(employeePDA);
  const [permissionPDA] = getPermissionPda(employeePDA);
  const {
    bufferPDA: permissionBufferPDA,
    delegationRecordPDA: permissionDelegationRecordPDA,
    delegationMetadataPDA: permissionDelegationMetadataPDA,
  } = getPermissionDelegationPDAs(permissionPDA);

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) {
    throw new Error(`v4 employee ${employeeIndex} not found`);
  }
  if (employee.isDelegated) {
    throw new Error(`v4 employee ${employeeIndex} already delegated`);
  }

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const data = Buffer.concat([
    DISCRIMINATORS.redelegate_stream_v4,
    employeeIndexBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: bufferPDA, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: permissionBufferPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: permissionPDA, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PERMISSION_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
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

export async function requestWithdrawV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  autoAllow: boolean = true
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [withdrawRequestPDA] = getWithdrawRequestV4PDA(businessPDA, employeeIndex);

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) throw new Error('Employee v4 not found');
  const employeeIdHandleValue = readU128LEFrom32(Buffer.from(employee.encryptedEmployeeId));
  const employeeIdAllowance = getIncoAllowancePda(employeeIdHandleValue, wallet.publicKey);

  if (autoAllow) {
    const allowanceInfo = await getAccountInfoWithFallback(connection, employeeIdAllowance);
    if (!allowanceInfo) {
      const allowIx = buildIncoAllowInstruction(
        employeeIdAllowance,
        wallet.publicKey,
        wallet.publicKey,
        employeeIdHandleValue,
        true
      );
      await sendAndConfirmTransaction(connection, wallet, allowIx, 'inco_allow', { forceBase: true });
    }
  }

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));

  // 1. Request withdraw instruction
  const requestInstruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: employeePDA, isSigner: false, isWritable: false },
      { pubkey: employeeIdAllowance, isSigner: false, isWritable: false },
      { pubkey: withdrawRequestPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.request_withdraw_v4, employeeIndexBuf]),
  });

  const tx = new Transaction().add(requestInstruction);
  return sendAndConfirmTransaction(connection, wallet, tx, "request_withdraw");
}

/**
 * Grant the employee wallet permission to decrypt v4 salary/accrued handles (Inco allow).
 * This enables client-side attested decrypt for live earnings + statements.
 */
async function grantWalletViewAccessV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  targetWallet: PublicKey
): Promise<{ txid?: string; alreadyGranted?: boolean }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) {
    throw new Error('Employee v4 not found');
  }

  const handles = getEmployeeV4DecryptHandles(employee);
  const salaryAllowance = getIncoAllowancePda(handles.salaryHandleValue, targetWallet);
  const accruedAllowance = getIncoAllowancePda(handles.accruedHandleValue, targetWallet);
  const employeeIdAllowance = getIncoAllowancePda(handles.employeeIdHandleValue, targetWallet);

  const instructions: TransactionInstruction[] = [];
  const salaryInfo = await getAccountInfoWithFallback(connection, salaryAllowance);
  if (!salaryInfo) {
    instructions.push(
      buildIncoAllowInstruction(salaryAllowance, wallet.publicKey, targetWallet, handles.salaryHandleValue, true)
    );
  }
  const accruedInfo = await getAccountInfoWithFallback(connection, accruedAllowance);
  if (!accruedInfo) {
    instructions.push(
      buildIncoAllowInstruction(accruedAllowance, wallet.publicKey, targetWallet, handles.accruedHandleValue, true)
    );
  }
  const employeeIdInfo = await getAccountInfoWithFallback(connection, employeeIdAllowance);
  if (!employeeIdInfo) {
    instructions.push(
      buildIncoAllowInstruction(employeeIdAllowance, wallet.publicKey, targetWallet, handles.employeeIdHandleValue, true)
    );
  }

  if (instructions.length === 0) {
    return { alreadyGranted: true };
  }

  const tx = new Transaction().add(...instructions);
  const txid = await sendAndConfirmTransaction(connection, wallet, tx, 'inco_allow_v4', { forceBase: true });
  return { txid };
}

export async function grantEmployeeViewAccessV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number
): Promise<{ txid?: string; alreadyGranted?: boolean }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }
  return grantWalletViewAccessV4(connection, wallet, businessPDA, employeeIndex, wallet.publicKey);
}

export async function grantKeeperViewAccessV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  keeperWallet: PublicKey
): Promise<{ txid?: string; alreadyGranted?: boolean }> {
  return grantWalletViewAccessV4(connection, wallet, businessPDA, employeeIndex, keeperWallet);
}

export async function processWithdrawRequestV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  nonce: number,
  vaultTokenAccount: PublicKey,
  payoutTokenAccount: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [withdrawRequestPDA] = getWithdrawRequestV4PDA(businessPDA, employeeIndex);
  const [shieldedPayoutPDA] = getShieldedPayoutV4PDA(businessPDA, employeeIndex, nonce);

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) throw new Error('Employee v4 not found');
  const employeeIdHandleValue = readU128LEFrom32(Buffer.from(employee.encryptedEmployeeId));
  const employeeIdAllowance = getIncoAllowancePda(employeeIdHandleValue, wallet.publicKey);

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: withdrawRequestPDA, isSigner: false, isWritable: true },
      { pubkey: employeeIdAllowance, isSigner: false, isWritable: false },
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.process_withdraw_request_v4, employeeIndexBuf, nonceBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export async function claimPayoutV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  nonce: number,
  payoutTokenAccount: PublicKey,
  claimerTokenAccount: PublicKey
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [shieldedPayoutPDA] = getShieldedPayoutV4PDA(businessPDA, employeeIndex, nonce);
  const payout = await getShieldedPayoutV4Account(connection, businessPDA, employeeIndex, nonce);
  if (!payout) {
    throw new Error(`v4 shielded payout ${employeeIndex}/${nonce} not found`);
  }
  const employeeIdHandleValue = u128FromBytesLE(payout.employeeAuthHandle.slice(0, 16));
  const employeeIdAllowance = getIncoAllowancePda(employeeIdHandleValue, wallet.publicKey);

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: claimerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: employeeIdAllowance, isSigner: false, isWritable: false },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.claim_payout_v4, employeeIndexBuf, nonceBuf]),
  });

  return sendAndConfirmTransaction(connection, wallet, instruction);
}

export async function executeFullWithdrawalV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  nonce: number,
  vaultTokenAccount: PublicKey,
  claimerTokenAccount: PublicKey
): Promise<string> {
  if (!wallet.publicKey) throw new Error('Wallet not connected');

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [withdrawRequestPDA] = getWithdrawRequestV4PDA(businessPDA, employeeIndex);
  const [shieldedPayoutPDA] = getShieldedPayoutV4PDA(businessPDA, employeeIndex, nonce);

  // 1. Generate Payout Token Account (key order: token, mint, owner, payer, system, incoLightning)
  const payoutTokenKeypair = Keypair.generate();
  const payoutTokenAccount = payoutTokenKeypair.publicKey;
  const initIx = new TransactionInstruction({
    keys: [
      { pubkey: payoutTokenAccount, isSigner: true, isWritable: true },    // token_account
      { pubkey: PAYUSD_MINT, isSigner: false, isWritable: false },         // mint
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: false },   // owner
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },      // payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
    ],
    programId: INCO_TOKEN_PROGRAM_ID,
    data: Buffer.concat([Buffer.from([74, 115, 99, 93, 197, 69, 103, 7])]), // INCO_INIT_ACCOUNT_DISCRIMINATOR
  });

  const employee = await getEmployeeV4Account(connection, businessPDA, employeeIndex);
  if (!employee) throw new Error('Employee not found');
  const employeeIdHandleValue = readU128LEFrom32(Buffer.from(employee.encryptedEmployeeId));
  const employeeIdAllowance = getIncoAllowancePda(employeeIdHandleValue, wallet.publicKey);

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  // 1. Process
  const processIx = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: true },
      { pubkey: businessPDA, isSigner: false, isWritable: true },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: withdrawRequestPDA, isSigner: false, isWritable: true },
      { pubkey: employeeIdAllowance, isSigner: false, isWritable: false },
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.process_withdraw_request_v4, employeeIndexBuf, nonceBuf]),
  });

  // 2. Claim
  const claimIx = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: shieldedPayoutPDA, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: claimerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: employeeIdAllowance, isSigner: false, isWritable: false },
      { pubkey: INCO_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.claim_payout_v4, employeeIndexBuf, nonceBuf]),
  });

  // 3. Redelegate
  const { bufferPDA, delegationRecordPDA, delegationMetadataPDA } = getV4DelegationPDAs(employeePDA);
  const [permissionPDA] = getPermissionPda(employeePDA);
  const {
    bufferPDA: permissionBufferPDA,
    delegationRecordPDA: permissionDelegationRecordPDA,
    delegationMetadataPDA: permissionDelegationMetadataPDA,
  } = getPermissionDelegationPDAs(permissionPDA);
  const master = await getMasterVaultV4Account(connection);
  if (!master) throw new Error('v4 master vault not found');
  const authority = master.authority;

  const redelegateIx = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
      { pubkey: bufferPDA, isSigner: false, isWritable: true },
      { pubkey: delegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: delegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: permissionBufferPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationRecordPDA, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationMetadataPDA, isSigner: false, isWritable: true },
      { pubkey: permissionPDA, isSigner: false, isWritable: true },
      { pubkey: MAGICBLOCK_PERMISSION_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PAYROLL_PROGRAM_ID, isSigner: false, isWritable: false }, // owner_program
      { pubkey: MAGICBLOCK_DELEGATION_PROGRAM, isSigner: false, isWritable: false }, // delegation_program
    ],
    programId: PAYROLL_PROGRAM_ID,
    data: Buffer.concat([DISCRIMINATORS.redelegate_stream_v4, employeeIndexBuf]),
  });

  const tx = new Transaction();
  
  if (employee.isDelegated) {
    // 0. Commit and undelegate instruction (if delegated)
    const [permissionPDA] = getPermissionPda(employeePDA);
    const commitInstruction = new TransactionInstruction({
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
        { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
        { pubkey: businessPDA, isSigner: false, isWritable: false },
        { pubkey: streamConfigPDA, isSigner: false, isWritable: false },
        { pubkey: employeePDA, isSigner: false, isWritable: true },
        { pubkey: permissionPDA, isSigner: false, isWritable: true },
        { pubkey: MAGICBLOCK_PERMISSION_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: authority, isSigner: false, isWritable: false },
        { pubkey: MAGICBLOCK_MAGIC_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: MAGICBLOCK_MAGIC_CONTEXT, isSigner: false, isWritable: true },
      ],
      programId: PAYROLL_PROGRAM_ID,
      data: Buffer.concat([DISCRIMINATORS.commit_and_undelegate_stream_v4, employeeIndexBuf]),
    });
    tx.add(commitInstruction);
  }

  tx.add(initIx, processIx, claimIx, redelegateIx);
  // We must sign with the payoutTokenKeypair since it's initializing
  if (!wallet.signTransaction) throw new Error('Wallet sign transaction required');
  const blockhash = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash.blockhash;
  tx.feePayer = wallet.publicKey;
  
  // Partial sign with the ephemeral token account keypair
  tx.partialSign(payoutTokenKeypair);
  const signedTx = await wallet.signTransaction(tx);
  
  const txid = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed'
  });
  await connection.confirmTransaction({
    signature: txid,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight
  }, 'confirmed');
  
  return txid;
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

  // ── IMPORTANT FIX: Check if they already have one registered ──
  try {
    const existingRegistry = await getUserTokenAccountV4(connection, owner, mint);
    if (existingRegistry && existingRegistry.incoTokenAccount && !existingRegistry.incoTokenAccount.equals(PublicKey.default)) {
      console.log('Found existing Inco token account:', existingRegistry.incoTokenAccount.toBase58());
      return { txid: 'existing', tokenAccount: existingRegistry.incoTokenAccount };
    }
  } catch (e) {
    console.warn('Error checking existing user token account, proceeding with creation:', e);
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

  const txConnection = getBaseWriteConnection();

  const transaction = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } = await withTimeout(
    txConnection.getLatestBlockhash('confirmed'),
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
    txConnection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    }),
    30_000,
    'Submitting transaction'
  );

  const confirmation = await withTimeout(
    txConnection.confirmTransaction(
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

  // Also try to automatically link it if they didn't have one
  try {
    await linkUserTokenAccountV4(connection, wallet, tokenAccountKeypair.publicKey, mint);
    console.log('Automatically linked new token account to registry');
  } catch (e) {
    console.warn('Failed to auto-link new token account, user may need to click Link manually:', e);
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
  employeeIdHandle: string;
  accruedHandle: string;
  salaryHandle: string;
  employeeIdHandleValue: bigint;
  accruedHandleValue: bigint;
  salaryHandleValue: bigint;
}

export function getEmployeeStreamV2DecryptHandles(
  stream: EmployeeStreamV2Account
): EmployeeStreamV2DecryptHandles {
  const employeeIdBytes = stream.encryptedEmployeeId.slice(0, 16);
  const accruedBytes = stream.encryptedAccrued.slice(0, 16);
  const salaryBytes = stream.encryptedSalaryRate.slice(0, 16);

  let employeeId = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    employeeId = employeeId * BigInt(256) + BigInt(employeeIdBytes[i]);
  }

  let accrued = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    accrued = accrued * BigInt(256) + BigInt(accruedBytes[i]);
  }

  let salary = BigInt(0);
  for (let i = 15; i >= 0; i--) {
    salary = salary * BigInt(256) + BigInt(salaryBytes[i]);
  }

  return {
    employeeIdHandle: employeeId.toString(),
    accruedHandle: accrued.toString(),
    salaryHandle: salary.toString(),
    employeeIdHandleValue: employeeId,
    accruedHandleValue: accrued,
    salaryHandleValue: salary,
  };
}

export interface EmployeeV4DecryptHandles {
  employeeIdHandle: string;
  accruedHandle: string;
  salaryHandle: string;
  employeeIdHandleValue: bigint;
  accruedHandleValue: bigint;
  salaryHandleValue: bigint;
}

export function getEmployeeV4DecryptHandles(employee: EmployeeV4Account): EmployeeV4DecryptHandles {
  const employeeIdValue = readU128LEFrom32(Buffer.from(employee.encryptedEmployeeId));
  const accruedValue = readU128LEFrom32(Buffer.from(employee.encryptedAccrued));
  const salaryValue = readU128LEFrom32(Buffer.from(employee.encryptedSalaryRate));

  return {
    employeeIdHandle: employeeIdValue.toString(),
    accruedHandle: accruedValue.toString(),
    salaryHandle: salaryValue.toString(),
    employeeIdHandleValue: employeeIdValue,
    accruedHandleValue: accruedValue,
    salaryHandleValue: salaryValue,
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

export interface WorkerPayoutReceipt {
  streamIndex: number;
  nonce: number;
  payoutPda: string;
  payoutTokenAccount: string;
  createdAt: number;
  claimed: boolean;
  cancelled: boolean;
  bufferTx: string | null;
  claimTx: string | null;
  destinationTokenAccount: string | null;
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


// ============================================================
// V4 Shielded Payout (Pooled Vault Claim Flow)
// ============================================================

export interface ShieldedPayoutV4Account {
  address: PublicKey;
  business: PublicKey;
  employeeIndex: number;
  nonce: number;
  employeeAuthHandle: Uint8Array;
  encryptedAmount: Uint8Array;
  claimed: boolean;
  cancelled: boolean;
  createdAt: number;
  expiresAt: number;
  payoutTokenAccount: PublicKey;
  bump: number;
}

export async function getShieldedPayoutV4Account(
  connection: Connection,
  business: PublicKey,
  employeeIndex: number,
  nonce: number
): Promise<ShieldedPayoutV4Account | null> {
  const [payoutPDA] = getShieldedPayoutV4PDA(business, employeeIndex, nonce);
  const accountInfo = await getAccountInfoWithFallback(connection, payoutPDA);
  if (!accountInfo) return null;

  const data = accountInfo.data;
  return {
    address: payoutPDA,
    business: new PublicKey(data.slice(8, 40)),
    employeeIndex: Number(data.readBigUInt64LE(40)),
    nonce: Number(data.readBigUInt64LE(48)),
    employeeAuthHandle: data.slice(56, 88),
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
// ShieldedPayoutV4 account discriminator: sha256("account:ShieldedPayoutV4")[0..8]
const SHIELDED_PAYOUT_V4_DISCRIMINATOR = Buffer.from([167, 189, 20, 136, 134, 68, 3, 158]);

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

function parseShieldedPayoutV4(address: PublicKey, data: Buffer): ShieldedPayoutV4Account {
  return {
    address,
    business: new PublicKey(data.slice(8, 40)),
    employeeIndex: Number(data.readBigUInt64LE(40)),
    nonce: Number(data.readBigUInt64LE(48)),
    employeeAuthHandle: data.slice(56, 88),
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
 * Uses getProgramAccounts with memcmp filters on discriminator + business + stream_index.
 * Client-side verifies encrypted employee id handle matches the payout commitment.
 */
export async function getPendingPayoutsForWorker(
  connection: Connection,
  business: PublicKey,
  streamIndex: number,
): Promise<ShieldedPayoutV2Account[]> {
  const stream = await getEmployeeStreamV2Account(connection, business, streamIndex);
  if (!stream) return [];
  const employeeIdHandle = stream.encryptedEmployeeId;

  // Filter: discriminator at offset 0 + business pubkey at offset 8.
  const streamIndexBuf = Buffer.alloc(8);
  streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
  const accounts = await connection.getProgramAccounts(PAYROLL_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SHIELDED_PAYOUT_V2_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: business.toBase58() } },
      { memcmp: { offset: 40, bytes: bs58.encode(streamIndexBuf) } },
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

    // Verify encrypted employee id handle matches this worker's stream.
    const handleMatch = employeeIdHandle.length === payout.employeeAuthHash.length &&
      employeeIdHandle.every((b, i) => b === payout.employeeAuthHash[i]);
    if (!handleMatch) continue;

    pending.push(payout);
  }

  // Sort by creation time (newest first).
  pending.sort((a, b) => b.createdAt - a.createdAt);
  return pending;
}

/**
 * Auto-detect v4 payouts for a worker.
 * Filters by discriminator + business + employee_index and then verifies employee auth handle matches.
 */
export async function getPayoutsForEmployeeV4(
  connection: Connection,
  business: PublicKey,
  employeeIndex: number,
  options?: { includeClaimed?: boolean; includeCancelled?: boolean; includeExpired?: boolean; limit?: number }
): Promise<ShieldedPayoutV4Account[]> {
  const employee = await getEmployeeV4Account(connection, business, employeeIndex);
  if (!employee) return [];
  const employeeIdHandle = employee.encryptedEmployeeId;

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));

  const accounts = await connection.getProgramAccounts(PAYROLL_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SHIELDED_PAYOUT_V4_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: business.toBase58() } },
      { memcmp: { offset: 40, bytes: bs58.encode(employeeIndexBuf) } },
    ],
  });

  const now = Math.floor(Date.now() / 1000);
  const includeClaimed = options?.includeClaimed ?? true;
  const includeCancelled = options?.includeCancelled ?? false;
  const includeExpired = options?.includeExpired ?? false;
  const payouts: ShieldedPayoutV4Account[] = [];

  for (const { pubkey, account } of accounts) {
    const payout = parseShieldedPayoutV4(pubkey, account.data as Buffer);

    if (!includeClaimed && payout.claimed) continue;
    if (!includeCancelled && payout.cancelled) continue;
    if (!includeExpired && payout.expiresAt > 0 && now > payout.expiresAt) continue;

    const handleMatch =
      employeeIdHandle.length === payout.employeeAuthHandle.length &&
      employeeIdHandle.every((b, i) => b === payout.employeeAuthHandle[i]);
    if (!handleMatch) continue;

    payouts.push(payout);
  }

  payouts.sort((a, b) => b.createdAt - a.createdAt);
  if (options?.limit && payouts.length > options.limit) {
    return payouts.slice(0, options.limit);
  }
  return payouts;
}

function discriminatorMatches(data: Buffer, expected: Buffer): boolean {
  if (data.length < 8) return false;
  return data.subarray(0, 8).equals(expected);
}

function instructionDataToBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(bs58.decode(data));
  return Buffer.from(data);
}

function resolveMessageAccountKeys(message: any): PublicKey[] {
  try {
    if (typeof message?.getAccountKeys === 'function') {
      const keys = message.getAccountKeys();
      if (Array.isArray(keys?.staticAccountKeys)) {
        return keys.staticAccountKeys as PublicKey[];
      }
    }
  } catch {
    // fall through
  }

  if (Array.isArray(message?.accountKeys)) {
    return message.accountKeys.map((k: any) => {
      if (k instanceof PublicKey) return k;
      if (k?.pubkey) return new PublicKey(k.pubkey);
      return new PublicKey(k);
    });
  }
  return [];
}

/**
 * Fetch the latest payout receipt for a worker on a business.
 * This includes auto-routed keeper claims, so UI can always show
 * where the latest payout was delivered.
 */
export async function getLatestPayoutReceiptForWorker(
  connection: Connection,
  business: PublicKey,
  workerWallet: PublicKey,
): Promise<WorkerPayoutReceipt | null> {
  const workerDigest = await crypto.subtle.digest('SHA-256', new Uint8Array(workerWallet.toBytes()));
  const workerAuthHash = new Uint8Array(workerDigest);

  const accounts = await connection.getProgramAccounts(PAYROLL_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SHIELDED_PAYOUT_V2_DISCRIMINATOR) } },
      { memcmp: { offset: 8, bytes: business.toBase58() } },
    ],
  });

  const mine = accounts
    .map(({ pubkey, account }) => parseShieldedPayoutV2(pubkey, account.data as Buffer))
    .filter((payout) =>
      workerAuthHash.length === payout.employeeAuthHash.length &&
      workerAuthHash.every((b, i) => b === payout.employeeAuthHash[i]),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  if (mine.length === 0) return null;
  const latest = mine[0]!;

  let bufferTx: string | null = null;
  let claimTx: string | null = null;
  let destinationTokenAccount: string | null = null;

  try {
    const sigs = await connection.getSignaturesForAddress(latest.address, { limit: 20 }, 'confirmed');
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await connection.getTransaction(s.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;

      const msg: any = tx.transaction.message as any;
      const accountKeys = resolveMessageAccountKeys(msg);
      const instructions: any[] = Array.isArray(msg?.compiledInstructions)
        ? msg.compiledInstructions
        : [];

      for (const ix of instructions) {
        const programId = accountKeys[ix.programIdIndex];
        if (!programId || !programId.equals(PAYROLL_PROGRAM_ID)) continue;
        const data = instructionDataToBuffer(ix.data);

        if (discriminatorMatches(data, DISCRIMINATORS.process_withdraw_request_v2)) {
          const payoutPdaIdx = ix.accountKeyIndexes?.[6];
          const payoutPda = typeof payoutPdaIdx === 'number' ? accountKeys[payoutPdaIdx] : null;
          if (payoutPda && payoutPda.equals(latest.address) && !bufferTx) {
            bufferTx = s.signature;
          }
        }

        if (discriminatorMatches(data, DISCRIMINATORS.keeper_claim_on_behalf_v2)) {
          const payoutPdaIdx = ix.accountKeyIndexes?.[3];
          const destinationIdx = ix.accountKeyIndexes?.[5];
          const payoutPda = typeof payoutPdaIdx === 'number' ? accountKeys[payoutPdaIdx] : null;
          const destination = typeof destinationIdx === 'number' ? accountKeys[destinationIdx] : null;
          if (payoutPda && payoutPda.equals(latest.address)) {
            if (!claimTx) claimTx = s.signature;
            if (destination && !destinationTokenAccount) {
              destinationTokenAccount = destination.toBase58();
            }
          }
        }

        if (discriminatorMatches(data, DISCRIMINATORS.claim_payout_v2)) {
          const payoutPdaIdx = ix.accountKeyIndexes?.[2];
          const destinationIdx = ix.accountKeyIndexes?.[4];
          const payoutPda = typeof payoutPdaIdx === 'number' ? accountKeys[payoutPdaIdx] : null;
          const destination = typeof destinationIdx === 'number' ? accountKeys[destinationIdx] : null;
          if (payoutPda && payoutPda.equals(latest.address)) {
            if (!claimTx) claimTx = s.signature;
            if (destination && !destinationTokenAccount) {
              destinationTokenAccount = destination.toBase58();
            }
          }
        }
      }

      if (claimTx && bufferTx && destinationTokenAccount) break;
    }
  } catch {
    // Best-effort only; receipt still returns core payout data.
  }

  return {
    streamIndex: latest.streamIndex,
    nonce: latest.nonce,
    payoutPda: latest.address.toBase58(),
    payoutTokenAccount: latest.payoutTokenAccount.toBase58(),
    createdAt: latest.createdAt,
    claimed: latest.claimed,
    cancelled: latest.cancelled,
    bufferTx,
    claimTx,
    destinationTokenAccount,
  };
}
/**
 * Worker claims a shielded payout (Hop 2 of 2-hop).
 * ShieldedPayoutV2 PDA signs the transfer from payout_token_account to claimer.
 * NO vault or employer accounts in this tx = full metadata break.
 */


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

/**
 * Scan for an employment record matching the user's wallet.
 * Iterates backwards through businesses to find the most recent matching record.
 */
export async function findEmploymentRecordV4(
  connection: Connection,
  wallet: WalletContextState,
  limit = 20
): Promise<{ businessIndex: number; employeeIndex: number } | null> {
  if (!wallet.publicKey || !wallet.signMessage) {
    throw new Error('Wallet not connected or cannot sign messages');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const master = await getMasterVaultV4Account(connection);
  if (!master) throw new Error('MasterVaultV4 not initialized.');

  const nextBusinessIndex = Number(master.nextBusinessIndex);
  const startBusiness = Math.max(0, nextBusinessIndex - limit);

  // 1. Identify a fingerprint (hash) for the current user once.
  const myHash = await hashPubkeyToU128(wallet.publicKey);

  const allCandidates: { businessIndex: number; employeeIndex: number; handle: bigint; allowancePda: PublicKey }[] = [];

  // 2. Iterate businesses backwards to collect all potential employee handles
  for (let bIdx = nextBusinessIndex - 1; bIdx >= startBusiness; bIdx -= 1) {
    const [businessPDA] = getBusinessV4PDA(masterVaultPDA, bIdx);
    const business = await getBusinessV4AccountByAddress(connection, businessPDA);
    if (!business) continue;

    const nextEmployeeIndex = Number(business.nextEmployeeIndex);
    const startEmployee = Math.max(0, nextEmployeeIndex - limit);

    const employeePDAs: PublicKey[] = [];
    const indices: number[] = [];

    for (let eIdx = nextEmployeeIndex - 1; eIdx >= startEmployee; eIdx -= 1) {
      const [ePda] = getEmployeeV4PDA(businessPDA, eIdx);
      employeePDAs.push(ePda);
      indices.push(eIdx);
    }

    if (employeePDAs.length === 0) continue;

    // Batch fetch employee accounts to see handles
    const accounts = await connection.getMultipleAccountsInfo(employeePDAs, 'confirmed');

    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      if (!account) continue;

      // Extract handle from ciphertext
      const handle = extractHandleFromCiphertext32(account.data.slice(48, 80));
      if (handle === 0n) continue;

      const allowancePda = getIncoAllowancePda(handle, wallet.publicKey);

      allCandidates.push({
        businessIndex: bIdx,
        employeeIndex: indices[i],
        handle,
        allowancePda,
      });
    }
  }

  if (allCandidates.length === 0) return null;

  // 3. Pre-filter candidates by checking if the IncoAllowance PDA actually exists on-chain.
  // This prevents the Covalidator "Address is not allowed to decrypt this handle" error.
  const allowancePdas = allCandidates.map((c) => c.allowancePda);
  const allowanceAccounts: (AccountInfo<Buffer> | null)[] = [];

  // getMultipleAccountsInfo has a pubkey limit of 100 per request
  for (let i = 0; i < allowancePdas.length; i += 100) {
    const chunk = allowancePdas.slice(i, i + 100);
    const results = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
    allowanceAccounts.push(...results);
  }

  const authorizedCandidates = allCandidates.filter((_, idx) => allowanceAccounts[idx] !== null);

  if (authorizedCandidates.length === 0) return null;

  try {
    // 4. One single signature request for all AUTHORIZED candidates
    const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
    const handlesToDecrypt = authorizedCandidates.map((c) => c.handle.toString());
    const CHUNK_SIZE = 5; // Decrypt 5 handles at a time to prevent timeout

    for (let i = 0; i < handlesToDecrypt.length; i += CHUNK_SIZE) {
      const chunkOptions = handlesToDecrypt.slice(i, i + CHUNK_SIZE);
      const chunkCandidates = authorizedCandidates.slice(i, i + CHUNK_SIZE);

      const results = await decrypt(chunkOptions, {
        address: wallet.publicKey,
        signMessage: wallet.signMessage,
      });

      if (results && results.plaintexts) {
        for (let j = 0; j < results.plaintexts.length; j += 1) {
          const plainText = BigInt(results.plaintexts[j]);
          if (plainText === myHash) {
            // MATCH FOUND!
            return {
              businessIndex: chunkCandidates[j].businessIndex,
              employeeIndex: chunkCandidates[j].employeeIndex,
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed batch decryption for Magic Scan:', err);
    throw err;
  }

  return null;
}
export async function initRateHistoryV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number
): Promise<{ txid: string; rateHistoryPDA: PublicKey }> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [rateHistoryPDA] = getRateHistoryV4PDA(businessPDA, employeeIndex);

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const data = Buffer.concat([DISCRIMINATORS.init_rate_history_v4, employeeIndexBuf]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
      { pubkey: rateHistoryPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PAYROLL_PROGRAM_ID,
    data,
  });

  const txid = await sendAndConfirmTransaction(connection, wallet, instruction);
  return { txid, rateHistoryPDA };
}
export async function updateSalaryRateV4(
  connection: Connection,
  wallet: WalletContextState,
  businessPDA: PublicKey,
  employeeIndex: number,
  salaryLamports: bigint,
  requiredDepositAmount: bigint = 0n
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Wallet not connected');
  }

  const [masterVaultPDA] = getMasterVaultV4PDA();
  const [streamConfigPDA] = getStreamConfigV4PDA(businessPDA);
  const [employeePDA] = getEmployeeV4PDA(businessPDA, employeeIndex);
  const [rateHistoryPDA] = getRateHistoryV4PDA(businessPDA, employeeIndex);

  const encryptedSalary = await encryptForInco(salaryLamports);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(encryptedSalary.length);

  const employeeIndexBuf = Buffer.alloc(8);
  employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
  const requiredAmountBuf = Buffer.alloc(8);
  requiredAmountBuf.writeBigUInt64LE(requiredDepositAmount);
  const data = Buffer.concat([
    DISCRIMINATORS.update_salary_rate_v4,
    employeeIndexBuf,
    lenBuf,
    encryptedSalary,
    requiredAmountBuf,
  ]);

  const instruction = new TransactionInstruction({
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: masterVaultPDA, isSigner: false, isWritable: false },
      { pubkey: businessPDA, isSigner: false, isWritable: false },
      { pubkey: streamConfigPDA, isSigner: false, isWritable: true },
      { pubkey: employeePDA, isSigner: false, isWritable: true },
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
