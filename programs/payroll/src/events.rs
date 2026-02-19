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
pub struct EmployeeAdded {
    pub employee_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct DelegatedToTee {
    pub employee_index: u64,
    pub validator: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct UndelegatedFromTee {
    pub employee_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct PaymentProcessed {
    pub employee_index: u64,
    pub timestamp: i64,
    pub auto_payment: bool,
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
