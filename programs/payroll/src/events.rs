use anchor_lang::prelude::*;

// ============================================================
// Events (Privacy-Preserving: No pubkeys or amounts)
// ============================================================

#[event]
pub struct BusinessRegistered {
    pub timestamp: i64,
}

#[event]
pub struct VaultInitialized {
    pub timestamp: i64,
}

#[event]
pub struct VaultTokenAccountRotated {
    pub timestamp: i64,
}

#[event]
pub struct FundsDeposited {
    pub timestamp: i64,
}

#[event]
pub struct StreamPeriodCompleted {
    pub timestamp: i64,
}

#[event]
pub struct WithdrawSettled {
    /// Timestamp of the settlement.
    pub timestamp: i64,
}

#[event]
pub struct StreamDeactivated {
    pub timestamp: i64,
}

// ============================================================
// Phase 2: Shielded Payout Events
// ============================================================

#[event]
pub struct PayoutBuffered {
    /// When the payout was created.
    pub timestamp: i64,
}

#[event]
pub struct PayoutClaimed {
    /// Timestamp of the claim.
    pub timestamp: i64,
}

#[event]
pub struct PayoutCancelled {
    /// Timestamp of the cancellation.
    pub timestamp: i64,
}
