use anchor_lang::prelude::*;

#[account]
pub struct WithdrawRequestV2 {
    /// Parent business.
    pub business: Pubkey,
    /// Stream index for employee stream.
    pub stream_index: u64,
    /// Employee wallet that requested withdrawal.
    pub requester: Pubkey,
    /// Request timestamp.
    pub requested_at: i64,
    /// Whether request is pending.
    pub is_pending: bool,
    /// PDA bump.
    pub bump: u8,
}

impl WithdrawRequestV2 {
    pub const LEN: usize = 8 +  // discriminator
        32 +                     // business
        8 +                      // stream_index
        32 +                     // requester
        8 +                      // requested_at
        1 +                      // is_pending
        1 +                      // bump
        32;                      // padding
}
