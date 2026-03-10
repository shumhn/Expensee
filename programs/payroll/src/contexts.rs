use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::{commit, delegate};

use crate::constants::*;
use crate::state::*;
use crate::errors::PayrollError;

// ============================================================
// Setup Contexts
// ============================================================

#[derive(Accounts)]
pub struct RegisterBusiness<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = Business::LEN,
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump
    )]
    pub business: Account<'info, Business>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        init,
        payer = owner,
        space = BusinessVault::LEN,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, BusinessVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateVaultTokenAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: New vault Inco Token account. Must be owned by INCO_TOKEN_PROGRAM_ID.
    pub new_vault_token_account: AccountInfo<'info>,
}

// ============================================================
// Deposit Contexts
// ============================================================

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Depositor's Inco Token account
    #[account(mut)]
    pub depositor_token_account: AccountInfo<'info>,

    /// CHECK: Vault's Inco Token account
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminWithdrawVaultV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Vault's Inco Token account
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Destination Inco token account (owner treasury/source token account)
    #[account(mut)]
    pub destination_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// V2 Stream Config Contexts
// ============================================================

#[derive(Accounts)]
pub struct InitStreamConfigV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        init,
        payer = owner,
        space = BusinessStreamConfigV2::LEN,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateKeeperV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The business being updated.
    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump,
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
}

// ============================================================
// V2 Employee Stream Contexts
// ============================================================

#[derive(Accounts)]
pub struct AddEmployeeStreamV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        init,
        payer = owner,
        space = EmployeeStreamV2::LEN,
        seeds = [EMPLOYEE_V2_SEED, business.key().as_ref(), &stream_config_v2.next_stream_index.to_le_bytes()],
        bump
    )]
    pub employee_stream_v2: Account<'info, EmployeeStreamV2>,

    /// CHECK: Inco Lightning program for registering ciphertext -> handle.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct GrantEmployeeViewAccessV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA. May be delegated; we only read/validate PDA key.
    pub employee: AccountInfo<'info>,

    /// CHECK: Employee wallet system account. Used for auth hash check and as Inco allowed address.
    pub employee_wallet: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for salary handle (owned by Inco Lightning).
    #[account(mut)]
    pub salary_allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for accrued handle (owned by Inco Lightning).
    #[account(mut)]
    pub accrued_allowance_account: AccountInfo<'info>,

    /// CHECK: Verified by address constraint (`#[account(address = INCO_LIGHTNING_ID)]`).
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct GrantKeeperViewAccessV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA. May be delegated; we only read/validate PDA key.
    pub employee: AccountInfo<'info>,

    /// CHECK: Keeper wallet system account (must match stream_config_v2.keeper_pubkey).
    pub keeper_wallet: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for salary handle (owned by Inco Lightning).
    #[account(mut)]
    pub salary_allowance_account: AccountInfo<'info>,

    /// CHECK: Verified by address constraint (`#[account(address = INCO_LIGHTNING_ID)]`).
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// V2 Delegation Contexts
// ============================================================

#[delegate]
#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct DelegateStreamV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Stream PDA that will be delegated to MagicBlock. Must match PDA(seeds) for (business, stream_index).
    /// We intentionally use UncheckedAccount to avoid Anchor trying to serialize/mutate after delegation changes ownership.
    pub employee: UncheckedAccount<'info>,

    /// CHECK: Optional validator
    pub validator: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AccrueV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        seeds = [EMPLOYEE_V2_SEED, business.key().as_ref(), &employee.stream_index.to_le_bytes()],
        bump = employee.bump
    )]
    pub employee: Account<'info, EmployeeStreamV2>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct AutoSettleStreamV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Employee stream account. May be owned by delegation program while delegated.
    #[account(mut)]
    pub employee: AccountInfo<'info>,

    /// CHECK: Vault token account.
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Fixed payout destination.
    #[account(mut)]
    pub employee_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    /// CHECK: MagicBlock scheduling program.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    /// CHECK: Global MagicBlock context account.
    #[account(mut, address = ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)]
    pub magic_context: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitAndUndelegateStreamV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream account. Must match v2 PDA for provided stream index.
    #[account(mut)]
    pub employee: AccountInfo<'info>,

    /// CHECK: MagicBlock scheduling program.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    /// CHECK: Global MagicBlock context account.
    #[account(mut, address = ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)]
    pub magic_context: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct RedelegateStreamV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Stream PDA that will be delegated to MagicBlock. Must match PDA(seeds) for (business, stream_index).
    /// We intentionally use UncheckedAccount to avoid Anchor trying to serialize/mutate after delegation changes ownership.
    pub employee: UncheckedAccount<'info>,

    /// CHECK: Optional validator
    pub validator: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// V2 Withdraw Contexts
// ============================================================

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct RequestWithdrawV2<'info> {
    /// Employee signs to request withdraw.
    #[account(mut)]
    pub employee_signer: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA for `(business, stream_index)`. Can be delegated.
    pub employee_stream: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = employee_signer,
        space = WithdrawRequestV2::LEN,
        seeds = [WITHDRAW_REQUEST_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump
    )]
    pub withdraw_request_v2: Account<'info, WithdrawRequestV2>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct KeeperRequestWithdrawV2<'info> {
    /// Authorized Keeper pays and signs on behalf of worker.
    #[account(mut, address = stream_config_v2.keeper_pubkey @ PayrollError::UnauthorizedKeeper)]
    pub keeper: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA for `(business, stream_index)`. Can be delegated.
    pub employee_stream: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = keeper,
        space = WithdrawRequestV2::LEN,
        seeds = [WITHDRAW_REQUEST_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump
    )]
    pub withdraw_request_v2: Account<'info, WithdrawRequestV2>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64, nonce: u64)]
pub struct ProcessWithdrawRequestV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Employee stream PDA for `(business, stream_index)`. Must be undelegated (owned by program).
    #[account(mut)]
    pub employee_stream: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [WITHDRAW_REQUEST_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump = withdraw_request_v2.bump,
    )]
    pub withdraw_request_v2: Account<'info, WithdrawRequestV2>,

    /// Phase 2b: Shielded payout PDA — initialized here as the "claim ticket".
    /// Funds are transferred FROM vault INTO payout_token_account (2-hop).
    #[account(
        init,
        payer = caller,
        space = ShieldedPayoutV2::LEN,
        seeds = [
            SHIELDED_PAYOUT_V2_SEED,
            business.key().as_ref(),
            &stream_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump
    )]
    pub shielded_payout: Account<'info, ShieldedPayoutV2>,

    /// CHECK: Vault's Inco Token account (source — funds leave here).
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Shielded payout PDA's Inco Token account (destination — funds arrive here).
    /// This is the intermediate hop account that breaks the employer↔worker link.
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// V2 Admin Contexts
// ============================================================

#[derive(Accounts)]
pub struct PauseStreamV2<'info> {

    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
}

#[derive(Accounts)]
pub struct ResumeStreamV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct DeactivateStreamV2<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA for `(business, stream_index)`. Must be undelegated (owned by program).
    #[account(mut)]
    pub employee_stream: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct InitRateHistoryV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    pub business: Account<'info, Business>,
    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        constraint = stream_config_v2.business == business.key()
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
    /// CHECK: v2 stream PDA (must be owned by this program for init)
    #[account(mut)]
    pub employee: AccountInfo<'info>,
    #[account(
        init,
        payer = caller,
        space = 8 + RateHistoryV2::LEN,
        seeds = [RATE_HISTORY_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump
    )]
    pub rate_history_v2: Account<'info, RateHistoryV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct UpdateSalaryRateV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    pub business: Account<'info, Business>,
    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        constraint = stream_config_v2.business == business.key()
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
    /// CHECK: v2 stream PDA (must be owned by this program for update)
    #[account(mut)]
    pub employee: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [RATE_HISTORY_V2_SEED, business.key().as_ref(), &stream_index.to_le_bytes()],
        bump = rate_history_v2.bump
    )]
    pub rate_history_v2: Account<'info, RateHistoryV2>,
    /// CHECK: Inco token program is not needed; Lightning is required for ciphertext registration + ops.
    pub inco_token_program: AccountInfo<'info>,
    /// CHECK: Verified by address constraint (`#[account(address = INCO_LIGHTNING_ID)]`).
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct GrantBonusV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    pub business: Account<'info, Business>,
    #[account(
        mut,
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        constraint = stream_config_v2.business == business.key()
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,
    /// CHECK: v2 stream PDA (must be owned by this program for bonus)
    #[account(mut)]
    pub employee: AccountInfo<'info>,
    /// CHECK: Inco token program is not needed; Lightning is required for ciphertext registration + ops.
    pub inco_token_program: AccountInfo<'info>,
    /// CHECK: Verified by address constraint (`#[account(address = INCO_LIGHTNING_ID)]`).
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ============================================================
// Phase 2b: Shielded Payout Contexts (True 2-Hop)
// ============================================================

/// Worker claims a shielded payout. PDA signs the transfer.
/// No vault or employer accounts in this tx — full metadata break.
#[derive(Accounts)]
#[instruction(stream_index: u64, nonce: u64)]
pub struct ClaimPayoutV2<'info> {
    /// Worker signs to claim their shielded payout.
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [
            SHIELDED_PAYOUT_V2_SEED,
            business.key().as_ref(),
            &stream_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump = shielded_payout.bump,
        constraint = shielded_payout.business == business.key(),
    )]
    pub shielded_payout: Account<'info, ShieldedPayoutV2>,

    /// CHECK: Shielded payout PDA's Inco token account (source — holds the buffered funds).
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Worker's destination Inco token account.
    #[account(mut)]
    pub claimer_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Business owner cancels an expired, unclaimed shielded payout.
/// Returns funds from payout_token_account back to vault_token_account (PDA signs).
#[derive(Accounts)]
#[instruction(stream_index: u64, nonce: u64)]
pub struct CancelExpiredPayoutV2<'info> {
    /// Business owner cancels expired unclaimed payout.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, owner.key().as_ref()],
        bump = business.bump,
        has_one = owner,
    )]
    pub business: Account<'info, Business>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business.key().as_ref()],
        bump = vault.bump,
        has_one = business,
    )]
    pub vault: Account<'info, BusinessVault>,

    #[account(
        mut,
        seeds = [
            SHIELDED_PAYOUT_V2_SEED,
            business.key().as_ref(),
            &stream_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump = shielded_payout.bump,
        constraint = shielded_payout.business == business.key(),
    )]
    pub shielded_payout: Account<'info, ShieldedPayoutV2>,

    /// CHECK: Shielded payout PDA's Inco token account (source — return funds from here).
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Vault's Inco Token account (destination — funds return here).
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// Phase 2: Programmable Viewing Policies
// ============================================================

/// Owner revokes decrypt access for a wallet on a stream's handles.
#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct RevokeViewAccessV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA. May be delegated; we only read/validate PDA key.
    pub employee: AccountInfo<'info>,

    /// CHECK: Wallet whose access is being revoked.
    pub target_wallet: AccountInfo<'info>,

    /// CHECK: Optional Keeper wallet for off-chain authorization.
    pub keeper_wallet: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for salary handle.
    #[account(mut)]
    pub salary_allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for accrued handle.
    #[account(mut)]
    pub accrued_allowance_account: AccountInfo<'info>,

    /// CHECK: Verified by address constraint.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Owner grants an auditor read-only access to salary + accrued handles.
#[derive(Accounts)]
#[instruction(stream_index: u64)]
pub struct GrantAuditorViewAccessV2<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    /// CHECK: Employee stream PDA.
    pub employee: AccountInfo<'info>,

    /// CHECK: Auditor wallet to grant access to.
    pub auditor_wallet: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for salary handle.
    #[account(mut)]
    pub salary_allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for accrued handle.
    #[account(mut)]
    pub accrued_allowance_account: AccountInfo<'info>,

    /// CHECK: Verified by address constraint.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// Phase 2: Keeper-Relayed Claims
// ============================================================

/// Keeper claims a shielded payout on behalf of the worker.
/// The worker's wallet never appears as a signer in this tx.
#[derive(Accounts)]
#[instruction(stream_index: u64, nonce: u64)]
pub struct KeeperClaimOnBehalfV2<'info> {
    /// Keeper is the signer (not the worker).
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        seeds = [BUSINESS_SEED, business.owner.as_ref()],
        bump = business.bump
    )]
    pub business: Account<'info, Business>,

    #[account(
        seeds = [STREAM_CONFIG_V2_SEED, business.key().as_ref()],
        bump = stream_config_v2.bump,
        has_one = business
    )]
    pub stream_config_v2: Account<'info, BusinessStreamConfigV2>,

    #[account(
        mut,
        seeds = [
            SHIELDED_PAYOUT_V2_SEED,
            business.key().as_ref(),
            &stream_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump = shielded_payout.bump,
        constraint = shielded_payout.business == business.key(),
    )]
    pub shielded_payout: Account<'info, ShieldedPayoutV2>,

    /// CHECK: Shielded payout PDA's Inco token account (source).
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Worker's destination Inco token account.
    #[account(mut)]
    pub destination_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    /// CHECK: Ed25519 program for signature verification.
    /// address = ed25519_program::ID
    pub ed25519_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}
