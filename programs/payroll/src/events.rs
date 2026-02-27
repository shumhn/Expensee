use anchor_lang::prelude::*;

// ============================================================
// Events (Privacy-Preserving: No pubkeys or amounts)
// ============================================================

#[event]
pub struct BusinessRegistered {
    pub business_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct VaultInitialized {
    pub business: Pubkey,
    pub vault: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct VaultTokenAccountRotated {
    pub business: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FundsDeposited {
    pub business: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct StreamPeriodCompleted {
    pub stream_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawSettled {
    /// Stream index that was settled.
    pub stream_index: u64,
    /// The encrypted accrued handle value at the moment of settle.
    /// Auditors can decrypt this to verify the payout amount.
    pub accrued_handle: u128,
    /// Timestamp of the settlement.
    pub timestamp: i64,
}

#[event]
pub struct StreamDeactivated {
    pub stream_index: u64,
    pub timestamp: i64,
}

// ============================================================
// Phase 2: Shielded Payout Events
// ============================================================

#[event]
pub struct PayoutBuffered {
    /// Stream index the payout belongs to.
    pub stream_index: u64,
    /// One-time nonce for this payout.
    pub nonce: u64,
    /// Encrypted amount handle (for audit trail).
    pub amount_handle: u128,
    /// Inco token account holding the buffered funds.
    pub payout_token_account: Pubkey,
    /// When the payout was created.
    pub created_at: i64,
    /// When the payout expires (claimable until then).
    pub expires_at: i64,
}

#[event]
pub struct PayoutClaimed {
    /// Stream index the payout belongs to.
    pub stream_index: u64,
    /// One-time nonce for this payout.
    pub nonce: u64,
    /// Timestamp of the claim.
    pub claimed_at: i64,
}

#[event]
pub struct PayoutCancelled {
    /// Stream index the payout belongs to.
    pub stream_index: u64,
    /// One-time nonce for this payout.
    pub nonce: u64,
    /// Timestamp of the cancellation.
    pub cancelled_at: i64,
}
