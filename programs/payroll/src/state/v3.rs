use anchor_lang::prelude::*;

use crate::state::EncryptedHandle;

// ============================================================
// V3 Privacy-First Account Structures (Index-Based PDAs)
// ============================================================

#[account]
pub struct MasterVaultV3 {
    /// Authority that can register businesses.
    pub authority: Pubkey,

    /// ENCRYPTED total business count.
    pub encrypted_business_count: EncryptedHandle,

    /// ENCRYPTED total employee count.
    pub encrypted_employee_count: EncryptedHandle,

    /// Next business index (used in PDA seeds).
    pub next_business_index: u64,

    /// Active flag.
    pub is_active: bool,

    /// PDA bump.
    pub bump: u8,
}

impl MasterVaultV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // authority
        32 +                     // encrypted_business_count
        32 +                     // encrypted_employee_count
        8 +                      // next_business_index
        1 +                      // is_active
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct BusinessEntryV3 {
    /// Parent master vault.
    pub master_vault: Pubkey,

    /// Business index (used in PDA seeds).
    pub business_index: u64,

    /// ENCRYPTED employer ID (hash of pubkey).
    pub encrypted_employer_id: EncryptedHandle,

    /// Business vault PDA (token custody).
    pub vault: Pubkey,

    /// ENCRYPTED business balance.
    pub encrypted_balance: EncryptedHandle,

    /// ENCRYPTED employee count for this business.
    pub encrypted_employee_count: EncryptedHandle,

    /// Next employee index (used in PDA seeds).
    pub next_employee_index: u64,

    /// Active flag.
    pub is_active: bool,

    /// PDA bump.
    pub bump: u8,
}

impl BusinessEntryV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // master_vault
        8 +                      // business_index
        32 +                     // encrypted_employer_id
        32 +                     // vault
        32 +                     // encrypted_balance
        32 +                     // encrypted_employee_count
        8 +                      // next_employee_index
        1 +                      // is_active
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct EmployeeEntryV3 {
    /// Parent business entry.
    pub business: Pubkey,

    /// Employee index (used in PDA seeds).
    pub employee_index: u64,

    /// ENCRYPTED employee ID (hash of pubkey).
    pub encrypted_employee_id: EncryptedHandle,

    /// ENCRYPTED salary rate (per second).
    pub encrypted_salary_rate: EncryptedHandle,

    /// ENCRYPTED accrued amount.
    pub encrypted_accrued: EncryptedHandle,

    /// Last accrual timestamp.
    pub last_accrual_time: i64,

    /// Last settle timestamp.
    pub last_settle_time: i64,

    /// Active flag.
    pub is_active: bool,

    /// Delegation flag.
    pub is_delegated: bool,

    /// PDA bump.
    pub bump: u8,

    /// Pay period start (unix timestamp). 0 = unbounded.
    pub period_start: i64,

    /// Pay period end (unix timestamp). 0 = unbounded.
    pub period_end: i64,
}

impl EmployeeEntryV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // employee_index
        32 +                     // encrypted_employee_id
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

// ============================================================
// V3 Stream Config + Withdraw + Payout
// ============================================================

#[account]
pub struct BusinessStreamConfigV3 {
    /// Parent business entry.
    pub business: Pubkey,
    /// Authorized keeper for accrual/settlement operations.
    pub keeper_pubkey: Pubkey,
    /// Auto-settlement cadence in seconds.
    pub settle_interval_secs: u64,
    /// Global pause flag.
    pub is_paused: bool,
    /// Pause reason code.
    pub pause_reason: u8,
    /// PDA bump.
    pub bump: u8,
}

impl BusinessStreamConfigV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        32 +                     // keeper_pubkey
        8 +                      // settle_interval_secs
        1 +                      // is_paused
        1 +                      // pause_reason
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct WithdrawRequestV3 {
    /// Parent business entry.
    pub business: Pubkey,
    /// Employee index for this request.
    pub employee_index: u64,
    /// Encrypted employee identity handle bytes (auth commitment).
    pub requester_auth_handle: [u8; 32],
    /// Request timestamp.
    pub requested_at: i64,
    /// Whether request is pending.
    pub is_pending: bool,
    /// PDA bump.
    pub bump: u8,
}

impl WithdrawRequestV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // employee_index
        32 +                     // requester_auth_handle
        8 +                      // requested_at
        1 +                      // is_pending
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct ShieldedPayoutV3 {
    /// Parent business entry.
    pub business: Pubkey,
    /// Employee index this payout belongs to.
    pub employee_index: u64,
    /// One-time nonce to prevent PDA reuse.
    pub nonce: u64,
    /// Encrypted employee identity handle (auth commitment).
    pub employee_auth_handle: [u8; 32],
    /// Encrypted amount handle.
    pub encrypted_amount: EncryptedHandle,
    /// Whether this payout has been claimed.
    pub claimed: bool,
    /// Whether this payout has been cancelled.
    pub cancelled: bool,
    /// Timestamp when this payout was created.
    pub created_at: i64,
    /// Expiry timestamp (0 = no expiry).
    pub expires_at: i64,
    /// Inco token account holding buffered funds.
    pub payout_token_account: Pubkey,
    /// PDA bump.
    pub bump: u8,
}

impl ShieldedPayoutV3 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // employee_index
        8 +                      // nonce
        32 +                     // employee_auth_handle
        32 +                     // encrypted_amount
        1 +                      // claimed
        1 +                      // cancelled
        8 +                      // created_at
        8 +                      // expires_at
        32 +                     // payout_token_account
        1;                       // bump

    pub const DEFAULT_EXPIRY_SECS: i64 = 7 * 24 * 60 * 60;
}
