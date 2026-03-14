use anchor_lang::prelude::*;

use crate::state::EncryptedHandle;

// ============================================================
// Shielded Payout V2 (Phase 2b: True 2-Hop Privacy)
// ============================================================

/// A shielded payout account that breaks the Employer → Worker on-chain link.
///
/// Flow:
///   1. Keeper triggers `process_withdraw_request_v2` → funds move from Vault → payout_token_account.
///   2. Worker calls `claim_payout_v2` → funds move from payout_token_account → Worker's token account.
///
/// Explorer sees:
///   - Tx1: Vault → PDA token acct (no worker identity visible)
///   - Tx2: PDA token acct → Worker (no employer identity visible)
///
/// Seeds: [b"shielded_payout", business, stream_index_bytes, nonce_bytes]
#[account]
pub struct ShieldedPayoutV2 {
    /// Parent business.
    pub business: Pubkey,
    /// Stream index this payout belongs to.
    pub stream_index: u64,
    /// One-time nonce to prevent PDA reuse (monotonically increasing per stream).
    pub nonce: u64,
    /// Encrypted employee identity handle (Inco euint128 handle bytes).
    /// Used for allowance-based claim authorization.
    pub employee_auth_hash: [u8; 32],
    /// Encrypted amount handle (Inco euint128).
    /// The actual payout amount — only resolvable by Inco TEE.
    pub encrypted_amount: EncryptedHandle,
    /// Whether this payout has been claimed.
    pub claimed: bool,
    /// Whether this payout has been cancelled (expired/reclaimed by owner).
    pub cancelled: bool,
    /// Timestamp when this payout was created.
    pub created_at: i64,
    /// Timestamp after which this payout can be cancelled by the business owner.
    /// 0 = no expiry (default: 7 days from creation).
    pub expires_at: i64,
    /// Inco token account that holds the buffered funds (intermediate hop).
    /// Stored so the worker frontend can auto-discover it.
    pub payout_token_account: Pubkey,
    /// PDA bump.
    pub bump: u8,
}

impl ShieldedPayoutV2 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // stream_index
        8 +                      // nonce
        32 +                     // employee_auth_hash
        32 +                     // encrypted_amount (EncryptedHandle)
        1 +                      // claimed
        1 +                      // cancelled
        8 +                      // created_at
        8 +                      // expires_at
        32 +                     // payout_token_account
        1;                       // bump

    /// Default expiry duration: 7 days in seconds.
    pub const DEFAULT_EXPIRY_SECS: i64 = 7 * 24 * 60 * 60;
}
