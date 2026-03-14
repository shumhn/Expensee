use anchor_lang::prelude::*;

// ============================================================
// External Program IDs (Devnet)
// ============================================================

/// Inco Lightning Program ID: 5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj
pub const INCO_LIGHTNING_ID: Pubkey = Pubkey::new_from_array([
    0x48, 0x6d, 0x8a, 0xee, 0xa3, 0x8b, 0xb4, 0xc5,
    0x86, 0x7e, 0x4f, 0x63, 0xc4, 0x5f, 0x41, 0xd4,
    0x57, 0x32, 0x0b, 0xb5, 0xa6, 0x57, 0xc2, 0xd7,
    0xde, 0x66, 0x1c, 0xbe, 0xa3, 0x7e, 0xa7, 0x34,
]);

/// Inco Token Program ID: 4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N
pub const INCO_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x35, 0xca, 0x0b, 0xad, 0xfd, 0xf2, 0x84, 0xbe,
    0xaf, 0x06, 0x4b, 0xc1, 0x86, 0xb9, 0x7a, 0x5f,
    0xe3, 0x07, 0x31, 0x54, 0xa6, 0x16, 0xd6, 0xa6,
    0x54, 0x15, 0x33, 0xa0, 0x94, 0xd3, 0xa5, 0xf9,
]);

// Default MagicBlock ER validator identity (Devnet EU).
// NOTE: Avoid tee.magicblock.app on devnet unless you have a TEE auth token.
pub const TEE_VALIDATOR: &str = "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e";
/// MagicBlock Permission Program (ACL) - Devnet
pub const MAGICBLOCK_PERMISSION_PROGRAM: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";

/// MagicBlock Magic Router Program
pub use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;

// ============================================================
// PDA Seeds (Privacy-Preserving: Index-Based)
// ============================================================

/// Business PDA seed
pub const BUSINESS_SEED: &[u8] = b"business";

/// Vault PDA seed - owns the token account
pub const VAULT_SEED: &[u8] = b"vault";

/// Vault token account seed
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";

/// v3 master vault seed (index-based privacy)
pub const MASTER_VAULT_V3_SEED: &[u8] = b"master_vault_v3";
/// v3 business entry seed (index-based privacy)
pub const BUSINESS_V3_SEED: &[u8] = b"business_v3";
/// v3 employee entry seed (index-based privacy)
pub const EMPLOYEE_V3_SEED: &[u8] = b"employee_v3";
/// v3 stream config seed
pub const STREAM_CONFIG_V3_SEED: &[u8] = b"stream_config_v3";
/// v3 withdraw request seed
pub const WITHDRAW_REQUEST_V3_SEED: &[u8] = b"withdraw_request_v3";
/// v3 shielded payout seed
pub const SHIELDED_PAYOUT_V3_SEED: &[u8] = b"shielded_payout_v3";

/// v4 master vault seed (pooled vault)
pub const MASTER_VAULT_V4_SEED: &[u8] = b"master_vault_v4b";
/// v4 business entry seed (index-based privacy)
pub const BUSINESS_V4_SEED: &[u8] = b"business_v4";
/// v4 employee entry seed (index-based privacy)
pub const EMPLOYEE_V4_SEED: &[u8] = b"employee_v4";
/// v4 user token registry seed (deterministic lookup)
pub const USER_TOKEN_V4_SEED: &[u8] = b"user_token_v4";
/// MagicBlock Permission PDA seed
pub const PERMISSION_SEED: &[u8] = b"permission:";
/// v4 stream config seed
pub const STREAM_CONFIG_V4_SEED: &[u8] = b"stream_config_v4";
/// v4 withdraw request seed
pub const WITHDRAW_REQUEST_V4_SEED: &[u8] = b"withdraw_request_v4";
/// v4 shielded payout seed
pub const SHIELDED_PAYOUT_V4_SEED: &[u8] = b"shielded_payout_v4";

/// v2 business stream config seed
pub const STREAM_CONFIG_V2_SEED: &[u8] = b"stream_config_v2";

/// v2 employee stream seed
pub const EMPLOYEE_V2_SEED: &[u8] = b"employee_v2";

/// v2 withdraw request seed
pub const WITHDRAW_REQUEST_V2_SEED: &[u8] = b"withdraw_request_v2";
/// v2 shielded payout seed (Phase 2: who-paid-whom privacy)
pub const SHIELDED_PAYOUT_V2_SEED: &[u8] = b"shielded_payout";
/// Default expiry for unclaimed shielded payouts: 7 days
pub const DEFAULT_PAYOUT_EXPIRY_SECS: i64 = 7 * 24 * 60 * 60;
pub const RATE_HISTORY_V2_SEED: &[u8] = b"rate_history_v2";
pub const RATE_HISTORY_V4_SEED: &[u8] = b"rate_history_v4";
pub const RATE_HISTORY_MAX_ENTRIES: usize = 16;

/// Max ciphertext payload accepted by program instructions
pub const MAX_CIPHERTEXT_BYTES: usize = 256;

/// Default and minimum settlement interval for auto-settle loop.
pub const DEFAULT_SETTLE_INTERVAL_SECS: u64 = 10;
pub const MIN_SETTLE_INTERVAL_SECS: u64 = 10;

/// Pause reason codes for stream config.
pub const PAUSE_REASON_NONE: u8 = 0;
pub const PAUSE_REASON_MANUAL: u8 = 1;
pub const PAUSE_REASON_COMPLIANCE: u8 = 2;
