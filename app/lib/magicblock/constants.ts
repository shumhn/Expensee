// Shared MagicBlock IDs and runtime flags used across the app.
import { PublicKey } from '@solana/web3.js';

export const MAGICBLOCK_DELEGATION_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM ||
    'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
);

export const MAGICBLOCK_PERMISSION_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_PERMISSION_PROGRAM ||
    'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1'
);

export const MAGICBLOCK_MAGIC_PROGRAM = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM ||
    'Magic11111111111111111111111111111111111111'
);

export const MAGICBLOCK_MAGIC_CONTEXT = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT ||
    'MagicContext1111111111111111111111111111111'
);

export const MAGICBLOCK_MAGIC_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM_ID ||
    'Magic11111111111111111111111111111111111111'
);

export const TEE_VALIDATOR = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR ||
    'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'
);

export const MAGICBLOCK_TEE_VALIDATOR_IDENTITY = new PublicKey(
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_VALIDATOR ||
    'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'
);

export const MAGICBLOCK_TEE_ENABLED = process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED === 'true';

export const MAGICBLOCK_TEE_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL || 'https://tee.magicblock.app';

export const TEE_MODE_STORAGE_KEY = 'expensee_tee_mode_v4';
export const TEE_TOKEN_STORAGE_PREFIX = 'expensee_tee_token_v4:';
