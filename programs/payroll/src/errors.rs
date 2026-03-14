use anchor_lang::prelude::*;

#[error_code]
pub enum PayrollError {
    #[msg("Invalid amount")]
    InvalidAmount,

    #[msg("Invalid ciphertext")]
    InvalidCiphertext,

    #[msg("Invalid timestamp")]
    InvalidTimestamp,

    #[msg("Employee is not active")]
    InactiveEmployee,

    #[msg("Business is not active")]
    InactiveBusiness,



    #[msg("Insufficient funds in vault")]
    InsufficientFunds,

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Ciphertext too large")]
    CiphertextTooLarge,

    #[msg("Unauthorized keeper")]
    UnauthorizedKeeper,

    #[msg("Invalid settlement interval")]
    InvalidSettleInterval,

    #[msg("Invalid stream index")]
    InvalidStreamIndex,

    #[msg("Invalid payout destination")]
    InvalidPayoutDestination,

    #[msg("Settlement called too soon")]
    SettleTooSoon,

    #[msg("Stream is paused")]
    StreamPaused,

    #[msg("Invalid employee auth hash")]
    InvalidEmployeeAuthHash,

    #[msg("Invalid pause reason")]
    InvalidPauseReason,

    #[msg("No accrued balance to settle")]
    NoAccruedBalance,

    #[msg("Invalid employee signer for this stream")]
    InvalidEmployeeSigner,

    #[msg("Invalid withdraw request")]
    InvalidWithdrawRequest,

    #[msg("Withdraw request is not pending")]
    WithdrawNotPending,

    #[msg("Stream is delegated; commit+undelegate first")]
    StreamDelegated,

    #[msg("Withdraw requester does not match stream auth")]
    InvalidWithdrawRequester,

    #[msg("Invalid rate history account")]
    InvalidRateHistory,

    #[msg("Rate history is full")]
    RateHistoryFull,

    #[msg("Invalid Inco token account")]
    InvalidIncoTokenAccount,

    #[msg("Invalid Inco allowance account")]
    InvalidIncoAllowanceAccount,

    #[msg("Invalid permission account")]
    InvalidPermissionAccount,

    #[msg("Invalid period bounds: end must be after start")]
    InvalidPeriodBounds,

    #[msg("Stream period has ended")]
    StreamPeriodEnded,

    #[msg("Invalid keeper pubkey")]
    InvalidKeeper,

    #[msg("Accrual must be fresh (within 120s) before settle")]
    AccrualNotFresh,

    #[msg("Payout has already been claimed")]
    PayoutAlreadyClaimed,

    #[msg("Payout has been cancelled")]
    PayoutAlreadyCancelled,

    #[msg("Payout has expired")]
    PayoutExpired,

    #[msg("Payout has not expired yet")]
    PayoutNotExpired,

    #[msg("Claimer is not authorized for this payout")]
    UnauthorizedClaimer,

    #[msg("Invalid claim authorization signature")]
    InvalidClaimAuthorization,

    #[msg("Claim authorization has expired")]
    ClaimAuthorizationExpired,

    #[msg("Caller is not the configured keeper")]
    KeeperNotAuthorized,

    #[msg("Fixed destination route is disabled; use private shield route")]
    FixedDestinationRouteDisabled,

}
