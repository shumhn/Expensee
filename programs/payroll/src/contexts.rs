use anchor_lang::prelude::*;

use ephemeral_rollups_sdk::anchor::delegate;

use crate::constants::*;
use crate::state::*;

// ============================================================
// Setup Contexts
// ============================================================

// ============================================================
// V4 Pooled Vault Contexts (Single Master Vault Pool)
// ============================================================

#[derive(Accounts)]
pub struct InitMasterVaultV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MasterVaultV4::LEN,
        seeds = [MASTER_VAULT_V4_SEED],
        bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPoolVaultV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    /// CHECK: Global pooled vault token account (Inco token account)
    pub vault_token_account: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RegisterBusinessV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        init,
        payer = authority,
        space = BusinessEntryV4::LEN,
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &master_vault_v4.next_business_index.to_le_bytes()
        ],
        bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitStreamConfigV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        init,
        payer = authority,
        space = BusinessStreamConfigV4::LEN,
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct AddEmployeeV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        mut,
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        init,
        payer = authority,
        space = EmployeeEntryV4::LEN,
        seeds = [
            EMPLOYEE_V4_SEED,
            business_v4.key().as_ref(),
            &employee_index.to_le_bytes()
        ],
        bump
    )]
    pub employee_v4: Account<'info, EmployeeEntryV4>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct InitRateHistoryV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump,
        constraint = stream_config_v4.business == business_v4.key()
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: v4 employee PDA (must be owned by this program for init)
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,

    #[account(
        init,
        payer = caller,
        space = 8 + RateHistoryV4::LEN,
        seeds = [RATE_HISTORY_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    pub rate_history_v4: Account<'info, RateHistoryV4>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct UpdateSalaryRateV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump,
        constraint = stream_config_v4.business == business_v4.key()
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: v4 employee PDA (must be owned by this program for update)
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [RATE_HISTORY_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump = rate_history_v4.bump
    )]
    pub rate_history_v4: Account<'info, RateHistoryV4>,

    /// CHECK: Inco token program is not needed; Lightning is required for ciphertext registration + ops.
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Verified by address constraint (`#[account(address = INCO_LIGHTNING_ID)]`).
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitUserTokenAccountV4<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = UserTokenAccountV4::LEN,
        seeds = [
            USER_TOKEN_V4_SEED,
            owner.key().as_ref(),
            mint.key().as_ref()
        ],
        bump
    )]
    pub user_token_account_v4: Account<'info, UserTokenAccountV4>,

    /// CHECK: Confidential mint for this registry entry.
    pub mint: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LinkUserTokenAccountV4<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [
            USER_TOKEN_V4_SEED,
            owner.key().as_ref(),
            user_token_account_v4.mint.as_ref()
        ],
        bump = user_token_account_v4.bump,
        constraint = user_token_account_v4.owner == owner.key()
    )]
    pub user_token_account_v4: Account<'info, UserTokenAccountV4>,

    /// CHECK: Inco token account to link.
    #[account(mut)]
    pub inco_token_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositV4<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        mut,
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    /// CHECK: Depositor Inco token account
    #[account(mut)]
    pub depositor_token_account: AccountInfo<'info>,

    /// CHECK: Pooled vault Inco token account
    #[account(mut)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    #[account(address = INCO_TOKEN_PROGRAM_ID)]
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AccrueV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: Employee entry (mutated via serialization)
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct RequestWithdrawV4<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: Employee entry (read via serialization)
    pub employee_v4: AccountInfo<'info>,

    /// CHECK: Inco allowance PDA for employee auth handle
    pub employee_id_allowance_account: AccountInfo<'info>,

    #[account(
        init,
        payer = requester,
        space = WithdrawRequestV4::LEN,
        seeds = [WITHDRAW_REQUEST_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    pub withdraw_request_v4: Account<'info, WithdrawRequestV4>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct ProcessWithdrawRequestV4<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        mut,
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: Employee entry (mutated via serialization)
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,

    #[account(
        mut,
        close = payer,
        seeds = [WITHDRAW_REQUEST_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump = withdraw_request_v4.bump
    )]
    pub withdraw_request_v4: Account<'info, WithdrawRequestV4>,

    /// CHECK: Inco allowance PDA for employee auth handle (required when caller is not keeper).
    pub employee_id_allowance_account: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = ShieldedPayoutV4::LEN,
        seeds = [SHIELDED_PAYOUT_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes(), &nonce.to_le_bytes()],
        bump
    )]
    pub shielded_payout_v4: Account<'info, ShieldedPayoutV4>,

    /// CHECK: Pooled vault Inco token account
    #[account(mut)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Payout Inco token account
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Simplified CrankSettleV4 — only needs caller + employee account.
/// The MagicBlock validator replays this instruction autonomously, so
/// we can only reference accounts that exist on the Ephemeral Rollup.
/// All other accounts (master_vault, business, stream_config, inco)
/// are NOT available on the ER and would cause silent failures.
#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct CrankSettleV4<'info> {
    /// CHECK: Employee entry (mutated via raw serialization)
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct ClaimPayoutV4<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        mut,
        seeds = [SHIELDED_PAYOUT_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes(), &nonce.to_le_bytes()],
        bump = shielded_payout_v4.bump
    )]
    pub shielded_payout_v4: Account<'info, ShieldedPayoutV4>,

    /// CHECK: Payout Inco token account
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Destination Inco token account
    #[account(mut)]
    pub destination_token_account: AccountInfo<'info>,

    /// CHECK: Allowance PDA (Inco Lightning allow)
    pub allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct CancelExpiredPayoutV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        mut,
        seeds = [SHIELDED_PAYOUT_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes(), &nonce.to_le_bytes()],
        bump = shielded_payout_v4.bump
    )]
    pub shielded_payout_v4: Account<'info, ShieldedPayoutV4>,

    /// CHECK: Payout Inco token account
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Pooled vault Inco token account
    #[account(mut)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// V4 Delegation Contexts
// ============================================================

#[delegate]
#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct DelegateStreamV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump,
        constraint = stream_config_v4.business == business_v4.key()
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Employee entry PDA that will be delegated to MagicBlock.
    pub employee_v4: UncheckedAccount<'info>,

    /// CHECK: Permission buffer PDA (permission program owner).
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATE_BUFFER_TAG, permission.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission_buffer: AccountInfo<'info>,

    /// CHECK: Permission delegation record PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_RECORD_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub permission_delegation_record: AccountInfo<'info>,

    /// CHECK: Permission delegation metadata PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_METADATA_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub permission_delegation_metadata: AccountInfo<'info>,

    /// CHECK: Permission account PDA for EmployeeEntry
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,

    /// CHECK: Permission Program (ACL)
    #[account(address = Pubkey::try_from(MAGICBLOCK_PERMISSION_PROGRAM).unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    /// CHECK: Authority for permission delegation.
    #[account(address = master_vault_v4.authority)]
    pub authority: UncheckedAccount<'info>,

    /// CHECK: Employee wallet for permission membership.
    pub employee_wallet: AccountInfo<'info>,

    /// CHECK: Validator identity for delegation.
    pub validator: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitAndUndelegateStreamV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump,
        constraint = stream_config_v4.business == business_v4.key()
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    /// CHECK: Employee entry PDA. Must match `(business, employee_index)` in instruction.
    #[account(mut)]
    pub employee_v4: AccountInfo<'info>,

    /// CHECK: Permission account PDA for EmployeeEntry
    #[account(mut)]
    pub permission: AccountInfo<'info>,

    /// CHECK: Permission Program (ACL)
    #[account(address = Pubkey::try_from(MAGICBLOCK_PERMISSION_PROGRAM).unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    /// CHECK: Authority for permission delegation.
    #[account(address = master_vault_v4.authority)]
    pub authority: UncheckedAccount<'info>,

    /// CHECK: MagicBlock scheduling program.
    #[account(address = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    /// CHECK: Global MagicBlock context account.
    #[account(mut, address = ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)]
    pub magic_context: AccountInfo<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct RedelegateStreamV4<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V4_SEED],
        bump = master_vault_v4.bump
    )]
    pub master_vault_v4: Account<'info, MasterVaultV4>,

    #[account(
        seeds = [
            BUSINESS_V4_SEED,
            master_vault_v4.key().as_ref(),
            &business_v4.business_index.to_le_bytes()
        ],
        bump = business_v4.bump
    )]
    pub business_v4: Account<'info, BusinessEntryV4>,

    #[account(
        seeds = [STREAM_CONFIG_V4_SEED, business_v4.key().as_ref()],
        bump = stream_config_v4.bump,
        constraint = stream_config_v4.business == business_v4.key()
    )]
    pub stream_config_v4: Account<'info, BusinessStreamConfigV4>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V4_SEED, business_v4.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Employee entry PDA that will be delegated to MagicBlock.
    pub employee_v4: UncheckedAccount<'info>,

    /// CHECK: Permission buffer PDA (permission program owner).
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATE_BUFFER_TAG, permission.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission_buffer: AccountInfo<'info>,

    /// CHECK: Permission delegation record PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_RECORD_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub permission_delegation_record: AccountInfo<'info>,

    /// CHECK: Permission delegation metadata PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_METADATA_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub permission_delegation_metadata: AccountInfo<'info>,

    /// CHECK: Permission account PDA for EmployeeEntry
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,

    /// CHECK: Permission Program (ACL)
    #[account(address = Pubkey::try_from(MAGICBLOCK_PERMISSION_PROGRAM).unwrap())]
    pub permission_program: UncheckedAccount<'info>,

    /// CHECK: Authority for permission delegation.
    #[account(address = master_vault_v4.authority)]
    pub authority: UncheckedAccount<'info>,

    /// CHECK: Validator identity for delegation.
    pub validator: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================
// Crank Scheduling Context
// ============================================================

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleCrankArgs {
    pub task_id: u64,
    pub execution_interval_millis: u64,
    pub iterations: u64,
    pub employee_index: u64,
}

#[derive(Accounts)]
pub struct ScheduleCrankV4<'info> {
    /// CHECK: used for CPI
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: AccountInfo<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: AccountInfo to avoid Anchor re-serializing stale data after CPI
    #[account(mut)]
    pub employee_stream: AccountInfo<'info>,
}
