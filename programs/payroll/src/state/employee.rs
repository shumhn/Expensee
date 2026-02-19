use anchor_lang::prelude::*;

use crate::constants::RATE_HISTORY_MAX_ENTRIES;

// ============================================================
// Encrypted Value Handle
// ============================================================

/// Handle to an encrypted 128-bit value stored in Inco Lightning
/// This is just a 32-byte handle/reference to the ciphertext
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct EncryptedHandle {
    pub handle: [u8; 32],
}

// ============================================================
// Rate History (Selective Disclosure)
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct RateHistoryEntryV2 {
    pub effective_at: i64,
    pub encrypted_salary_rate: EncryptedHandle,
}

#[account]
pub struct RateHistoryV2 {
    pub business: Pubkey,
    pub stream_index: u64,
    pub count: u8,
    pub bump: u8,
    pub _reserved: [u8; 6],
    pub entries: [RateHistoryEntryV2; RATE_HISTORY_MAX_ENTRIES],
}

impl RateHistoryV2 {
    pub const LEN: usize =
        32 + // business
        8 +  // stream_index
        1 +  // count
        1 +  // bump
        6 +  // reserved/padding
        (RATE_HISTORY_MAX_ENTRIES * (8 + 32)); // entries (effective_at + handle)
}

// ============================================================
// Employee Account Structs
// ============================================================

#[account]
pub struct Employee {
    /// Parent business
    pub business: Pubkey,

    /// Employee index (used in PDA, NOT wallet pubkey!)
    pub employee_index: u64,

    /// ENCRYPTED employee ID (hash of wallet pubkey)
    pub encrypted_employee_id: EncryptedHandle,

    /// ENCRYPTED salary rate (per second)
    pub encrypted_salary_rate: EncryptedHandle,

    /// ENCRYPTED accrued balance
    pub encrypted_accrued: EncryptedHandle,

    /// Last accrual timestamp
    pub last_accrual_time: i64,

    /// Is employee active
    pub is_active: bool,

    /// Is currently delegated to TEE
    pub is_delegated: bool,

    /// PDA bump
    pub bump: u8,
}

impl Employee {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // employee_index
        32 +                     // encrypted_employee_id
        32 +                     // encrypted_salary_rate
        32 +                     // encrypted_accrued
        8 +                      // last_accrual_time
        1 +                      // is_active
        1 +                      // is_delegated
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct EmployeeStreamV2 {
    /// Parent business account.
    pub business: Pubkey,
    /// Stream index scoped to business stream config.
    pub stream_index: u64,
    /// SHA-256 hash commitment of employee wallet.
    pub employee_auth_hash: [u8; 32],
    /// Fixed payout destination account.
    pub employee_token_account: Pubkey,
    /// Encrypted salary rate handle.
    pub encrypted_salary_rate: EncryptedHandle,
    /// Encrypted accrued amount handle.
    pub encrypted_accrued: EncryptedHandle,
    /// Last accrual timestamp.
    pub last_accrual_time: i64,
    /// Last settlement timestamp.
    pub last_settle_time: i64,
    /// Stream active flag.
    pub is_active: bool,
    /// Delegation state.
    pub is_delegated: bool,
    /// PDA bump.
    pub bump: u8,
    /// Pay period start (unix timestamp). 0 = unbounded (legacy behavior).
    pub period_start: i64,
    /// Pay period end (unix timestamp). 0 = unbounded (legacy behavior).
    pub period_end: i64,
}

impl EmployeeStreamV2 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // stream_index
        32 +                     // employee_auth_hash
        32 +                     // employee_token_account
        32 +                     // encrypted_salary_rate
        32 +                     // encrypted_accrued
        8 +                      // last_accrual_time
        8 +                      // last_settle_time
        1 +                      // is_active
        1 +                      // is_delegated
        1 +                      // bump
        8 +                      // period_start
        8 +                      // period_end
        32;                      // padding
}
