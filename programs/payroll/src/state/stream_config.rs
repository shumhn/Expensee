use anchor_lang::prelude::*;

#[account]
pub struct BusinessStreamConfigV2 {
    /// Parent business account.
    pub business: Pubkey,
    /// Authorized keeper for accrual/settlement operations.
    pub keeper_pubkey: Pubkey,
    /// Auto-settlement cadence in seconds.
    pub settle_interval_secs: u64,
    /// Stream index cursor.
    pub next_stream_index: u64,
    /// Global pause flag.
    pub is_paused: bool,
    /// Pause reason code.
    pub pause_reason: u8,
    /// PDA bump.
    pub bump: u8,
}

impl BusinessStreamConfigV2 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        32 +                     // keeper_pubkey
        8 +                      // settle_interval_secs
        8 +                      // next_stream_index
        1 +                      // is_paused
        1 +                      // pause_reason
        1 +                      // bump
        32;                      // padding
}
