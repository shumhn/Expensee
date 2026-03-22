// TEE auth stays isolated here so pages can import MagicBlock-specific behavior directly.
import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAuthToken,
  verifyTeeRpcIntegrity,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import {
  MAGICBLOCK_TEE_ENABLED,
  MAGICBLOCK_TEE_URL,
  MAGICBLOCK_TEE_VALIDATOR_IDENTITY,
  TEE_MODE_STORAGE_KEY,
  TEE_TOKEN_STORAGE_PREFIX,
} from './constants';

export interface MagicBlockConfig {
  solanaRpcUrl: string;
  network: 'devnet' | 'mainnet-beta';
  teeUrl?: string;
}

export interface TeeIntegrityStatus {
  ok: boolean;
  endpoint: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
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
  if (!exp) return true;
  const now = Math.floor(Date.now() / 1000);
  return exp - 60 > now;
}

export function assertTeeAllowed(validator: PublicKey): void {
  if (MAGICBLOCK_TEE_ENABLED) return;
  if (validator.equals(MAGICBLOCK_TEE_VALIDATOR_IDENTITY)) {
    throw new Error(
      'TEE validator is token-gated on devnet (tee.magicblock.app). Set NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED=true to allow.'
    );
  }
}

export function isMagicblockTeeModeEnabled(): boolean {
  if (!isBrowser()) return false;
  return window.localStorage.getItem(TEE_MODE_STORAGE_KEY) === 'true';
}

export function setMagicblockTeeModeEnabled(enabled: boolean): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(TEE_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
}

export function getStoredTeeToken(pubkey: PublicKey): string | null {
  if (!isBrowser()) return null;
  const key = getTeeTokenStorageKey(pubkey);
  const token = window.localStorage.getItem(key);
  return token && token.trim().length > 0 ? token : null;
}

export function isStoredTeeTokenValid(pubkey: PublicKey): boolean {
  const token = getStoredTeeToken(pubkey);
  if (!token) return false;
  return isTeeTokenValid(token);
}

export class MagicBlockClient {
  private readonly connection: Connection;
  private readonly teeUrl: string;
  private readonly network: 'devnet' | 'mainnet-beta';

  constructor(config: MagicBlockConfig) {
    this.connection = new Connection(config.solanaRpcUrl, 'confirmed');
    this.teeUrl = config.teeUrl || MAGICBLOCK_TEE_URL;
    this.network = config.network;
  }

  getConnection(): Connection {
    return this.connection;
  }

  getTeeEndpoint(): string {
    return this.teeUrl;
  }

  getNetwork(): 'devnet' | 'mainnet-beta' {
    return this.network;
  }

  async verifyIntegrity(): Promise<TeeIntegrityStatus> {
    await verifyTeeRpcIntegrity(this.teeUrl);
    return {
      ok: true,
      endpoint: this.teeUrl,
    };
  }

  async getTeeAuthToken(
    ownerPublicKey: PublicKey,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
  ): Promise<string> {
    const auth = await getAuthToken(this.teeUrl, ownerPublicKey, signMessage);
    return auth.token;
  }
}

export function createMagicBlockClient(): MagicBlockClient {
  return new MagicBlockClient({
    solanaRpcUrl:
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      'https://api.devnet.solana.com',
    network: 'devnet',
    teeUrl: MAGICBLOCK_TEE_URL,
  });
}

export async function ensureTeeAuthToken(wallet: {
  publicKey: PublicKey | null;
  signMessage?: ((message: Uint8Array) => Promise<Uint8Array>) | null;
}): Promise<string> {
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

export async function getTeeConnectionForWallet(wallet: {
  publicKey: PublicKey | null;
  signMessage?: ((message: Uint8Array) => Promise<Uint8Array>) | null;
}): Promise<Connection | null> {
  if (!MAGICBLOCK_TEE_ENABLED) return null;
  if (!isMagicblockTeeModeEnabled()) return null;
  const token = await ensureTeeAuthToken(wallet);
  const url = `${MAGICBLOCK_TEE_URL}?token=${token}`;
  return new Connection(url, 'confirmed');
}
