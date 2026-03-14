use anchor_lang::prelude::*;

use crate::state::EncryptedHandle;

#[account]
pub struct Business {
    /// Owner wallet
    pub owner: Pubkey,

    /// Reference to BusinessVault
    pub vault: Pubkey,

    /// Next employee index (for index-based PDAs)
    pub next_employee_index: u64,

    /// ENCRYPTED employee count
    pub encrypted_employee_count: EncryptedHandle,

    /// Is business active
    pub is_active: bool,

    /// Creation timestamp
    pub created_at: i64,

    /// PDA bump
    pub bump: u8,

    /// ENCRYPTED employer identity handle (e.g., hashed pubkey via Inco).
    /// Note: owner pubkey remains for authority; this adds an encrypted copy for privacy analytics.
    pub encrypted_employer_id: EncryptedHandle,
}

impl Business {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // owner
        32 +                     // vault
        8 +                      // next_employee_index
        32 +                     // encrypted_employee_count
        1 +                      // is_active
        8 +                      // created_at
        1 +                      // bump
        32;                      // encrypted_employer_id
}

#[account]
pub struct BusinessVault {
    /// Parent business
    pub business: Pubkey,

    /// Token mint
    pub mint: Pubkey,

    /// Inco Token account (owned by this vault PDA)
    pub token_account: Pubkey,

    /// ENCRYPTED total balance
    pub encrypted_balance: EncryptedHandle,

    /// PDA bump
    pub bump: u8,
}

impl BusinessVault {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        32 +                     // mint
        32 +                     // token_account
        32 +                     // encrypted_balance
        1 +                      // bump
        32;                      // padding
}
