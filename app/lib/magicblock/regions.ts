// Region helpers keep validator selection readable in the UI layer.
import { PublicKey } from '@solana/web3.js';
import { TEE_VALIDATOR } from './constants';

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

export function getMagicblockEndpointForRegion(region: MagicblockValidatorRegion): string {
  if (region === 'us') return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT_US || 'https://devnet-us.magicblock.app';
  if (region === 'asia') return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT_ASIA || 'https://devnet-as.magicblock.app';
  return process.env.NEXT_PUBLIC_MAGICBLOCK_ENDPOINT || 'https://devnet.magicblock.app';
}
