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

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

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
// V3 Privacy-First Setup Contexts (Index-Based)
// ============================================================

#[derive(Accounts)]
pub struct InitMasterVaultV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MasterVaultV3::LEN,
        seeds = [MASTER_VAULT_V3_SEED],
        bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterBusinessV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        init,
        payer = authority,
        space = BusinessEntryV3::LEN,
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &master_vault_v3.next_business_index.to_le_bytes()
        ],
        bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVaultV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        mut,
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        init,
        payer = authority,
        space = BusinessVault::LEN,
        seeds = [VAULT_SEED, business_v3.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, BusinessVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddEmployeeV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        mut,
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        init,
        payer = authority,
        space = EmployeeEntryV3::LEN,
        seeds = [
            EMPLOYEE_V3_SEED,
            business_v3.key().as_ref(),
            &business_v3.next_employee_index.to_le_bytes()
        ],
        bump
    )]
    pub employee_v3: Account<'info, EmployeeEntryV3>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitStreamConfigV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        init,
        payer = authority,
        space = BusinessStreamConfigV3::LEN,
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateKeeperV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        mut,
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct AccrueV3<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    /// CHECK: Employee entry PDA for `(business, employee_index)`. Can be delegated.
    pub employee_v3: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
}

// ============================================================
// V3 Delegation Contexts
// ============================================================

#[delegate]
#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct DelegateStreamV3<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V3_SEED, business_v3.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Employee entry PDA that will be delegated to MagicBlock.
    pub employee_v3: UncheckedAccount<'info>,

    /// CHECK: Optional validator
    pub validator: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitAndUndelegateStreamV3<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    /// CHECK: Employee entry PDA. Must match `(business, employee_index)` in instruction.
    #[account(mut)]
    pub employee_v3: AccountInfo<'info>,

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
pub struct RedelegateStreamV3<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    #[account(
        mut,
        del,
        seeds = [EMPLOYEE_V3_SEED, business_v3.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    /// CHECK: Employee entry PDA that will be delegated to MagicBlock.
    pub employee_v3: UncheckedAccount<'info>,

    /// CHECK: Optional validator
    pub validator: Option<AccountInfo<'info>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business_v3.key().as_ref()],
        bump = vault.bump,
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

// ============================================================
// V3 Withdraw + Payout Contexts
// ============================================================

#[derive(Accounts)]
#[instruction(employee_index: u64)]
pub struct RequestWithdrawV3<'info> {
    #[account(mut)]
    pub employee_signer: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    /// CHECK: Employee entry PDA for `(business, employee_index)`. Can be delegated.
    pub employee_v3: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = employee_signer,
        space = WithdrawRequestV3::LEN,
        seeds = [WITHDRAW_REQUEST_V3_SEED, business_v3.key().as_ref(), &employee_index.to_le_bytes()],
        bump
    )]
    pub withdraw_request_v3: Account<'info, WithdrawRequestV3>,

    /// CHECK: Inco Lightning allowance PDA for employee id handle (owned by Inco Lightning).
    #[account(mut)]
    pub employee_id_allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct ProcessWithdrawRequestV3<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        seeds = [STREAM_CONFIG_V3_SEED, business_v3.key().as_ref()],
        bump = stream_config_v3.bump,
        constraint = stream_config_v3.business == business_v3.key()
    )]
    pub stream_config_v3: Account<'info, BusinessStreamConfigV3>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business_v3.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Employee entry PDA for `(business, employee_index)`. Must be undelegated.
    #[account(mut)]
    pub employee_v3: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [WITHDRAW_REQUEST_V3_SEED, business_v3.key().as_ref(), &employee_index.to_le_bytes()],
        bump = withdraw_request_v3.bump
    )]
    pub withdraw_request_v3: Account<'info, WithdrawRequestV3>,

    #[account(
        init,
        payer = caller,
        space = ShieldedPayoutV3::LEN,
        seeds = [
            SHIELDED_PAYOUT_V3_SEED,
            business_v3.key().as_ref(),
            &employee_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump
    )]
    pub shielded_payout_v3: Account<'info, ShieldedPayoutV3>,

    /// CHECK: Vault's Inco Token account
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Payout token account (buffer)
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    #[account(address = INCO_TOKEN_PROGRAM_ID)]
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct ClaimPayoutV3<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        mut,
        seeds = [
            SHIELDED_PAYOUT_V3_SEED,
            business_v3.key().as_ref(),
            &employee_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump = shielded_payout_v3.bump,
        constraint = shielded_payout_v3.business == business_v3.key()
    )]
    pub shielded_payout_v3: Account<'info, ShieldedPayoutV3>,

    /// CHECK: Shielded payout PDA's Inco token account (source — holds the buffered funds).
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Worker's destination Inco token account.
    #[account(mut)]
    pub claimer_token_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning allowance PDA for employee id handle.
    pub employee_id_allowance_account: AccountInfo<'info>,

    /// CHECK: Inco Token Program
    pub inco_token_program: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(employee_index: u64, nonce: u64)]
pub struct CancelExpiredPayoutV3<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [MASTER_VAULT_V3_SEED],
        bump = master_vault_v3.bump
    )]
    pub master_vault_v3: Account<'info, MasterVaultV3>,

    #[account(
        seeds = [
            BUSINESS_V3_SEED,
            master_vault_v3.key().as_ref(),
            &business_v3.business_index.to_le_bytes()
        ],
        bump = business_v3.bump
    )]
    pub business_v3: Account<'info, BusinessEntryV3>,

    #[account(
        mut,
        seeds = [
            SHIELDED_PAYOUT_V3_SEED,
            business_v3.key().as_ref(),
            &employee_index.to_le_bytes(),
            &nonce.to_le_bytes()
        ],
        bump = shielded_payout_v3.bump,
        constraint = shielded_payout_v3.business == business_v3.key()
    )]
    pub shielded_payout_v3: Account<'info, ShieldedPayoutV3>,

    #[account(
        mut,
        seeds = [VAULT_SEED, business_v3.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, BusinessVault>,

    /// CHECK: Vault's Inco Token account
    #[account(mut, address = vault.token_account)]
    pub vault_token_account: AccountInfo<'info>,

    /// CHECK: Payout token account (buffer)
    #[account(mut)]
    pub payout_token_account: AccountInfo<'info>,

    /// CHECK: Inco Lightning Program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
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

    /// CHECK: Inco Lightning allowance PDA for employee id handle (owned by Inco Lightning).
    #[account(mut)]
    pub employee_id_allowance_account: AccountInfo<'info>,

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

    /// CHECK: Inco Lightning allowance PDA for employee id handle (owned by Inco Lightning).
    pub employee_id_allowance_account: AccountInfo<'info>,

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

    /// CHECK: Inco Lightning allowance PDA for employee id handle (owned by Inco Lightning).
    pub employee_id_allowance_account: AccountInfo<'info>,

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

    /// CHECK: Inco Lightning allowance PDA for employee id handle.
    #[account(mut)]
    pub employee_id_allowance_account: AccountInfo<'info>,

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
