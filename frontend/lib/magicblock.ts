/**
 * Production-oriented MagicBlock helpers.
 *
 * NOTE: v2 stream lifecycle (delegate -> accrue -> settle -> redelegate)
 * is executed through on-chain payroll instructions and keeper service,
 * not through local mock sessions.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAuthToken,
  verifyTeeRpcIntegrity,
} from '@magicblock-labs/ephemeral-rollups-sdk';

const MAGICBLOCK_TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL ||
  'https://tee.magicblock.app';

export interface MagicBlockConfig {
  solanaRpcUrl: string;
  network: 'devnet' | 'mainnet-beta';
  teeUrl?: string;
}

export interface TeeIntegrityStatus {
  ok: boolean;
  endpoint: string;
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
