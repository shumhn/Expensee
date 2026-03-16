use anchor_lang::prelude::*;

use crate::state::EncryptedHandle;

// ============================================================
// V4 Pooled-Vault Account Structures (Single Global Vault)
// ============================================================

#[account]
pub struct MasterVaultV4 {
    /// Authority that can register businesses.
    pub authority: Pubkey,

    /// Global pooled Inco token account (custody).
    pub vault_token_account: Pubkey,

    /// Confidential mint for pooled vault.
    pub mint: Pubkey,

    /// Whether pooled transfers use confidential tokens.
    pub use_confidential_tokens: bool,

    /// ENCRYPTED total business count.
    pub encrypted_business_count: EncryptedHandle,

    /// ENCRYPTED total employee count.
    pub encrypted_employee_count: EncryptedHandle,

    /// ENCRYPTED total vault balance (shielded pool TVL).
    pub encrypted_total_balance: EncryptedHandle,

    /// Next business index (used in PDA seeds).
    pub next_business_index: u64,

    /// Active flag.
    pub is_active: bool,

    /// PDA bump.
    pub bump: u8,
}

impl MasterVaultV4 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // authority
        32 +                     // vault_token_account
        32 +                     // mint
        1 +                      // use_confidential_tokens
        32 +                     // encrypted_business_count
        32 +                     // encrypted_employee_count
        32 +                     // encrypted_total_balance
        8 +                      // next_business_index
        1 +                      // is_active
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct BusinessEntryV4 {
    /// Parent master vault.
    pub master_vault: Pubkey,

    /// Business index (used in PDA seeds).
    pub business_index: u64,

    /// ENCRYPTED employer ID (hash of pubkey).
    pub encrypted_employer_id: EncryptedHandle,

    /// Authority allowed to manage this business (deposit, config, add employee).
    pub deposit_authority: Pubkey,

    /// ENCRYPTED business balance (pooled ledger entry).
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

impl BusinessEntryV4 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // master_vault
        8 +                      // business_index
        32 +                     // encrypted_employer_id
        32 +                     // deposit_authority
        32 +                     // encrypted_balance
        32 +                     // encrypted_employee_count
        8 +                      // next_employee_index
        1 +                      // is_active
        1 +                      // bump
        32;                      // padding
}

#[account]
pub struct EmployeeEntryV4 {
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

impl EmployeeEntryV4 {
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
// V4 Rate History (Selective Disclosure)
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct RateHistoryEntryV4 {
    pub effective_at: i64,
    pub encrypted_salary_rate: EncryptedHandle,
}

#[account]
pub struct RateHistoryV4 {
    pub business: Pubkey,
    pub employee_index: u64,
    pub count: u8,
    pub bump: u8,
    pub _reserved: [u8; 6],
    pub entries: [RateHistoryEntryV4; crate::constants::RATE_HISTORY_MAX_ENTRIES],
}

impl RateHistoryV4 {
    pub const LEN: usize =
        32 + // business
        8 +  // employee_index
        1 +  // count
        1 +  // bump
        6 +  // reserved/padding
        (crate::constants::RATE_HISTORY_MAX_ENTRIES * (8 + 32)); // entries (effective_at + handle)
}

#[account]
pub struct BusinessStreamConfigV4 {
    /// Parent business entry.
    pub business: Pubkey,
    /// Reserved legacy field (was keeper pubkey in earlier versions).
    pub reserved_authority: [u8; 32],
    /// Auto-settlement cadence in seconds.
    pub settle_interval_secs: u64,
    /// Global pause flag.
    pub is_paused: bool,
    /// Pause reason code.
    pub pause_reason: u8,
    /// PDA bump.
    pub bump: u8,
}

impl BusinessStreamConfigV4 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        32 +                     // reserved_authority
        8 +                      // settle_interval_secs
        1 +                      // is_paused
        1 +                      // pause_reason
        1 +                      // bump
        32;                      // padding
}

// ============================================================
// V4 User Token Registry (Deterministic Lookup)
// ============================================================

#[account]
pub struct UserTokenAccountV4 {
    /// Wallet owner for this registry entry.
    pub owner: Pubkey,
    /// Confidential mint for this token account.
    pub mint: Pubkey,
    /// Linked Inco token account (keypair-based).
    pub inco_token_account: Pubkey,
    /// ENCRYPTED balance handle (optional cache).
    pub encrypted_balance: EncryptedHandle,
    /// Initialization timestamp.
    pub initialized_at: i64,
    /// PDA bump.
    pub bump: u8,
}

impl UserTokenAccountV4 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // owner
        32 +                     // mint
        32 +                     // inco_token_account
        32 +                     // encrypted_balance
        8 +                      // initialized_at
        1 +                      // bump
        32;                      // padding
}

// ============================================================
// V4 Withdraw + Payout
// ============================================================

#[account]
pub struct WithdrawRequestV4 {
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

impl WithdrawRequestV4 {
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
pub struct ShieldedPayoutV4 {
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

impl ShieldedPayoutV4 {
    pub const DEFAULT_EXPIRY_SECS: i64 = 7 * 24 * 60 * 60;

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
        1 +                      // bump
        32;                      // padding
}
