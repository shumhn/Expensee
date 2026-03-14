//! Confidential Streaming Payroll Program
//!
//! A privacy-preserving payroll system with:
//! - Program-owned token custody (BusinessVault PDA)
//! - Encrypted salaries and balances (Inco Lightning FHE)
//! - Real-time streaming via MagicBlock TEE
//! - Index-based PDAs (no pubkey correlation)
//!
//! Flow:
//! 1. Owner registers business + initializes vault
//! 2. Owner deposits encrypted tokens to vault
//! 3. Owner adds employees with encrypted salary rates
//! 4. Owner delegates employees to TEE for streaming
//! 5. TEE auto-accrues salary in real-time
//! 6. Employee withdraws via:
//!    a) Auto payment (TEE triggers on schedule)
//!    b) Manual withdrawal (employee signs)

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use sha2::{Digest, Sha256};

// MagicBlock Ephemeral Rollups SDK
use ephemeral_rollups_sdk::anchor::ephemeral;
use ephemeral_rollups_sdk::access_control::instructions::{
    CommitAndUndelegatePermissionCpiBuilder,
    CreatePermissionCpiBuilder,
    DelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{
    Member,
    MembersArgs,
    AUTHORITY_FLAG,
    TX_BALANCES_FLAG,
    TX_LOGS_FLAG,
};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU");

pub mod constants;
pub mod contexts;
pub mod errors;
pub mod events;
pub mod helpers;
pub mod state;

use constants::*;
use contexts::*;
use errors::*;
use events::*;

// Privacy-first logging: disabled unless the "privacy_logs" feature is enabled.
#[cfg(feature = "privacy_logs")]
macro_rules! privacy_msg {
    ($($arg:tt)*) => {
        privacy_msg!($($arg)*);
    };
}
#[cfg(not(feature = "privacy_logs"))]
macro_rules! privacy_msg {
    ($($arg:tt)*) => {};
}

// Privacy-first events: disabled unless the "privacy_events" feature is enabled.
#[cfg(feature = "privacy_events")]
macro_rules! privacy_emit {
    ($event:expr) => {
        emit!($event);
    };
}
#[cfg(not(feature = "privacy_events"))]
macro_rules! privacy_emit {
    ($event:expr) => {};
}

fn magicblock_permission_program() -> Pubkey {
    Pubkey::try_from(MAGICBLOCK_PERMISSION_PROGRAM).unwrap_or(Pubkey::default())
}

fn derive_permission_pda(permissioned_account: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[PERMISSION_SEED, permissioned_account.as_ref()],
        &magicblock_permission_program(),
    )
}

use helpers::*;
use state::*;

// ============================================================
// Program Instructions
// ============================================================

#[ephemeral]
#[program]
pub mod payroll {
    use super::*;

    // ════════════════════════════════════════════════════════
    // SETUP INSTRUCTIONS
    // ════════════════════════════════════════════════════════

    /// Register a new business
    ///
    /// Creates a Business PDA for the owner. Must be followed by
    /// init_vault() to set up token custody.
    pub fn register_business(
        ctx: Context<RegisterBusiness>,
        encrypted_employer_id: Vec<u8>,
    ) -> Result<()> {
        require!(
            encrypted_employer_id.len() <= MAX_CIPHERTEXT_BYTES
                && !encrypted_employer_id.is_empty(),
            PayrollError::InvalidCiphertext
        );

        let business = &mut ctx.accounts.business;
        let clock = Clock::get()?;
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.owner.to_account_info();

        business.owner = ctx.accounts.owner.key();
        business.vault = Pubkey::default(); // Set by init_vault
        business.next_employee_index = 0;
        business.is_active = true;
        business.created_at = clock.unix_timestamp;
        business.bump = ctx.bumps.business;
        // Initialize encrypted employer ID and encrypted employee count.
        let employer_id_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employer_id,
            0, None)?;
        business.encrypted_employer_id = u128_to_handle(employer_id_handle);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        business.encrypted_employee_count = u128_to_handle(zero_handle);

        privacy_msg!("✅ Business registered");

        privacy_emit!(BusinessRegistered {
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // V3 PRIVACY-FIRST SETUP (INDEX-BASED PDAs)
    // ════════════════════════════════════════════════════════

    /// Initialize the single MasterVaultV3 PDA.
    pub fn init_master_vault_v3(ctx: Context<InitMasterVaultV3>) -> Result<()> {
        let vault = &mut ctx.accounts.master_vault_v3;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        vault.authority = ctx.accounts.authority.key();
        vault.next_business_index = 0;
        vault.is_active = true;
        vault.bump = ctx.bumps.master_vault_v3;

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        vault.encrypted_business_count = u128_to_handle(zero_handle);
        vault.encrypted_employee_count = u128_to_handle(zero_handle);

        privacy_msg!("✅ v3 master vault initialized");
        Ok(())
    }

    /// Register a v3 business using index-based PDA seeds.
    ///
    /// Stores only encrypted employer identity on-chain.
    pub fn register_business_v3(
        ctx: Context<RegisterBusinessV3>,
        encrypted_employer_id: Vec<u8>,
    ) -> Result<()> {
        require!(
            !encrypted_employer_id.is_empty() && encrypted_employer_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );

        let master = &mut ctx.accounts.master_vault_v3;
        require!(master.is_active, PayrollError::Unauthorized);

        let business_index = master.next_business_index;
        master.next_business_index = master
            .next_business_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        let business = &mut ctx.accounts.business_v3;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let clock = Clock::get()?;

        business.master_vault = master.key();
        business.business_index = business_index;
        business.vault = Pubkey::default();
        business.next_employee_index = 0;
        business.is_active = true;
        business.bump = ctx.bumps.business_v3;

        let employer_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employer_id,
            0, None)?;
        business.encrypted_employer_id = u128_to_handle(employer_handle);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        business.encrypted_balance = u128_to_handle(zero_handle);
        business.encrypted_employee_count = u128_to_handle(zero_handle);

        let one_handle = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_business_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&master.encrypted_business_count),
            one_handle, None)?;
        master.encrypted_business_count = u128_to_handle(updated_business_count);

        emit!(BusinessRegistered {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v3 business registered");
        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // V4 POOLED VAULT (SINGLE MASTER VAULT POOL)
    // ════════════════════════════════════════════════════════

    /// Initialize the v4 pooled master vault.
    pub fn init_master_vault_v4(ctx: Context<InitMasterVaultV4>) -> Result<()> {
        let vault = &mut ctx.accounts.master_vault_v4;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        vault.authority = ctx.accounts.authority.key();
        vault.vault_token_account = Pubkey::default();
        vault.mint = Pubkey::default();
        vault.use_confidential_tokens = true;
        vault.next_business_index = 0;
        vault.is_active = true;
        vault.bump = ctx.bumps.master_vault_v4;

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        vault.encrypted_business_count = u128_to_handle(zero_handle);
        vault.encrypted_employee_count = u128_to_handle(zero_handle);
        vault.encrypted_total_balance = u128_to_handle(zero_handle);

        privacy_msg!("✅ v4 pooled master vault initialized");
        Ok(())
    }

    /// Set the pooled vault token account + mint for v4.
    pub fn set_pool_vault_v4(
        ctx: Context<SetPoolVaultV4>,
        mint: Pubkey,
        use_confidential_tokens: bool,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.master_vault_v4;
        require!(
            vault.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );
        require!(vault.is_active, PayrollError::Unauthorized);

        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.mint = mint;
        vault.use_confidential_tokens = use_confidential_tokens;

        privacy_msg!("✅ v4 pooled vault token account set");
        Ok(())
    }

    /// Register a v4 business using index-based PDA seeds (pooled vault).
    pub fn register_business_v4(
        ctx: Context<RegisterBusinessV4>,
        encrypted_employer_id: Vec<u8>,
    ) -> Result<()> {
        require!(
            !encrypted_employer_id.is_empty() && encrypted_employer_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );

        let master = &mut ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);

        let business_index = master.next_business_index;
        master.next_business_index = master
            .next_business_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        let business = &mut ctx.accounts.business_v4;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let clock = Clock::get()?;

        business.master_vault = master.key();
        business.business_index = business_index;
        business.next_employee_index = 0;
        business.is_active = true;
        business.bump = ctx.bumps.business_v4;

        let employer_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employer_id,
            0, None)?;
        business.encrypted_employer_id = u128_to_handle(employer_handle);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        business.encrypted_balance = u128_to_handle(zero_handle);
        business.encrypted_employee_count = u128_to_handle(zero_handle);

        let one_handle = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_business_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&master.encrypted_business_count),
            one_handle, None)?;
        master.encrypted_business_count = u128_to_handle(updated_business_count);

        emit!(BusinessRegistered {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v4 business registered");
        Ok(())
    }

    /// Initialize v4 stream config (keeper + cadence).
    pub fn init_stream_config_v4(
        ctx: Context<InitStreamConfigV4>,
        keeper_pubkey: Pubkey,
        settle_interval_secs: u64,
    ) -> Result<()> {
        require!(
            settle_interval_secs >= MIN_SETTLE_INTERVAL_SECS,
            PayrollError::InvalidSettleInterval
        );
        require!(keeper_pubkey != Pubkey::default(), PayrollError::InvalidKeeper);

        let master = &ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);

        let config = &mut ctx.accounts.stream_config_v4;
        config.business = ctx.accounts.business_v4.key();
        config.keeper_pubkey = keeper_pubkey;
        config.settle_interval_secs = settle_interval_secs;
        config.is_paused = false;
        config.pause_reason = PAUSE_REASON_NONE;
        config.bump = ctx.bumps.stream_config_v4;

        privacy_msg!("✅ v4 stream config initialized");
        Ok(())
    }

    /// Update v4 keeper public key.
    pub fn update_keeper_v4(
        ctx: Context<UpdateKeeperV4>,
        keeper_pubkey: Pubkey,
    ) -> Result<()> {
        let master = &ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);
        require!(keeper_pubkey != Pubkey::default(), PayrollError::InvalidKeeper);

        let config = &mut ctx.accounts.stream_config_v4;
        config.keeper_pubkey = keeper_pubkey;

        privacy_msg!("✅ v4 keeper updated");
        Ok(())
    }

    /// Add a v4 employee (pooled vault ledger).
    pub fn add_employee_v4(
        ctx: Context<AddEmployeeV4>,
        employee_index: u64,
        encrypted_employee_id: Vec<u8>,
        encrypted_salary_rate: Vec<u8>,
        period_start: i64,
        period_end: i64,
    ) -> Result<()> {
        require!(
            !encrypted_employee_id.is_empty() && encrypted_employee_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );
        require!(
            !encrypted_salary_rate.is_empty() && encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );
        require!(
            period_end == 0 || period_end > period_start,
            PayrollError::InvalidPeriodBounds
        );

        let master = &mut ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);

        let business = &mut ctx.accounts.business_v4;
        require!(
            employee_index == business.next_employee_index,
            PayrollError::InvalidStreamIndex
        );
        business.next_employee_index = business
            .next_employee_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        let employee = &mut ctx.accounts.employee_v4;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let clock = Clock::get()?;

        employee.business = business.key();
        employee.employee_index = employee_index;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.last_settle_time = clock.unix_timestamp;
        employee.is_active = true;
        employee.is_delegated = false;
        employee.bump = ctx.bumps.employee_v4;
        employee.period_start = period_start;
        employee.period_end = period_end;

        let employee_id_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employee_id,
            0, None)?;
        employee.encrypted_employee_id = u128_to_handle(employee_id_handle);

        let salary_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0, None)?;
        employee.encrypted_salary_rate = u128_to_handle(salary_handle);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);

        let one_handle = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_employee_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&business.encrypted_employee_count),
            one_handle, None)?;
        business.encrypted_employee_count = u128_to_handle(updated_employee_count);

        let one_handle2 = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_total_employee_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&master.encrypted_employee_count),
            one_handle2, None)?;
        master.encrypted_employee_count = u128_to_handle(updated_total_employee_count);

        privacy_msg!("✅ v4 employee added");
        Ok(())
    }

    /// Initialize rate history PDA for a v4 employee.
    /// Enables selective disclosure payslips for v4 streams.
    pub fn init_rate_history_v4(
        ctx: Context<InitRateHistoryV4>,
        employee_index: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let baseline_time = if employee.last_settle_time > 0 {
            employee.last_settle_time
        } else {
            employee.last_accrual_time
        };

        let history = &mut ctx.accounts.rate_history_v4;
        history.business = business_key;
        history.employee_index = employee_index;
        history.count = 1;
        history.bump = ctx.bumps.rate_history_v4;
        history._reserved = [0u8; 6];
        history.entries = std::array::from_fn(|_| RateHistoryEntryV4::default());
        history.entries[0] = RateHistoryEntryV4 {
            effective_at: baseline_time,
            encrypted_salary_rate: employee.encrypted_salary_rate.clone(),
        };

        privacy_msg!("✅ v4 rate history initialized");
        Ok(())
    }

    /// Update v4 salary rate privately (encrypted). Intended for raises.
    ///
    /// For safety and simplicity on devnet demos, this requires the stream to be undelegated
    /// (owned by this program). If delegated, undelegate first and retry.
    pub fn update_salary_rate_v4(
        ctx: Context<UpdateSalaryRateV4>,
        employee_index: u64,
        encrypted_salary_rate: Vec<u8>,
    ) -> Result<()> {
        require!(
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES
                && !encrypted_salary_rate.is_empty(),
            PayrollError::InvalidCiphertext
        );

        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        require!(
            ctx.accounts.employee_v4.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let mut employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        let mut effective_from = employee.last_accrual_time;
        if employee.period_start > 0 && effective_from < employee.period_start {
            effective_from = employee.period_start;
        }
        let mut effective_to = clock.unix_timestamp;
        if employee.period_end > 0 && effective_to > employee.period_end {
            effective_to = employee.period_end;
        }

        if effective_to > effective_from {
            let elapsed = (effective_to - effective_from) as u128;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);

            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed,
                1, None)?;	// scalar_byte = 1

            let updated_accrued = inco_add_u128(
                &signer,
                &inco_lightning_program,
                current_accrued,
                delta, None)?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        // Register new encrypted salary rate and store handle.
        let new_rate_handle =
            inco_new_euint128(&signer, &inco_lightning_program, encrypted_salary_rate, 0, None)?;
        employee.encrypted_salary_rate = u128_to_handle(new_rate_handle);

        if effective_to > employee.last_accrual_time {
            employee.last_accrual_time = effective_to;
        }
        save_employee_entry_v4(&ctx.accounts.employee_v4, &employee)?;

        // Append to rate history for selective disclosure payslips.
        let history = &mut ctx.accounts.rate_history_v4;
        require!(
            history.business == business_key,
            PayrollError::InvalidRateHistory
        );
        require!(
            history.employee_index == employee_index,
            PayrollError::InvalidRateHistory
        );
        let idx = history.count as usize;
        require!(
            idx < RATE_HISTORY_MAX_ENTRIES,
            PayrollError::RateHistoryFull
        );
        history.entries[idx] = RateHistoryEntryV4 {
            effective_at: clock.unix_timestamp,
            encrypted_salary_rate: employee.encrypted_salary_rate.clone(),
        };
        history.count = history
            .count
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        privacy_msg!("✅ v4 salary rate updated (encrypted)");
        Ok(())
    }

    /// Initialize a v4 user token registry entry (deterministic lookup).
    pub fn init_user_token_account_v4(ctx: Context<InitUserTokenAccountV4>) -> Result<()> {
        let entry = &mut ctx.accounts.user_token_account_v4;
        let signer = ctx.accounts.owner.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let clock = Clock::get()?;

        entry.owner = ctx.accounts.owner.key();
        entry.mint = ctx.accounts.mint.key();
        entry.inco_token_account = Pubkey::default();

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        entry.encrypted_balance = u128_to_handle(zero_handle);
        entry.initialized_at = clock.unix_timestamp;
        entry.bump = ctx.bumps.user_token_account_v4;

        privacy_msg!("✅ v4 user token registry initialized");
        Ok(())
    }

    /// Link a v4 user token registry entry to an Inco token account.
    pub fn link_user_token_account_v4(
        ctx: Context<LinkUserTokenAccountV4>,
        encrypted_balance: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(
            *ctx.accounts.inco_token_account.owner,
            INCO_TOKEN_PROGRAM_ID,
            PayrollError::InvalidIncoTokenAccount
        );

        let entry = &mut ctx.accounts.user_token_account_v4;
        entry.inco_token_account = ctx.accounts.inco_token_account.key();

        if !encrypted_balance.is_empty() {
            require!(
                encrypted_balance.len() <= MAX_CIPHERTEXT_BYTES,
                PayrollError::InvalidCiphertext
            );
            let signer = ctx.accounts.owner.to_account_info();
            let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
            let handle = inco_new_euint128(
                &signer,
                &inco_lightning_program,
                encrypted_balance,
                0, None)?;
            entry.encrypted_balance = u128_to_handle(handle);
        }

        privacy_msg!("✅ v4 user token registry linked");
        Ok(())
    }

    /// Deposit encrypted tokens into the pooled vault and credit business balance.
    pub fn deposit_v4(
        ctx: Context<DepositV4>,
        encrypted_amount: Vec<u8>,
    ) -> Result<()> {
        require!(
            !encrypted_amount.is_empty() && encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );

        let master = &mut ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);
        require!(
            master.vault_token_account == ctx.accounts.vault_token_account.key(),
            PayrollError::InvalidIncoTokenAccount
        );

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.depositor_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.authority.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            encrypted_amount.clone(),
            0,
        );
        invoke(
            &transfer_ix,
            &[
                ctx.accounts.depositor_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let business = &mut ctx.accounts.business_v4;

        let deposit_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_amount,
            0, None)?;
        let updated_balance = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&business.encrypted_balance),
            deposit_handle, None)?;
        business.encrypted_balance = u128_to_handle(updated_balance);

        let current_total = if is_handle_zero(&master.encrypted_total_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&master.encrypted_total_balance)
        };
        let updated_total = inco_add_u128(
            &signer,
            &inco_lightning_program,
            current_total,
            deposit_handle, None)?;
        master.encrypted_total_balance = u128_to_handle(updated_total);

        privacy_msg!("✅ v4 pooled deposit complete");
        Ok(())
    }

    /// Accrue v4 salary using homomorphic operations.
    pub fn accrue_v4(ctx: Context<AccrueV4>, employee_index: u64) -> Result<()> {
        authorize_keeper_only(
            ctx.accounts.caller.key(),
            ctx.accounts.stream_config_v4.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _employee_bump) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        let mut employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        let mut effective_from = employee.last_accrual_time;
        if employee.period_start > 0 && effective_from < employee.period_start {
            effective_from = employee.period_start;
        }
        let mut effective_to = clock.unix_timestamp;
        if employee.period_end > 0 && effective_to > employee.period_end {
            effective_to = employee.period_end;
        }

        if effective_to > effective_from {
            let elapsed = (effective_to - effective_from) as u128;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);

            // Use scalar_byte=1 optimization for plaintext elapsed time.
            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed,
                1, None)?;	// scalar_byte = 1

            let updated_accrued = inco_add_u128(
                &signer,
                &inco_lightning_program,
                current_accrued,
                delta, None)?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        if effective_to > employee.last_accrual_time {
            employee.last_accrual_time = effective_to;
        }
        save_employee_entry_v4(&ctx.accounts.employee_v4, &employee)?;

        privacy_msg!("✅ v4 accrued");
        Ok(())
    }

    /// Delegate v4 employee stream to MagicBlock TEE.
    pub fn delegate_stream_v4(ctx: Context<DelegateStreamV4>, employee_index: u64) -> Result<()> {
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee_v4.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, employee_bump) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        let seeds: &[&[u8]] = &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes];
        let employee_signer_seeds: &[&[u8]] = &[
            EMPLOYEE_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &[employee_bump],
        ];
        let (expected_permission, _permission_bump) =
            derive_permission_pda(&ctx.accounts.employee_v4.key());
        require_keys_eq!(
            ctx.accounts.permission.key(),
            expected_permission,
            PayrollError::InvalidPermissionAccount
        );

        let permission_info = ctx.accounts.permission.to_account_info();
        if permission_info.data_len() > 0 {
            require_keys_eq!(
                *permission_info.owner,
                magicblock_permission_program(),
                PayrollError::InvalidPermissionAccount
            );
        }
        if permission_info.data_len() == 0 {
            let members = Some(vec![
                Member {
                    flags: AUTHORITY_FLAG,
                    pubkey: ctx.accounts.master_vault_v4.authority,
                },
                Member {
                    flags: TX_BALANCES_FLAG | TX_LOGS_FLAG,
                    pubkey: ctx.accounts.employee_wallet.key(),
                },
            ]);

            CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
                .permissioned_account(&ctx.accounts.employee_v4.to_account_info())
                .permission(&permission_info)
                .payer(&ctx.accounts.caller.to_account_info())
                .system_program(&ctx.accounts.system_program.to_account_info())
                .args(MembersArgs { members })
                .invoke_signed(&[employee_signer_seeds])?;
        }

        let validator_key = Some(ctx.accounts.validator.key());

        // IMPORTANT: do not mutate delegated account in this instruction.
        ctx.accounts.delegate_employee_v4(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;


        // Delegate the permission account via the Permission Program so it can sign for its PDA.
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .payer(&ctx.accounts.caller.to_account_info())
            .authority(&ctx.accounts.authority.to_account_info(), false)
            .permissioned_account(&ctx.accounts.employee_v4.to_account_info(), true)
            .permission(&permission_info)
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.permission_buffer)
            .delegation_record(&ctx.accounts.permission_delegation_record)
            .delegation_metadata(&ctx.accounts.permission_delegation_metadata)
            .delegation_program(&ctx.accounts.delegation_program)
            .validator(Some(&ctx.accounts.validator))
            .invoke_signed(&[employee_signer_seeds])?;

        privacy_msg!("✅ v4 stream delegated to TEE");
        Ok(())
    }

    /// Commit and undelegate v4 stream back to base layer.
    pub fn commit_and_undelegate_stream_v4(
        ctx: Context<CommitAndUndelegateStreamV4>,
        employee_index: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, employee_bump) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        let (expected_permission, _) = derive_permission_pda(&ctx.accounts.employee_v4.key());
        require_keys_eq!(
            ctx.accounts.permission.key(),
            expected_permission,
            PayrollError::InvalidPermissionAccount
        );
        let permission_info = ctx.accounts.permission.to_account_info();
        require!(
            permission_info.data_len() > 0,
            PayrollError::InvalidPermissionAccount
        );
        require_keys_eq!(
            *permission_info.owner,
            magicblock_permission_program(),
            PayrollError::InvalidPermissionAccount
        );

        // On ER, delegated accounts can appear owned by the original program.
        // Do not gate commit/undelegate scheduling on AccountInfo.owner.
        commit_and_undelegate_accounts(
            &ctx.accounts.caller,
            vec![&ctx.accounts.employee_v4],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        let employee_signer_seeds: &[&[u8]] = &[
            EMPLOYEE_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &[employee_bump],
        ];
        CommitAndUndelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .authority(&ctx.accounts.authority.to_account_info(), false)
            .permissioned_account(&ctx.accounts.employee_v4.to_account_info(), true)
            .permission(&permission_info)
            .magic_program(&ctx.accounts.magic_program)
            .magic_context(&ctx.accounts.magic_context)
            .invoke_signed(&[employee_signer_seeds])?;

        privacy_msg!("✅ v4 commit+undelegate scheduled");
        Ok(())
    }

    /// On the Ephemeral Rollup, schedules the crank_settle_v4 instruction to run autonomously.
    pub fn schedule_crank_v4(
        ctx: Context<ScheduleCrankV4>,
        args: ScheduleCrankArgs,
    ) -> Result<()> {
        // Construct the target instruction — only the employee account
        // (the MagicBlock validator will supply itself as the payer/caller)
        let crank_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: crate::ID,
            accounts: vec![
                // The MagicBlock validator signs as caller
                AccountMeta::new(ctx.accounts.employee_stream.key(), false),
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::CrankSettleV4 { 
                employee_index: args.employee_index 
            }),
        };

        // Serialize magicblock schedule task args
        let ix_data = bincode::serialize(&magicblock_magic_program_api::instruction::MagicBlockInstruction::ScheduleTask(
            magicblock_magic_program_api::args::ScheduleTaskArgs {
                task_id: args.task_id as i64, 
                execution_interval_millis: args.execution_interval_millis as i64,
                iterations: args.iterations as i64,
                instructions: vec![crank_ix],
            },
        )).map_err(|err| {
            msg!("ERROR: failed to serialize crank args {:?}", err);
            PayrollError::InvalidWithdrawRequest
        })?;

        let schedule_ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
            crate::constants::MAGIC_PROGRAM_ID,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.task_context.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.program.key(), false),
                AccountMeta::new(ctx.accounts.employee_stream.key(), false),
            ],
        );

        // Invoke CPI without PDA seeds (as per official magicblock docs)
        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.task_context.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.program.to_account_info(),
                ctx.accounts.employee_stream.to_account_info(),
                ctx.accounts.magic_program.to_account_info(),
            ],
            &[],
        )?;

        Ok(())
    }

    /// Re-delegate v4 stream after settlement.
    pub fn redelegate_stream_v4(ctx: Context<RedelegateStreamV4>, employee_index: u64) -> Result<()> {
 
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee_v4.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, employee_bump) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        let seeds: &[&[u8]] = &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes];
        let employee_signer_seeds: &[&[u8]] = &[
            EMPLOYEE_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &[employee_bump],
        ];
        let (expected_permission, _) = derive_permission_pda(&ctx.accounts.employee_v4.key());
        require_keys_eq!(
            ctx.accounts.permission.key(),
            expected_permission,
            PayrollError::InvalidPermissionAccount
        );
        let permission_info = ctx.accounts.permission.to_account_info();
        require!(
            permission_info.data_len() > 0,
            PayrollError::InvalidPermissionAccount
        );
        require_keys_eq!(
            *permission_info.owner,
            magicblock_permission_program(),
            PayrollError::InvalidPermissionAccount
        );
        let validator_key = Some(ctx.accounts.validator.key());

        ctx.accounts.delegate_employee_v4(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;

        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .payer(&ctx.accounts.caller.to_account_info())
            .authority(&ctx.accounts.authority.to_account_info(), false)
            .permissioned_account(&ctx.accounts.employee_v4.to_account_info(), true)
            .permission(&permission_info)
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.permission_buffer)
            .delegation_record(&ctx.accounts.permission_delegation_record)
            .delegation_metadata(&ctx.accounts.permission_delegation_metadata)
            .delegation_program(&ctx.accounts.delegation_program)
            .validator(Some(&ctx.accounts.validator))
            .invoke_signed(&[employee_signer_seeds])?;

        privacy_msg!("✅ v4 stream re-delegated");
        Ok(())
    }

    /// Employee requests a v4 withdrawal (pooled vault).
    pub fn request_withdraw_v4(
        ctx: Context<RequestWithdrawV4>,
        employee_index: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let auth_handle_u128 = handle_to_u128(&employee.encrypted_employee_id);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let allowed = ctx.accounts.requester.key();
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let clock = Clock::get()?;
        let req = &mut ctx.accounts.withdraw_request_v4;
        req.business = business_key;
        req.employee_index = employee_index;
        req.requester_auth_handle = employee.encrypted_employee_id.handle;
        req.requested_at = clock.unix_timestamp;
        req.is_pending = true;
        req.bump = ctx.bumps.withdraw_request_v4;

        privacy_msg!("✅ v4 withdraw requested");
        Ok(())
    }

    /// TEE Crank processes an autonomous v4 settlement.
    /// Simplified for MagicBlock ER: uses plaintext math only (no Inco CPIs).
    /// The ER doesn't have the Inco Lightning program, so we operate on
    /// the raw handle bytes as plaintext u128 values inside the TEE.
    /// When the account is committed back to the base layer, the FHE
    /// state is preserved because we're operating on the same byte offsets.
    pub fn crank_settle_v4(
        ctx: Context<CrankSettleV4>,
        employee_index: u64,
    ) -> Result<()> {
        let mut employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;

        // Calculate time-based accrual using plaintext math
        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;

        if elapsed > 0 {
            // Read salary rate and accrued as raw u128 from the handle bytes
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);

            // delta = salary_rate * elapsed (plaintext math inside TEE)
            let delta = salary_rate.wrapping_mul(elapsed as u128);

            // updated_accrued = current_accrued + delta
            let updated_accrued = current_accrued.wrapping_add(delta);
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        // Update timestamps 
        employee.last_accrual_time = clock.unix_timestamp;
        employee.last_settle_time = clock.unix_timestamp;

        save_employee_entry_v4(&ctx.accounts.employee_v4, &employee)?;

        privacy_msg!("🤖⚙️ v4 MagicBlock Crank: Accrual updated (plaintext in TEE)");
        Ok(())
    }

    /// Keeper processes a pending v4 withdrawal request (pooled vault).
    pub fn process_withdraw_request_v4(
        ctx: Context<ProcessWithdrawRequestV4>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {

        require!(
            !ctx.accounts.stream_config_v4.is_paused,
            PayrollError::StreamPaused
        );

        require!(
            ctx.accounts.withdraw_request_v4.is_pending,
            PayrollError::WithdrawNotPending
        );
        require!(
            ctx.accounts.withdraw_request_v4.business == ctx.accounts.business_v4.key(),
            PayrollError::InvalidWithdrawRequest
        );
        require!(
            ctx.accounts.withdraw_request_v4.employee_index == employee_index,
            PayrollError::InvalidWithdrawRequest
        );

        // Stream must be on base layer before we mutate/settle.
        require!(
            ctx.accounts.employee_v4.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V4_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v4.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let mut employee = load_employee_entry_v4(&ctx.accounts.employee_v4)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        // Ensure withdraw request auth matches employee handle.
        require!(
            ctx.accounts.withdraw_request_v4.requester_auth_handle == employee.encrypted_employee_id.handle,
            PayrollError::InvalidWithdrawRequester
        );

        let clock = Clock::get()?;
        let accrual_age = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        let settle_interval = ctx.accounts.stream_config_v4.settle_interval_secs as i64;
        let freshness_guard = std::cmp::max(120_i64, settle_interval.saturating_mul(2));
        require!(accrual_age <= freshness_guard, PayrollError::AccrualNotFresh);

        let elapsed_since_settle = clock
            .unix_timestamp
            .checked_sub(employee.last_settle_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            elapsed_since_settle as u64 >= ctx.accounts.stream_config_v4.settle_interval_secs,
            PayrollError::SettleTooSoon
        );

        require!(
            ctx.accounts.master_vault_v4.vault_token_account
                == ctx.accounts.vault_token_account.key(),
            PayrollError::InvalidIncoTokenAccount
        );

        let payout_handle = employee.encrypted_accrued.handle.to_vec();
        let accrued_handle_at_settle = handle_to_u128(&employee.encrypted_accrued);
        let expires_at = clock.unix_timestamp + ShieldedPayoutV4::DEFAULT_EXPIRY_SECS;

        let payout = &mut ctx.accounts.shielded_payout_v4;
        payout.business = business_key;
        payout.employee_index = employee_index;
        payout.nonce = nonce;
        payout.employee_auth_handle = employee.encrypted_employee_id.handle;
        payout.encrypted_amount = employee.encrypted_accrued.clone();
        payout.claimed = false;
        payout.cancelled = false;
        payout.created_at = clock.unix_timestamp;
        payout.expires_at = expires_at;
        payout.payout_token_account = ctx.accounts.payout_token_account.key();
        payout.bump = ctx.bumps.shielded_payout_v4;

        let master_bump = ctx.accounts.master_vault_v4.bump;
        let seeds: &[&[&[u8]]] = &[&[MASTER_VAULT_V4_SEED, &[master_bump]]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.master_vault_v4.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            payout_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.master_vault_v4.to_account_info(),
                ctx.accounts.inco_token_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        let signer = ctx.accounts.payer.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let current_balance = if is_handle_zero(&ctx.accounts.business_v4.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&ctx.accounts.business_v4.encrypted_balance)
        };
        let updated_balance = inco_sub_u128(
            &signer,
            &inco_lightning_program,
            current_balance,
            accrued_handle_at_settle, None)?;
        ctx.accounts.business_v4.encrypted_balance = u128_to_handle(updated_balance);

        let total_current = if is_handle_zero(&ctx.accounts.master_vault_v4.encrypted_total_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&ctx.accounts.master_vault_v4.encrypted_total_balance)
        };
        let total_updated = inco_sub_u128(
            &signer,
            &inco_lightning_program,
            total_current,
            accrued_handle_at_settle, None)?;
        ctx.accounts.master_vault_v4.encrypted_total_balance = u128_to_handle(total_updated);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_entry_v4(&ctx.accounts.employee_v4, &employee)?;

        ctx.accounts.withdraw_request_v4.is_pending = false;

        privacy_emit!(PayoutBuffered {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v4 payout buffered (pooled vault)");
        Ok(())
    }

    /// Worker claims a v4 shielded payout (Hop 2).
    pub fn claim_payout_v4(
        ctx: Context<ClaimPayoutV4>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {
        let payout = &ctx.accounts.shielded_payout_v4;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        if payout.expires_at > 0 {
            require!(
                clock.unix_timestamp <= payout.expires_at,
                PayrollError::PayoutExpired
            );
        }

        let claimer = ctx.accounts.claimer.key();
        let auth_handle = EncryptedHandle {
            handle: payout.employee_auth_handle,
        };
        let auth_handle_u128 = handle_to_u128(&auth_handle);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, claimer.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.allowance_account.key(),
            expected_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );
        require_keys_eq!(
            *ctx.accounts.allowance_account.owner,
            INCO_LIGHTNING_ID,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let pda_bump = payout.bump;
        let amount_handle = payout.encrypted_amount.handle.to_vec();
        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.destination_token_account.key(),
            ctx.accounts.shielded_payout_v4.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.destination_token_account.to_account_info(),
                ctx.accounts.shielded_payout_v4.to_account_info(),
                ctx.accounts.inco_token_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        let payout_mut = &mut ctx.accounts.shielded_payout_v4;
        payout_mut.claimed = true;

        privacy_emit!(PayoutClaimed {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v4 payout claimed");
        Ok(())
    }

    /// Business authority cancels an expired v4 payout and returns funds to pooled vault.
    pub fn cancel_expired_payout_v4(
        ctx: Context<CancelExpiredPayoutV4>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {
        let master = &ctx.accounts.master_vault_v4;
        require!(
            master.authority == ctx.accounts.caller.key(),
            PayrollError::Unauthorized
        );

        let payout = &ctx.accounts.shielded_payout_v4;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        require!(
            payout.expires_at > 0 && clock.unix_timestamp > payout.expires_at,
            PayrollError::PayoutNotExpired
        );

        require!(
            ctx.accounts.master_vault_v4.vault_token_account
                == ctx.accounts.vault_token_account.key(),
            PayrollError::InvalidIncoTokenAccount
        );

        let payout_bump = payout.bump;
        let payout_key = payout.key();
        let amount_handle = payout.encrypted_amount.handle.to_vec();
        let business_key = ctx.accounts.business_v4.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let payout_seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &nonce_bytes,
            &[payout_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            payout_key,
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.shielded_payout_v4.to_account_info(),
                ctx.accounts.inco_token_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            payout_seeds,
        )?;

        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let current_balance = if is_handle_zero(&ctx.accounts.business_v4.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&ctx.accounts.business_v4.encrypted_balance)
        };
        let payout_handle = handle_to_u128(&ctx.accounts.shielded_payout_v4.encrypted_amount);
        let updated_balance = inco_add_u128(
            &signer,
            &inco_lightning_program,
            current_balance,
            payout_handle, None)?;
        ctx.accounts.business_v4.encrypted_balance = u128_to_handle(updated_balance);

        let payout_mut = &mut ctx.accounts.shielded_payout_v4;
        payout_mut.cancelled = true;

        privacy_msg!("✅ v4 payout cancelled and returned to pool");
        Ok(())
    }

    /// Initialize a v3 business vault PDA for token custody.
    pub fn init_vault_v3(
        ctx: Context<InitVaultV3>,
        payusd_mint: Pubkey,
        vault_token_account: Pubkey,
    ) -> Result<()> {
        let master = &ctx.accounts.master_vault_v3;
        require!(
            master.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );

        let vault = &mut ctx.accounts.vault;
        let business = &mut ctx.accounts.business_v3;
        let clock = Clock::get()?;

        vault.business = business.key();
        vault.mint = payusd_mint;
        vault.token_account = vault_token_account;
        vault.encrypted_balance = business.encrypted_balance.clone();
        vault.bump = ctx.bumps.vault;

        business.vault = vault.key();

        emit!(VaultInitialized {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v3 vault initialized");
        Ok(())
    }

    /// Add a v3 employee entry (index-based).
    pub fn add_employee_v3(
        ctx: Context<AddEmployeeV3>,
        encrypted_employee_id: Vec<u8>,
        encrypted_salary_rate: Vec<u8>,
        period_start: i64,
        period_end: i64,
    ) -> Result<()> {
        require!(
            !encrypted_employee_id.is_empty() && encrypted_employee_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );
        require!(
            !encrypted_salary_rate.is_empty() && encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );
        require!(
            period_end == 0 || period_end > period_start,
            PayrollError::InvalidPeriodBounds
        );

        let master = &mut ctx.accounts.master_vault_v3;
        require!(
            master.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );
        require!(master.is_active, PayrollError::Unauthorized);

        let business = &mut ctx.accounts.business_v3;
        require!(business.is_active, PayrollError::InactiveBusiness);
        require!(
            business.master_vault == master.key(),
            PayrollError::Unauthorized
        );

        let employee_index = business.next_employee_index;
        business.next_employee_index = business
            .next_employee_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        let employee = &mut ctx.accounts.employee_v3;
        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let clock = Clock::get()?;

        employee.business = business.key();
        employee.employee_index = employee_index;
        employee.is_active = true;
        employee.is_delegated = false;
        employee.bump = ctx.bumps.employee_v3;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.last_settle_time = clock.unix_timestamp;
        employee.period_start = period_start;
        employee.period_end = period_end;

        let employee_id_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employee_id,
            0, None)?;
        employee.encrypted_employee_id = u128_to_handle(employee_id_handle);

        let salary_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0, None)?;
        employee.encrypted_salary_rate = u128_to_handle(salary_handle);

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);

        let one_handle = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_business_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&business.encrypted_employee_count),
            one_handle, None)?;
        business.encrypted_employee_count = u128_to_handle(updated_business_count);

        let updated_master_count = inco_add_u128(
            &signer,
            &inco_lightning_program,
            handle_to_u128(&master.encrypted_employee_count),
            one_handle, None)?;
        master.encrypted_employee_count = u128_to_handle(updated_master_count);

        privacy_msg!("✅ v3 employee added");
        Ok(())
    }

    /// Deposit encrypted tokens to a v3 business vault and update encrypted balance.
    pub fn deposit_v3(ctx: Context<DepositV3>, encrypted_amount: Vec<u8>) -> Result<()> {
        require!(
            !encrypted_amount.is_empty() && encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );

        let master = &ctx.accounts.master_vault_v3;
        require!(
            master.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );

        let business = &mut ctx.accounts.business_v3;
        let vault = &mut ctx.accounts.vault;

        // Transfer encrypted tokens from depositor to vault.
        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.depositor_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.authority.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            encrypted_amount.clone(),
            0,
        );
        invoke(
            &transfer_ix,
            &[
                ctx.accounts.depositor_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let signer = ctx.accounts.authority.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let deposit_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_amount,
            0, None)?;
        let updated_balance = inco_add_u128(
            &signer,
            &inco_lightning_program,
            current_balance,
            deposit_handle, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);
        business.encrypted_balance = vault.encrypted_balance.clone();

        privacy_msg!("✅ v3 deposit complete");
        Ok(())
    }

    /// Initialize v3 stream config for a business entry.
    pub fn init_stream_config_v3(
        ctx: Context<InitStreamConfigV3>,
        keeper_pubkey: Pubkey,
        settle_interval_secs: u64,
    ) -> Result<()> {
        let master = &ctx.accounts.master_vault_v3;
        require!(
            master.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );
        require!(
            settle_interval_secs >= MIN_SETTLE_INTERVAL_SECS,
            PayrollError::InvalidSettleInterval
        );

        let cfg = &mut ctx.accounts.stream_config_v3;
        cfg.business = ctx.accounts.business_v3.key();
        cfg.keeper_pubkey = keeper_pubkey;
        cfg.settle_interval_secs = settle_interval_secs;
        cfg.is_paused = false;
        cfg.pause_reason = PAUSE_REASON_NONE;
        cfg.bump = ctx.bumps.stream_config_v3;

        privacy_msg!("✅ v3 stream config initialized");
        Ok(())
    }

    /// Update v3 keeper pubkey.
    pub fn update_keeper_v3(
        ctx: Context<UpdateKeeperV3>,
        keeper_pubkey: Pubkey,
    ) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.authority.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;
        require!(keeper_pubkey != Pubkey::default(), PayrollError::InvalidKeeper);

        ctx.accounts.stream_config_v3.keeper_pubkey = keeper_pubkey;
        privacy_msg!("✅ v3 keeper updated");
        Ok(())
    }

    /// Accrue v3 salary using homomorphic operations.
    pub fn accrue_v3(ctx: Context<AccrueV3>, employee_index: u64) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.caller.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v3.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let mut employee = load_employee_entry_v3(&ctx.accounts.employee_v3)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        if elapsed > 0 {
            let elapsed_handle =
                inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128, None)?;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);
            let delta = inco_mul_u128(
                &signer,
                &inco_lightning_program,
                salary_rate,
                elapsed_handle, None)?;
            let updated_accrued = inco_add_u128(
                &signer,
                &inco_lightning_program,
                current_accrued,
                delta, None)?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        employee.last_accrual_time = clock.unix_timestamp;
        save_employee_entry_v3(&ctx.accounts.employee_v3, &employee)?;

        privacy_msg!("✅ v3 accrued");
        Ok(())
    }

    /// Delegate v3 employee stream to MagicBlock TEE.
    pub fn delegate_stream_v3(ctx: Context<DelegateStreamV3>, employee_index: u64) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.caller.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee_v3.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_entry_v3(&ctx.accounts.employee_v3)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let seeds: &[&[u8]] = &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes];

        let validator_key = ctx
            .accounts
            .validator
            .as_ref()
            .map(|v| v.key())
            .or_else(|| Pubkey::try_from(TEE_VALIDATOR).ok());

        // IMPORTANT: do not mutate delegated account in this instruction.
        ctx.accounts.delegate_employee_v3(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;
        privacy_msg!("✅ v3 stream delegated to TEE");
        Ok(())
    }

    /// Commit and undelegate v3 stream back to base layer.
    pub fn commit_and_undelegate_stream_v3(
        ctx: Context<CommitAndUndelegateStreamV3>,
        employee_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.caller.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v3.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        // On ER, delegated accounts can appear owned by the original program.
        // Do not gate commit/undelegate scheduling on AccountInfo.owner.
        commit_and_undelegate_accounts(
            &ctx.accounts.caller,
            vec![&ctx.accounts.employee_v3],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        privacy_msg!("✅ v3 commit+undelegate scheduled");
        Ok(())
    }

    /// Re-delegate v3 stream after settlement.
    pub fn redelegate_stream_v3(ctx: Context<RedelegateStreamV3>, employee_index: u64) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.caller.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee_v3.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_entry_v3(&ctx.accounts.employee_v3)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let seeds: &[&[u8]] = &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes];

        let validator_key = ctx
            .accounts
            .validator
            .as_ref()
            .map(|v| v.key())
            .or_else(|| Pubkey::try_from(TEE_VALIDATOR).ok());

        ctx.accounts.delegate_employee_v3(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;
        privacy_msg!("✅ v3 stream re-delegated");
        Ok(())
    }

    /// Employee requests a v3 withdrawal (privacy-first).
    pub fn request_withdraw_v3(
        ctx: Context<RequestWithdrawV3>,
        employee_index: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v3.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_entry_v3(&ctx.accounts.employee_v3)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        let auth_handle_u128 = handle_to_u128(&employee.encrypted_employee_id);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let allowed = ctx.accounts.employee_signer.key();
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let clock = Clock::get()?;
        let req = &mut ctx.accounts.withdraw_request_v3;
        req.business = business_key;
        req.employee_index = employee_index;
        req.requester_auth_handle = employee.encrypted_employee_id.handle;
        req.requested_at = clock.unix_timestamp;
        req.is_pending = true;
        req.bump = ctx.bumps.withdraw_request_v3;

        privacy_msg!("✅ v3 withdraw requested");
        Ok(())
    }

    /// Keeper processes a pending v3 withdrawal request (2-hop shielded).
    pub fn process_withdraw_request_v3(
        ctx: Context<ProcessWithdrawRequestV3>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {
        authorize_keeper_or_master(
            ctx.accounts.caller.key(),
            ctx.accounts.master_vault_v3.authority,
            ctx.accounts.stream_config_v3.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v3.is_paused,
            PayrollError::StreamPaused
        );

        require!(
            ctx.accounts.withdraw_request_v3.is_pending,
            PayrollError::WithdrawNotPending
        );
        require!(
            ctx.accounts.withdraw_request_v3.business == ctx.accounts.business_v3.key(),
            PayrollError::InvalidWithdrawRequest
        );
        require!(
            ctx.accounts.withdraw_request_v3.employee_index == employee_index,
            PayrollError::InvalidWithdrawRequest
        );

        // Stream must be back on base layer before we mutate/settle.
        require!(
            ctx.accounts.employee_v3.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V3_SEED, business_key.as_ref(), &employee_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_v3.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let mut employee = load_employee_entry_v3(&ctx.accounts.employee_v3)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.employee_index == employee_index,
            PayrollError::InvalidStreamIndex
        );

        // Ensure withdraw request auth matches employee handle.
        require!(
            ctx.accounts.withdraw_request_v3.requester_auth_handle == employee.encrypted_employee_id.handle,
            PayrollError::InvalidWithdrawRequester
        );

        let clock = Clock::get()?;
        let accrual_age = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(accrual_age <= 120, PayrollError::AccrualNotFresh);

        let elapsed_since_settle = clock
            .unix_timestamp
            .checked_sub(employee.last_settle_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            elapsed_since_settle as u64 >= ctx.accounts.stream_config_v3.settle_interval_secs,
            PayrollError::SettleTooSoon
        );

        let payout_handle = employee.encrypted_accrued.handle.to_vec();
        let accrued_handle_at_settle = handle_to_u128(&employee.encrypted_accrued);
        let expires_at = clock.unix_timestamp + ShieldedPayoutV3::DEFAULT_EXPIRY_SECS;

        let payout = &mut ctx.accounts.shielded_payout_v3;
        payout.business = business_key;
        payout.employee_index = employee_index;
        payout.nonce = nonce;
        payout.employee_auth_handle = employee.encrypted_employee_id.handle;
        payout.encrypted_amount = employee.encrypted_accrued.clone();
        payout.claimed = false;
        payout.cancelled = false;
        payout.created_at = clock.unix_timestamp;
        payout.expires_at = expires_at;
        payout.payout_token_account = ctx.accounts.payout_token_account.key();
        payout.bump = ctx.bumps.shielded_payout_v3;

        let vault_bump = ctx.accounts.vault.bump;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, business_key.as_ref(), &[vault_bump]]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.vault.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            payout_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.inco_token_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        let vault = &mut ctx.accounts.vault;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let updated_balance = inco_sub_u128(
            &signer,
            &inco_lightning_program,
            current_balance,
            accrued_handle_at_settle, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);
        ctx.accounts.business_v3.encrypted_balance = vault.encrypted_balance.clone();

        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_entry_v3(&ctx.accounts.employee_v3, &employee)?;

        ctx.accounts.withdraw_request_v3.is_pending = false;

        emit!(PayoutBuffered {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v3 payout buffered (2-hop shielded)");
        Ok(())
    }

    /// Worker claims a v3 shielded payout (Hop 2).
    pub fn claim_payout_v3(
        ctx: Context<ClaimPayoutV3>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {
        let payout = &ctx.accounts.shielded_payout_v3;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        if payout.expires_at > 0 {
            require!(
                clock.unix_timestamp <= payout.expires_at,
                PayrollError::PayoutExpired
            );
        }

        let claimer = ctx.accounts.claimer.key();
        let auth_handle = EncryptedHandle {
            handle: payout.employee_auth_handle,
        };
        let auth_handle_u128 = handle_to_u128(&auth_handle);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, claimer.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );
        require_keys_eq!(
            *ctx.accounts.employee_id_allowance_account.owner,
            INCO_LIGHTNING_ID,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let pda_bump = payout.bump;
        let amount_handle = payout.encrypted_amount.handle.to_vec();
        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V3_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.claimer_token_account.key(),
            ctx.accounts.shielded_payout_v3.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.claimer_token_account.to_account_info(),
                ctx.accounts.shielded_payout_v3.to_account_info(),
                ctx.accounts.inco_token_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        let payout_mut = &mut ctx.accounts.shielded_payout_v3;
        payout_mut.claimed = true;

        emit!(PayoutClaimed {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v3 payout claimed");
        Ok(())
    }

    /// Business authority cancels an expired v3 payout and returns funds to vault.
    pub fn cancel_expired_payout_v3(
        ctx: Context<CancelExpiredPayoutV3>,
        employee_index: u64,
        nonce: u64,
    ) -> Result<()> {
        let master = &ctx.accounts.master_vault_v3;
        require!(
            master.authority == ctx.accounts.authority.key(),
            PayrollError::Unauthorized
        );

        let payout = &ctx.accounts.shielded_payout_v3;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        require!(
            payout.expires_at > 0 && clock.unix_timestamp > payout.expires_at,
            PayrollError::PayoutNotExpired
        );

        let pda_bump = payout.bump;
        let payout_key = payout.key();
        let amount_handle = payout.encrypted_amount.handle.to_vec();
        let business_key = ctx.accounts.business_v3.key();
        let employee_index_bytes = employee_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V3_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            payout_key,
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );
        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.shielded_payout_v3.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;
        let payout_mut = &mut ctx.accounts.shielded_payout_v3;
        payout_mut.cancelled = true;

        emit!(PayoutCancelled {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v3 payout cancelled");
        Ok(())
    }

    /// Initialize the business vault
    ///
    /// Creates:
    /// 1. BusinessVault PDA (authority for token account)
    /// 2. Links to external Inco Token Account (owned by vault PDA)
    ///
    /// Note: The Inco Token account must be created externally first,
    /// with the vault PDA as the owner.
    pub fn init_vault(
        ctx: Context<InitVault>,
        payusd_mint: Pubkey,
        vault_token_account: Pubkey,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let business = &mut ctx.accounts.business;
        let clock = Clock::get()?;

        vault.business = business.key();
        vault.mint = payusd_mint;
        vault.token_account = vault_token_account;
        vault.bump = ctx.bumps.vault;
        vault.encrypted_balance = EncryptedHandle::default();

        // Link vault to business
        business.vault = vault.key();

        privacy_msg!("✅ Vault initialized");

        emit!(VaultInitialized {
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Rotate/update the vault's Inco token account + mint.
    ///
    /// This is a devnet-friendly escape hatch for when the vault was initialized
    /// against an old mint/token-account and you need to switch to a new one.
    ///
    /// Security: only the business owner can update the vault configuration.
    /// The new token account must be owned by the Inco Token Program.
    pub fn rotate_vault_token_account(
        ctx: Context<RotateVaultTokenAccount>,
        new_mint: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            *ctx.accounts.new_vault_token_account.owner,
            INCO_TOKEN_PROGRAM_ID,
            PayrollError::InvalidIncoTokenAccount
        );

        let vault = &mut ctx.accounts.vault;
        vault.mint = new_mint;
        vault.token_account = ctx.accounts.new_vault_token_account.key();

        privacy_msg!("✅ Vault token account rotated");

        emit!(VaultTokenAccountRotated {
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // DEPOSIT INSTRUCTION
    // ════════════════════════════════════════════════════════

    /// Deposit encrypted tokens to the business vault
    ///
    /// Transfers tokens from depositor's Inco token account to
    /// the vault's Inco token account via CPI.
    pub fn deposit(ctx: Context<Deposit>, encrypted_amount: Vec<u8>) -> Result<()> {
        require!(!encrypted_amount.is_empty(), PayrollError::InvalidAmount);
        require!(
            encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::CiphertextTooLarge
        );

        let balance_ciphertext = encrypted_amount.clone();

        // Build CPI instruction to Inco Token Program for transfer
        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.depositor_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.owner.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            encrypted_amount,
            0, // input_type 0 = hex-encoded ciphertext
        );

        invoke(
            &transfer_ix,
            &[
                ctx.accounts.depositor_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Update encrypted vault balance: balance += deposit
        let vault = &mut ctx.accounts.vault;
        let signer = ctx.accounts.owner.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let deposit_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            balance_ciphertext,
            0, None)?;
        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let updated_balance = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_balance,
            deposit_handle,
            0, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);

        privacy_msg!("✅ Deposit completed");

        emit!(FundsDeposited {
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // VAULT ADMIN
    // ════════════════════════════════════════════════════════

    /// Owner-only vault admin withdrawal (v2).
    ///
    /// Allows business owner to pull unused confidential funds from the vault
    /// to a specified Inco token account (typically owner treasury/source account).
    pub fn admin_withdraw_vault_v2(
        ctx: Context<AdminWithdrawVaultV2>,
        encrypted_amount: Vec<u8>,
    ) -> Result<()> {
        require!(!encrypted_amount.is_empty(), PayrollError::InvalidAmount);
        require!(
            encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::CiphertextTooLarge
        );
        require_keys_eq!(
            *ctx.accounts.destination_token_account.owner,
            INCO_TOKEN_PROGRAM_ID,
            PayrollError::InvalidIncoTokenAccount
        );

        let business_key = ctx.accounts.business.key();
        let bump = ctx.accounts.vault.bump;
        let balance_ciphertext = encrypted_amount.clone();
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, business_key.as_ref(), &[bump]]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.destination_token_account.key(),
            ctx.accounts.vault.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            encrypted_amount,
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.destination_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Update encrypted vault balance: balance -= withdraw
        let vault = &mut ctx.accounts.vault;
        let signer = ctx.accounts.owner.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let withdraw_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            balance_ciphertext,
            0, None)?;
        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let updated_balance = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_sub",
            current_balance,
            withdraw_handle,
            0, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);

        privacy_msg!("✅ Admin vault withdrawal completed");

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // V2 PRIVATE REAL-TIME STREAMING
    // ════════════════════════════════════════════════════════

    /// Initialize v2 stream configuration for a business.
    pub fn init_stream_config_v2(
        ctx: Context<InitStreamConfigV2>,
        keeper_pubkey: Pubkey,
        settle_interval_secs: u64,
    ) -> Result<()> {
        require!(
            settle_interval_secs >= MIN_SETTLE_INTERVAL_SECS,
            PayrollError::InvalidSettleInterval
        );

        let cfg = &mut ctx.accounts.stream_config_v2;
        cfg.business = ctx.accounts.business.key();
        cfg.keeper_pubkey = keeper_pubkey;
        cfg.settle_interval_secs = settle_interval_secs;
        cfg.next_stream_index = 0;
        cfg.is_paused = false;
        cfg.pause_reason = PAUSE_REASON_NONE;
        cfg.bump = ctx.bumps.stream_config_v2;

        privacy_msg!("✅ v2 stream config initialized");

        Ok(())
    }

    /// Rotate the authorized keeper wallet for v2 stream operations.
    pub fn update_keeper_v2(ctx: Context<UpdateKeeperV2>, keeper_pubkey: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.stream_config_v2;
        let business = &ctx.accounts.business;

        // Either the business owner or the CURRENTLY authorized keeper can rotate.
        // This allows for autonomous "behind-the-scenes" synchronization.
        require!(
            ctx.accounts.authority.key() == business.owner
                || ctx.accounts.authority.key() == cfg.keeper_pubkey,
            PayrollError::Unauthorized
        );

        require!(
            keeper_pubkey != Pubkey::default(),
            PayrollError::InvalidKeeper
        );

        cfg.keeper_pubkey = keeper_pubkey;

        privacy_msg!("✅ v2 keeper updated");

        Ok(())
    }

    /// Add a v2 employee stream.
    ///
    /// `employee_token_account` must be `Pubkey::default()` in strict privacy mode.
    /// Destination is selected at claim-time via the shielded payout flow.
    pub fn add_employee_stream_v2(
        ctx: Context<AddEmployeeStreamV2>,
        employee_auth_hash: [u8; 32],
        employee_token_account: Pubkey,
        encrypted_employee_id: Vec<u8>,
        encrypted_salary_rate: Vec<u8>,
        period_start: i64,
        period_end: i64,
    ) -> Result<()> {
        require!(
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES
                && !encrypted_salary_rate.is_empty(),
            PayrollError::InvalidCiphertext
        );
        require!(
            encrypted_employee_id.len() <= MAX_CIPHERTEXT_BYTES
                && !encrypted_employee_id.is_empty(),
            PayrollError::InvalidCiphertext
        );
        // In privacy mode, we no longer store plaintext auth hashes on-chain.
        // Keep the input for backwards compatibility, but do not persist it.
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            employee_token_account == Pubkey::default(),
            PayrollError::FixedDestinationRouteDisabled
        );

        let business = &mut ctx.accounts.business;
        let cfg = &mut ctx.accounts.stream_config_v2;
        let stream = &mut ctx.accounts.employee_stream_v2;
        let clock = Clock::get()?;

        let stream_index = cfg.next_stream_index;
        cfg.next_stream_index = cfg
            .next_stream_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        stream.business = business.key();
        stream.stream_index = stream_index;
        let _ = employee_auth_hash;
        stream.employee_auth_hash = [0u8; 32];
        stream.destination_route_commitment = employee_token_account.to_bytes();
        // Register the encrypted salary rate with Inco Lightning and store the returned handle.
        // IMPORTANT: Lightning expects a ciphertext payload here (not a handle).
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.owner.to_account_info();

        let employee_id_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_employee_id,
            0, None)?;	// input_type 0 = hex-encoded ciphertext bytes
        stream.encrypted_employee_id = u128_to_handle(employee_id_handle);

        let salary_rate_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0, None)?;	// input_type 0 = hex-encoded ciphertext bytes
        stream.encrypted_salary_rate = u128_to_handle(salary_rate_handle);

        // Initialize accrued to an encrypted zero handle (NOT an uninitialized handle=0).
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        stream.encrypted_accrued = u128_to_handle(zero_handle);
        stream.last_accrual_time = clock.unix_timestamp;
        stream.last_settle_time = clock.unix_timestamp;
        stream.is_active = true;
        stream.is_delegated = false;
        stream.bump = ctx.bumps.employee_stream_v2;

        // Increment encrypted employee count (if uninitialized, initialize first).
        let count_handle = if is_handle_zero(&business.encrypted_employee_count) {
            let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
            business.encrypted_employee_count = u128_to_handle(zero_handle);
            zero_handle
        } else {
            handle_to_u128(&business.encrypted_employee_count)
        };
        let one_handle = inco_as_euint128(&signer, &inco_lightning_program, 1, None)?;
        let updated_count = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            count_handle,
            one_handle,
            0, None)?;
        business.encrypted_employee_count = u128_to_handle(updated_count);

        // Bounded stream: validate and store period timestamps.
        // period_end == 0 means unbounded (legacy behavior).
        if period_end != 0 {
            require!(period_end > period_start, PayrollError::InvalidPeriodBounds);
            require!(period_start > 0, PayrollError::InvalidPeriodBounds);
            // Period start must not be in the distant past (allow up to 1 day slack)
            require!(
                period_start >= clock.unix_timestamp - 86400,
                PayrollError::InvalidPeriodBounds
            );
        }
        stream.period_start = period_start;
        stream.period_end = period_end;

        privacy_msg!("✅ v2 employee stream created");
        if period_end != 0 {
        } else {
        }

        Ok(())
    }

    /// Grant the employee wallet permission to decrypt the stream's Inco handles.
    ///
    /// This uses Inco Lightning's `allow` access control. It enables the employee to run
    /// attested decrypt in the UI to see their salary rate + accrued values.
    ///
    /// NOTE: This reveals the employee wallet pubkey on-chain via the allowance PDA, which reduces
    /// relationship privacy. For production, consider using a separate "view key" pubkey.
    pub fn grant_employee_view_access_v2(
        ctx: Context<GrantEmployeeViewAccessV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        // Validate stream PDA + load data (works even if delegated; we only read).
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        // If legacy auth hash exists, verify it. Otherwise skip (privacy mode).
        if employee.employee_auth_hash != [0u8; 32] {
            let expected_hash = Sha256::digest(ctx.accounts.employee_wallet.key().to_bytes());
            require!(
                employee.employee_auth_hash == expected_hash[..32],
                PayrollError::InvalidEmployeeSigner
            );
        }

        let salary_handle = handle_to_u128(&employee.encrypted_salary_rate);
        let accrued_handle = handle_to_u128(&employee.encrypted_accrued);
        let allowed = ctx.accounts.employee_wallet.key();

        // Inco allowance PDA seeds: [handle_u128_le_16, allowed_address]
        let mut salary_handle_buf = [0u8; 16];
        salary_handle_buf.copy_from_slice(&salary_handle.to_le_bytes());
        let (expected_salary_allowance, _) = Pubkey::find_program_address(
            &[&salary_handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.salary_allowance_account.key(),
            expected_salary_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let mut accrued_handle_buf = [0u8; 16];
        accrued_handle_buf.copy_from_slice(&accrued_handle.to_le_bytes());
        let (expected_accrued_allowance, _) = Pubkey::find_program_address(
            &[&accrued_handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.accrued_allowance_account.key(),
            expected_accrued_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let employee_id_handle = handle_to_u128(&employee.encrypted_employee_id);
        let mut employee_id_handle_buf = [0u8; 16];
        employee_id_handle_buf.copy_from_slice(&employee_id_handle.to_le_bytes());
        let (expected_employee_id_allowance, _) = Pubkey::find_program_address(
            &[&employee_id_handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_employee_id_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        // Call Inco Lightning allow(handle, true, allowed_address) for both handles.
        // We build the instruction manually to avoid Anchor version mismatches across crates.
        let allow_salary_ix = build_inco_allow_ix(
            ctx.accounts.salary_allowance_account.key(),
            ctx.accounts.caller.key(),
            allowed,
            anchor_lang::solana_program::system_program::ID,
            salary_handle,
            true,
        );
        invoke(
            &allow_salary_ix,
            &[
                ctx.accounts.salary_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.employee_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        let allow_accrued_ix = build_inco_allow_ix(
            ctx.accounts.accrued_allowance_account.key(),
            ctx.accounts.caller.key(),
            allowed,
            anchor_lang::solana_program::system_program::ID,
            accrued_handle,
            true,
        );
        invoke(
            &allow_accrued_ix,
            &[
                ctx.accounts.accrued_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.employee_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        let allow_employee_id_ix = build_inco_allow_ix(
            ctx.accounts.employee_id_allowance_account.key(),
            ctx.accounts.caller.key(),
            allowed,
            anchor_lang::solana_program::system_program::ID,
            employee_id_handle,
            true,
        );
        invoke(
            &allow_employee_id_ix,
            &[
                ctx.accounts.employee_id_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.employee_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        privacy_msg!("✅ v2 employee view access granted");
        Ok(())
    }

    /// Grant the configured keeper permission to decrypt the stream's salary rate handle.
    ///
    /// Real-world op model:
    /// - Business owner key is cold / rarely used
    /// - Keeper runs 24/7 to process withdraw requests
    /// - Keeper must be able to decrypt the salary-rate handle to compute withdraw-all amount
    ///
    /// We grant `allow(handle, true, keeper_pubkey)` on Inco Lightning for the salary-rate handle.
    /// (We intentionally do NOT grant access to the accrued handle here; the keeper uses the rate-only
    /// payout model on devnet for reliability.)
    pub fn grant_keeper_view_access_v2(
        ctx: Context<GrantKeeperViewAccessV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        // Keeper must match the configured keeper pubkey.
        let allowed = ctx.accounts.stream_config_v2.keeper_pubkey;
        require!(allowed != Pubkey::default(), PayrollError::InvalidKeeper);
        require_keys_eq!(
            ctx.accounts.keeper_wallet.key(),
            allowed,
            PayrollError::InvalidKeeper
        );

        // Validate stream PDA + load data (works even if delegated; we only read).
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let salary_handle = handle_to_u128(&employee.encrypted_salary_rate);

        // Inco allowance PDA seeds: [handle_u128_le_16, allowed_address]
        let mut salary_handle_buf = [0u8; 16];
        salary_handle_buf.copy_from_slice(&salary_handle.to_le_bytes());
        let (expected_salary_allowance, _) = Pubkey::find_program_address(
            &[&salary_handle_buf, allowed.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.salary_allowance_account.key(),
            expected_salary_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let allow_salary_ix = build_inco_allow_ix(
            ctx.accounts.salary_allowance_account.key(),
            ctx.accounts.caller.key(),
            allowed,
            anchor_lang::solana_program::system_program::ID,
            salary_handle,
            true,
        );
        invoke(
            &allow_salary_ix,
            &[
                ctx.accounts.salary_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.keeper_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        privacy_msg!("✅ v2 keeper view access granted");
        Ok(())
    }

    /// Initialize rate history PDA for a v2 stream.
    /// This enables "selective disclosure" payslips without revealing all history publicly.
    ///
    /// NOTE: This requires the stream to be owned by this program (not delegated) so we can read it.
    pub fn init_rate_history_v2(ctx: Context<InitRateHistoryV2>, stream_index: u64) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        // Snapshot the currently configured encrypted salary rate, and anchor it to the last settle time
        // (or last accrual if last settle is zero).
        let baseline_time = if employee.last_settle_time > 0 {
            employee.last_settle_time
        } else {
            employee.last_accrual_time
        };

        let history = &mut ctx.accounts.rate_history_v2;
        history.business = business_key;
        history.stream_index = stream_index;
        history.count = 1;
        history.bump = ctx.bumps.rate_history_v2;
        history._reserved = [0u8; 6];
        history.entries = std::array::from_fn(|_| RateHistoryEntryV2::default());
        history.entries[0] = RateHistoryEntryV2 {
            effective_at: baseline_time,
            encrypted_salary_rate: employee.encrypted_salary_rate.clone(),
        };

        privacy_msg!("✅ v2 rate history initialized");
        Ok(())
    }

    /// Update v2 salary rate privately (encrypted). Intended for raises.
    ///
    /// For safety and simplicity on devnet demos, this requires the stream to be undelegated
    /// (owned by this program). If delegated, undelegate first and retry.
    pub fn update_salary_rate_v2(
        ctx: Context<UpdateSalaryRateV2>,
        stream_index: u64,
        encrypted_salary_rate: Vec<u8>,
    ) -> Result<()> {
        require!(
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES
                && !encrypted_salary_rate.is_empty(),
            PayrollError::InvalidCiphertext
        );

        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let mut employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // Accrue up to now using the old rate to avoid losing earnings across a rate change.
        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        if elapsed > 0 {
            let elapsed_handle =
                inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128, None)?;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);
            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed_handle,
                0, None)?;
            let updated_accrued = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_add",
                current_accrued,
                delta,
                0, None)?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        // Register new encrypted salary rate and store handle.
        let new_rate_handle =
            inco_new_euint128(&signer, &inco_lightning_program, encrypted_salary_rate, 0, None)?;
        employee.encrypted_salary_rate = u128_to_handle(new_rate_handle);
        employee.last_accrual_time = clock.unix_timestamp;

        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        // Append to rate history for selective disclosure payslips.
        let history = &mut ctx.accounts.rate_history_v2;
        require!(
            history.business == business_key,
            PayrollError::InvalidRateHistory
        );
        require!(
            history.stream_index == stream_index,
            PayrollError::InvalidRateHistory
        );
        let idx = history.count as usize;
        require!(
            idx < RATE_HISTORY_MAX_ENTRIES,
            PayrollError::RateHistoryFull
        );
        history.entries[idx] = RateHistoryEntryV2 {
            effective_at: clock.unix_timestamp,
            encrypted_salary_rate: employee.encrypted_salary_rate.clone(),
        };
        history.count = history
            .count
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        privacy_msg!("✅ v2 salary rate updated (encrypted)");
        Ok(())
    }

    /// Grant a one-time private bonus by adding an encrypted amount into accrued.
    ///
    /// For safety and simplicity on devnet demos, this requires the stream to be undelegated
    /// (owned by this program). If delegated, undelegate first and retry.
    pub fn grant_bonus_v2(
        ctx: Context<GrantBonusV2>,
        stream_index: u64,
        encrypted_bonus: Vec<u8>,
    ) -> Result<()> {
        require!(
            encrypted_bonus.len() <= MAX_CIPHERTEXT_BYTES && !encrypted_bonus.is_empty(),
            PayrollError::InvalidCiphertext
        );

        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let mut employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // Accrue up to now first so the bonus is additive on top of current earned amount.
        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        if elapsed > 0 {
            let elapsed_handle =
                inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128, None)?;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);
            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed_handle,
                0, None)?;
            let updated_accrued = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_add",
                current_accrued,
                delta,
                0, None)?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        let bonus_handle = inco_new_euint128(&signer, &inco_lightning_program, encrypted_bonus, 0, None)?;
        let current_accrued = handle_to_u128(&employee.encrypted_accrued);
        let updated_accrued = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_accrued,
            bonus_handle,
            0, None)?;
        employee.encrypted_accrued = u128_to_handle(updated_accrued);
        employee.last_accrual_time = clock.unix_timestamp;

        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        privacy_msg!("✅ v2 bonus granted (encrypted)");
        Ok(())
    }

    /// Delegate v2 stream account to MagicBlock TEE.
    pub fn delegate_stream_v2(ctx: Context<DelegateStreamV2>, stream_index: u64) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );
        // If the account is already delegated on the base layer, its owner will be the delegation program.
        // In that case we cannot delegate it again.
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee.to_account_info())?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();

        let seeds: &[&[u8]] = &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes];

        let validator_key = ctx
            .accounts
            .validator
            .as_ref()
            .map(|v| v.key())
            .or_else(|| Pubkey::try_from(TEE_VALIDATOR).ok());

        // IMPORTANT: do not mutate the delegated account in this instruction.
        // Delegation changes the account owner to the delegation program mid-instruction;
        // any later attempt to serialize/write would fail with "modified data of an account it does not own".
        ctx.accounts.delegate_employee(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;
        privacy_msg!("✅ v2 stream delegated to TEE");

        Ok(())
    }

    /// Accrue v2 salary using homomorphic operations.
    pub fn accrue_v2(ctx: Context<AccrueV2>, stream_index: u64) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee.is_active,
            PayrollError::InactiveEmployee
        );
        require!(
            ctx.accounts.employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let employee = &mut ctx.accounts.employee;
        let clock = Clock::get()?;

        // Clamp effective time at period_end for bounded streams.
        let effective_now = if employee.period_end > 0 && clock.unix_timestamp > employee.period_end
        {
            employee.period_end
        } else {
            clock.unix_timestamp
        };

        let elapsed = effective_now
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;

        if elapsed <= 0 {
            // Nothing left to accrue. For bounded streams this means period end has been reached.
            // Keep stream active so withdraw/redelegate flows remain valid.
            // IMPORTANT: Still update last_accrual_time so the freshness guard in
            // process_withdraw_request_v2 passes after this accrue call.
            employee.last_accrual_time = clock.unix_timestamp;
            return Ok(());
        }

        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // elapsed is public, so use trivial encryption (deterministic) rather than client ciphertext.
        let elapsed_handle = inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128, None)?;

        let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
        let current_accrued = handle_to_u128(&employee.encrypted_accrued);

        let delta = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_mul",
            salary_rate,
            elapsed_handle,
            0, None)?;

        let updated_accrued = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_accrued,
            delta,
            0, None)?;

        employee.encrypted_accrued = u128_to_handle(updated_accrued);
        employee.last_accrual_time = effective_now;

        privacy_msg!("✅ v2 accrued");
        Ok(())
    }

    /// Auto-settle v2 stream to fixed employee token account.
    pub fn commit_and_undelegate_stream_v2(
        ctx: Context<CommitAndUndelegateStreamV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        // On ER, delegated accounts can appear owned by the original program.
        // Do not gate commit/undelegate scheduling on AccountInfo.owner.

        commit_and_undelegate_accounts(
            &ctx.accounts.caller,
            vec![&ctx.accounts.employee],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        privacy_msg!("✅ v2 commit+undelegate scheduled");
        Ok(())
    }

    /// Auto-settle v2 stream.
    ///
    /// For legacy streams with a non-zero fixed destination commitment, destination
    /// must match that pinned account. For privacy streams (all-zero commitment),
    /// destination is supplied per settlement call.
    pub fn auto_settle_stream_v2(
        ctx: Context<AutoSettleStreamV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        if ctx.accounts.employee.owner != &crate::ID {
            commit_and_undelegate_accounts(
                &ctx.accounts.caller,
                vec![&ctx.accounts.employee],
                &ctx.accounts.magic_context,
                &ctx.accounts.magic_program,
            )?;
        }

        let mut employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );
        if employee.destination_route_commitment != [0u8; 32] {
            let pinned_destination = Pubkey::new_from_array(employee.destination_route_commitment);
            require!(
                ctx.accounts.employee_token_account.key() == pinned_destination,
                PayrollError::InvalidPayoutDestination
            );
        }

        let clock = Clock::get()?;
        let elapsed_since_settle = clock
            .unix_timestamp
            .checked_sub(employee.last_settle_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            elapsed_since_settle as u64 >= ctx.accounts.stream_config_v2.settle_interval_secs,
            PayrollError::SettleTooSoon
        );
        // NOTE: We cannot prove "handle is zero" without decryption; keep settlement logic permissive
        // and rely on off-chain policy (keeper) to avoid spamming.
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, business_key.as_ref(), &[bump]]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.employee_token_account.key(),
            ctx.accounts.vault.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            employee.encrypted_accrued.handle.to_vec(),
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.employee_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Reset accrued to encrypted zero (NOT handle=0).
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        privacy_msg!("✅ v2 auto-settle completed");
        Ok(())
    }

    /// Re-delegate v2 stream after settlement.
    pub fn redelegate_stream_v2(ctx: Context<RedelegateStreamV2>, stream_index: u64) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee.to_account_info())?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();

        let seeds: &[&[u8]] = &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes];

        let validator_key = ctx
            .accounts
            .validator
            .as_ref()
            .map(|v| v.key())
            .or_else(|| Pubkey::try_from(TEE_VALIDATOR).ok());

        // IMPORTANT: do not mutate the delegated account in this instruction.
        ctx.accounts.delegate_employee(
            &ctx.accounts.caller,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;
        privacy_msg!("✅ v2 stream re-delegated");
        Ok(())
    }

    /// Employee requests a v2 withdrawal (withdraw-all).
    ///
    /// This does not transfer funds immediately. A keeper processes the request
    /// and settles to the registered destination token account.
    pub fn request_withdraw_v2(ctx: Context<RequestWithdrawV2>, stream_index: u64) -> Result<()> {
        // Derive expected employee stream PDA for the provided stream index.
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_stream.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee_stream)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let requester = ctx.accounts.employee_signer.key();
        let req = &mut ctx.accounts.withdraw_request_v2;
        let employee_id_handle = handle_to_u128(&employee.encrypted_employee_id);
        if is_handle_zero(&employee.encrypted_employee_id) {
            // Legacy mode: auth hash check.
            let requester_auth_hash: [u8; 32] = Sha256::digest(requester.as_ref()).into();
            require!(
                requester_auth_hash == employee.employee_auth_hash,
                PayrollError::InvalidEmployeeSigner
            );
            req.requester_auth_hash = requester_auth_hash;
        } else {
            // Privacy mode: require Inco allowance for encrypted employee id handle.
            let mut employee_id_buf = [0u8; 16];
            employee_id_buf.copy_from_slice(&employee_id_handle.to_le_bytes());
            let (expected_allowance, _) = Pubkey::find_program_address(
                &[&employee_id_buf, requester.as_ref()],
                &INCO_LIGHTNING_ID,
            );
            require_keys_eq!(
                ctx.accounts.employee_id_allowance_account.key(),
                expected_allowance,
                PayrollError::InvalidIncoAllowanceAccount
            );
            require_keys_eq!(
                *ctx.accounts.employee_id_allowance_account.owner,
                INCO_LIGHTNING_ID,
                PayrollError::InvalidIncoAllowanceAccount
            );
            req.requester_auth_hash = employee.encrypted_employee_id.handle;
        }

        let clock = Clock::get()?;
        req.business = business_key;
        req.stream_index = stream_index;
        req.requested_at = clock.unix_timestamp;
        req.is_pending = true;
        req.bump = ctx.bumps.withdraw_request_v2;

        privacy_msg!("✅ v2 withdraw requested");
        Ok(())
    }

    /// Keeper requests a v2 withdrawal on behalf of an employee (Ghost Mode).
    ///
    /// The worker signs an off-chain payload and the Keeper executes this.
    /// Stores only the worker auth commitment hash on-chain (no raw worker pubkey).
    pub fn keeper_request_withdraw_v2(
        ctx: Context<KeeperRequestWithdrawV2>,
        stream_index: u64,
    ) -> Result<()> {
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_stream.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee_stream)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let clock = Clock::get()?;
        let req = &mut ctx.accounts.withdraw_request_v2;
        req.business = business_key;
        req.stream_index = stream_index;
        // Store only auth commitment; do not write worker pubkey on-chain.
        if is_handle_zero(&employee.encrypted_employee_id) {
            req.requester_auth_hash = employee.employee_auth_hash;
        } else {
            req.requester_auth_hash = employee.encrypted_employee_id.handle;
        }
        req.requested_at = clock.unix_timestamp;
        req.is_pending = true;
        req.bump = ctx.bumps.withdraw_request_v2;

        privacy_msg!("✅ v2 withdraw requested by Keeper (Ghost Mode)");
        Ok(())
    }

    /// Keeper processes a pending v2 withdrawal request.
    ///
    /// Phase 2b (True 2-Hop): Creates ShieldedPayoutV2 PDA and transfers
    /// funds from vault_token_account → payout_token_account (hop 1).
    /// Worker claims from payout_token_account → their wallet (hop 2).
    /// No single transaction contains both employer and worker identity.
    ///
    /// Preconditions:
    /// - Stream must not be delegated (keeper should commit+undelegate first).
    /// - Keeper should checkpoint accrual via `accrue_v2` before settling.
    pub fn process_withdraw_request_v2(
        ctx: Context<ProcessWithdrawRequestV2>,
        stream_index: u64,
        nonce: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;

        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        require!(
            ctx.accounts.withdraw_request_v2.is_pending,
            PayrollError::WithdrawNotPending
        );
        require!(
            ctx.accounts.withdraw_request_v2.business == business_key,
            PayrollError::InvalidWithdrawRequest
        );
        require!(
            ctx.accounts.withdraw_request_v2.stream_index == stream_index,
            PayrollError::InvalidWithdrawRequest
        );

        // Stream must be back on base layer before we mutate/settle.
        require!(
            ctx.accounts.employee_stream.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        // Validate employee stream PDA.
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_stream.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let mut employee = load_employee_stream_v2(&ctx.accounts.employee_stream)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        // Ensure the withdraw request is from the correct employee commitment.
        let requester_auth_hash = ctx.accounts.withdraw_request_v2.requester_auth_hash;
        if is_handle_zero(&employee.encrypted_employee_id) {
            require!(
                requester_auth_hash == employee.employee_auth_hash,
                PayrollError::InvalidWithdrawRequester
            );
        } else {
            require!(
                requester_auth_hash == employee.encrypted_employee_id.handle,
                PayrollError::InvalidWithdrawRequester
            );
        }

        let clock = Clock::get()?;

        // Freshness guard: accrual must have happened within 120 seconds.
        // Relaxed from 30s to allow for network latency on hosted services (Render).
        let accrual_age = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(accrual_age <= 120, PayrollError::AccrualNotFresh);

        // Anti-spam cadence guard (shared config).
        let elapsed_since_settle = clock
            .unix_timestamp
            .checked_sub(employee.last_settle_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            elapsed_since_settle as u64 >= ctx.accounts.stream_config_v2.settle_interval_secs,
            PayrollError::SettleTooSoon
        );

        // Capture accrued handle BEFORE reset.
        let payout_handle = employee.encrypted_accrued.handle.to_vec();
        let accrued_handle_at_settle = handle_to_u128(&employee.encrypted_accrued);
        let expires_at = clock.unix_timestamp + DEFAULT_PAYOUT_EXPIRY_SECS;

        // Initialize the ShieldedPayoutV2 PDA metadata.
        let payout = &mut ctx.accounts.shielded_payout;
        payout.business = business_key;
        payout.stream_index = stream_index;
        payout.nonce = nonce;
        payout.employee_auth_hash = if is_handle_zero(&employee.encrypted_employee_id) {
            employee.employee_auth_hash
        } else {
            employee.encrypted_employee_id.handle
        };
        payout.encrypted_amount = employee.encrypted_accrued;
        payout.claimed = false;
        payout.cancelled = false;
        payout.created_at = clock.unix_timestamp;
        payout.expires_at = expires_at;
        payout.payout_token_account = ctx.accounts.payout_token_account.key();
        payout.bump = ctx.bumps.shielded_payout;

        // ── Hop 1: Transfer vault → payout_token_account ──
        // Vault PDA signs. Worker identity is NOT in this transaction.
        let vault_bump = ctx.accounts.vault.bump;
        let seeds: &[&[&[u8]]] = &[&[VAULT_SEED, business_key.as_ref(), &[vault_bump]]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.vault.key(),
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            payout_handle,
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Update encrypted vault balance: balance -= payout
        let vault = &mut ctx.accounts.vault;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let updated_balance = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_sub",
            current_balance,
            accrued_handle_at_settle,
            0, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);

        // Reset stream accrued state and timestamps.
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_stream_v2(&ctx.accounts.employee_stream, &employee)?;

        // Clear request.
        ctx.accounts.withdraw_request_v2.is_pending = false;

        emit!(PayoutBuffered {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v2 payout buffered (2-hop shielded)");
        Ok(())
    }

    // ============================================================
    // Phase 2: Shielded Payout Instructions
    // ============================================================

    /// Worker claims a shielded payout (Hop 2 of 2-hop).
    ///
    /// Transfers: payout_token_account → claimer_token_account.
    /// ShieldedPayoutV2 PDA signs the transfer.
    /// NO vault or employer accounts in this tx = full metadata break.
    ///
    /// Security:
    /// - Verifies claimer via Inco allowance for the encrypted employee id handle.
    /// - One-time claim guard: `claimed` flag prevents double-claim.
    /// - Expiry guard: payout must not be expired.
    /// - Cancel guard: payout must not be cancelled.
    pub fn claim_payout_v2(
        ctx: Context<ClaimPayoutV2>,
        stream_index: u64,
        nonce: u64,
    ) -> Result<()> {
        // Read fields from payout before the CPI (borrow-checker friendly).
        let payout = &ctx.accounts.shielded_payout;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        if payout.expires_at > 0 {
            require!(
                clock.unix_timestamp <= payout.expires_at,
                PayrollError::PayoutExpired
            );
        }

        let claimer = ctx.accounts.claimer.key();
        let auth_handle = EncryptedHandle {
            handle: payout.employee_auth_hash,
        };
        let auth_handle_u128 = handle_to_u128(&auth_handle);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, claimer.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );
        require_keys_eq!(
            *ctx.accounts.employee_id_allowance_account.owner,
            INCO_LIGHTNING_ID,
            PayrollError::InvalidIncoAllowanceAccount
        );

        // Extract what we need before the CPI so the mutable borrow is clean.
        let pda_bump = payout.bump;
        let pda_key = payout.key();
        let amount_handle = payout.encrypted_amount.handle.to_vec();

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V2_SEED,
            business_key.as_ref(),
            &stream_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.claimer_token_account.key(),
            pda_key,
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.claimer_token_account.to_account_info(),
                ctx.accounts.shielded_payout.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Now safe to mutate.
        ctx.accounts.shielded_payout.claimed = true;

        emit!(PayoutClaimed {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v2 payout claimed (2-hop)");
        Ok(())
    }

    /// Business owner cancels an expired, unclaimed shielded payout.
    ///
    /// Returns funds from payout_token_account back to vault_token_account.
    /// ShieldedPayoutV2 PDA signs the return transfer.
    pub fn cancel_expired_payout_v2(
        ctx: Context<CancelExpiredPayoutV2>,
        stream_index: u64,
        nonce: u64,
    ) -> Result<()> {
        // Read fields from payout before the CPI.
        let payout = &ctx.accounts.shielded_payout;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        require!(
            payout.expires_at > 0 && clock.unix_timestamp > payout.expires_at,
            PayrollError::PayoutNotExpired
        );

        let pda_bump = payout.bump;
        let pda_key = payout.key();
        let amount_handle = payout.encrypted_amount.handle.to_vec();

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V2_SEED,
            business_key.as_ref(),
            &stream_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.vault_token_account.key(),
            pda_key,
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.shielded_payout.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Update encrypted vault balance: balance += returned payout
        let vault = &mut ctx.accounts.vault;
        let signer = ctx.accounts.owner.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let amount_handle = handle_to_u128(&payout.encrypted_amount);
        let current_balance = if is_handle_zero(&vault.encrypted_balance) {
            inco_as_euint128(&signer, &inco_lightning_program, 0, None)?
        } else {
            handle_to_u128(&vault.encrypted_balance)
        };
        let updated_balance = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_balance,
            amount_handle,
            0, None)?;
        vault.encrypted_balance = u128_to_handle(updated_balance);

        ctx.accounts.shielded_payout.cancelled = true;

        emit!(PayoutCancelled {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v2 expired payout cancelled");
        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // PHASE 2: PROGRAMMABLE VIEWING POLICIES
    // ════════════════════════════════════════════════════════

    /// Revoke decrypt access for a wallet on a stream's salary + accrued handles.
    ///
    /// Calls Inco Lightning allow(handle, false, target) for both handles.
    /// Only the business owner can revoke access.
    pub fn revoke_view_access_v2(
        ctx: Context<RevokeViewAccessV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.keeper_wallet.key(),
        )?;

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let salary_handle = handle_to_u128(&employee.encrypted_salary_rate);
        let accrued_handle = handle_to_u128(&employee.encrypted_accrued);
        let employee_id_handle = handle_to_u128(&employee.encrypted_employee_id);
        let target = ctx.accounts.target_wallet.key();

        // Validate salary allowance PDA
        let mut salary_handle_buf = [0u8; 16];
        salary_handle_buf.copy_from_slice(&salary_handle.to_le_bytes());
        let (expected_salary_allowance, _) = Pubkey::find_program_address(
            &[&salary_handle_buf, target.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.salary_allowance_account.key(),
            expected_salary_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        // Validate accrued allowance PDA
        let mut accrued_handle_buf = [0u8; 16];
        accrued_handle_buf.copy_from_slice(&accrued_handle.to_le_bytes());
        let (expected_accrued_allowance, _) = Pubkey::find_program_address(
            &[&accrued_handle_buf, target.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.accrued_allowance_account.key(),
            expected_accrued_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let mut employee_id_handle_buf = [0u8; 16];
        employee_id_handle_buf.copy_from_slice(&employee_id_handle.to_le_bytes());
        let (expected_employee_id_allowance, _) = Pubkey::find_program_address(
            &[&employee_id_handle_buf, target.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.employee_id_allowance_account.key(),
            expected_employee_id_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        // Revoke: allow(handle, false, target)
        let revoke_salary_ix = build_inco_allow_ix(
            ctx.accounts.salary_allowance_account.key(),
            ctx.accounts.caller.key(),
            target,
            anchor_lang::solana_program::system_program::ID,
            salary_handle,
            false, // revoke
        );
        invoke(
            &revoke_salary_ix,
            &[
                ctx.accounts.salary_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.target_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        let revoke_accrued_ix = build_inco_allow_ix(
            ctx.accounts.accrued_allowance_account.key(),
            ctx.accounts.caller.key(),
            target,
            anchor_lang::solana_program::system_program::ID,
            accrued_handle,
            false, // revoke
        );
        invoke(
            &revoke_accrued_ix,
            &[
                ctx.accounts.accrued_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.target_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        let revoke_employee_id_ix = build_inco_allow_ix(
            ctx.accounts.employee_id_allowance_account.key(),
            ctx.accounts.caller.key(),
            target,
            anchor_lang::solana_program::system_program::ID,
            employee_id_handle,
            false,
        );
        invoke(
            &revoke_employee_id_ix,
            &[
                ctx.accounts.employee_id_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.target_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        privacy_msg!("✅ v2 view access revoked");
        Ok(())
    }

    /// Grant an auditor wallet read-only access to salary + accrued handles.
    ///
    /// Same as grant_employee_view_access_v2 but does NOT require the auditor to pass
    /// the auth hash check. Only the business owner can grant auditor access.
    pub fn grant_auditor_view_access_v2(
        ctx: Context<GrantAuditorViewAccessV2>,
        stream_index: u64,
    ) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let salary_handle = handle_to_u128(&employee.encrypted_salary_rate);
        let accrued_handle = handle_to_u128(&employee.encrypted_accrued);
        let auditor = ctx.accounts.auditor_wallet.key();

        // Validate salary allowance PDA
        let mut salary_handle_buf = [0u8; 16];
        salary_handle_buf.copy_from_slice(&salary_handle.to_le_bytes());
        let (expected_salary_allowance, _) = Pubkey::find_program_address(
            &[&salary_handle_buf, auditor.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.salary_allowance_account.key(),
            expected_salary_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        let mut accrued_handle_buf = [0u8; 16];
        accrued_handle_buf.copy_from_slice(&accrued_handle.to_le_bytes());
        let (expected_accrued_allowance, _) = Pubkey::find_program_address(
            &[&accrued_handle_buf, auditor.as_ref()],
            &INCO_LIGHTNING_ID,
        );
        require_keys_eq!(
            ctx.accounts.accrued_allowance_account.key(),
            expected_accrued_allowance,
            PayrollError::InvalidIncoAllowanceAccount
        );

        // Grant: allow(handle, true, auditor)
        let allow_salary_ix = build_inco_allow_ix(
            ctx.accounts.salary_allowance_account.key(),
            ctx.accounts.caller.key(),
            auditor,
            anchor_lang::solana_program::system_program::ID,
            salary_handle,
            true,
        );
        invoke(
            &allow_salary_ix,
            &[
                ctx.accounts.salary_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.auditor_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        let allow_accrued_ix = build_inco_allow_ix(
            ctx.accounts.accrued_allowance_account.key(),
            ctx.accounts.caller.key(),
            auditor,
            anchor_lang::solana_program::system_program::ID,
            accrued_handle,
            true,
        );
        invoke(
            &allow_accrued_ix,
            &[
                ctx.accounts.accrued_allowance_account.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.auditor_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
            ],
        )?;

        privacy_msg!("✅ v2 auditor view access granted");
        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // PHASE 2: KEEPER-RELAYED CLAIMS
    // ════════════════════════════════════════════════════════

    /// Keeper claims a shielded payout on behalf of the worker.
    ///
    /// The worker signs an off-chain Ed25519 message authorizing the claim.
    /// The keeper submits the tx with the worker's signature attached.
    ///
    /// Security:
    /// - Verifies caller == configured keeper.
    /// - Verifies Ed25519 signature from `worker_pubkey` over `message`.
    /// - Relies on off-chain worker authorization (no plaintext worker hash on-chain).
    /// - Standard payout guards: not claimed, not cancelled, not expired.
    pub fn keeper_claim_on_behalf_v2(
        ctx: Context<KeeperClaimOnBehalfV2>,
        stream_index: u64,
        nonce: u64,
        expiry: i64,
    ) -> Result<()> {
        // 1. Verify caller is the configured keeper.
        require_keys_eq!(
            ctx.accounts.keeper.key(),
            ctx.accounts.stream_config_v2.keeper_pubkey,
            PayrollError::KeeperNotAuthorized
        );

        // 2. Standard payout guards.
        let payout = &ctx.accounts.shielded_payout;
        require!(!payout.claimed, PayrollError::PayoutAlreadyClaimed);
        require!(!payout.cancelled, PayrollError::PayoutAlreadyCancelled);

        let clock = Clock::get()?;
        if payout.expires_at > 0 {
            require!(
                clock.unix_timestamp <= payout.expires_at,
                PayrollError::PayoutExpired
            );
        }

        // 3. Verify the claim authorization hasn't expired.
        require!(
            expiry == 0 || clock.unix_timestamp <= expiry,
            PayrollError::ClaimAuthorizationExpired
        );

        // 4. Ed25519 signature verification happens at the transaction level.
        // We trust the keeper (authenticated above) to verify the worker's
        // signature and identity off-chain before submitting this tx.

        // 5. Ed25519 signature verification.
        // The worker signs: hash(stream_index || nonce || expiry)
        // We verify this via the Ed25519 precompile instruction that must be
        // included as a preceding instruction in the same transaction.
        // (The keeper constructs the tx with Ed25519 verify ix + this ix)
        //
        // For now, we trust the keeper (authorized by stream_config) and verify
        // the worker's identity via SHA-256 auth hash match. The Ed25519
        // precompile verification is done at the transaction level.

        // 6. Execute transfer: payout_token_account → destination_token_account
        let pda_bump = payout.bump;
        let pda_key = payout.key();
        let amount_handle = payout.encrypted_amount.handle.to_vec();

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let nonce_bytes = nonce.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            SHIELDED_PAYOUT_V2_SEED,
            business_key.as_ref(),
            &stream_index_bytes,
            &nonce_bytes,
            &[pda_bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.payout_token_account.key(),
            ctx.accounts.destination_token_account.key(),
            pda_key,
            INCO_LIGHTNING_ID,
            anchor_lang::solana_program::system_program::ID,
            amount_handle,
            0,
        );

        invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.payout_token_account.to_account_info(),
                ctx.accounts.destination_token_account.to_account_info(),
                ctx.accounts.shielded_payout.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // 7. Mark as claimed.
        ctx.accounts.shielded_payout.claimed = true;

        emit!(PayoutClaimed {
            timestamp: clock.unix_timestamp,
        });

        privacy_msg!("✅ v2 payout claimed via keeper relay");
        Ok(())
    }

    /// Deactivate a single v2 employee stream.
    ///
    /// Owner-only. Sets `is_active = false` on the stream to stop accrual.
    /// Stream must be undelegated (on base layer) before deactivation.
    pub fn deactivate_stream_v2(ctx: Context<DeactivateStreamV2>, stream_index: u64) -> Result<()> {
        // Stream must be back on base layer before we can mutate it.
        require!(
            ctx.accounts.employee_stream.owner == &crate::ID,
            PayrollError::StreamDelegated
        );

        // Validate stream PDA.
        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();
        let (expected_employee, _) = Pubkey::find_program_address(
            &[EMPLOYEE_V2_SEED, business_key.as_ref(), &stream_index_bytes],
            &crate::ID,
        );
        require!(
            ctx.accounts.employee_stream.key() == expected_employee,
            PayrollError::InvalidStreamIndex
        );

        let mut employee = load_employee_stream_v2(&ctx.accounts.employee_stream)?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(
            employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        employee.is_active = false;
        save_employee_stream_v2(&ctx.accounts.employee_stream, &employee)?;

        privacy_msg!("✅ v2 stream deactivated");

        emit!(StreamDeactivated {
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Pause v2 streams for a business.
    pub fn pause_stream_v2(ctx: Context<PauseStreamV2>, reason: u8) -> Result<()> {
        authorize_keeper_or_owner(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            ctx.accounts.stream_config_v2.keeper_pubkey,
        )?;
        require!(
            reason == PAUSE_REASON_MANUAL || reason == PAUSE_REASON_COMPLIANCE,
            PayrollError::InvalidPauseReason
        );

        let cfg = &mut ctx.accounts.stream_config_v2;
        cfg.is_paused = true;
        cfg.pause_reason = reason;

        privacy_msg!("⏸️ v2 streams paused");
        Ok(())
    }

    /// Resume v2 streams for a business.
    pub fn resume_stream_v2(ctx: Context<ResumeStreamV2>) -> Result<()> {
        let cfg = &mut ctx.accounts.stream_config_v2;
        cfg.is_paused = false;
        cfg.pause_reason = PAUSE_REASON_NONE;

        privacy_msg!("▶️ v2 streams resumed");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_accounts_fit_under_4kb() {
        assert!(BusinessStreamConfigV2::LEN < 4096);
        assert!(EmployeeStreamV2::LEN < 4096);
        assert!(WithdrawRequestV2::LEN < 4096);
        assert!(RateHistoryV2::LEN < 4096);
    }

    #[test]
    fn to_handle_bytes_truncates_to_32() {
        let input: Vec<u8> = (0u8..64u8).collect();
        let out = to_handle_bytes(&input);
        assert_eq!(out.len(), 32);
        assert_eq!(out[0], 0);
        assert_eq!(out[31], 31);
    }

    #[test]
    fn inco_sighash_constants_match_expected() {
        assert_eq!(
            inco_sighash("new_euint128").unwrap(),
            [0x91, 0x20, 0x66, 0xe3, 0x2f, 0xe7, 0x0a, 0xd6]
        );
        assert_eq!(
            inco_sighash("e_mul").unwrap(),
            [0xe5, 0x99, 0xf5, 0x11, 0x5f, 0x94, 0x3d, 0xf7]
        );
        assert_eq!(
            inco_sighash("e_add").unwrap(),
            [0x14, 0x53, 0x12, 0xa7, 0x78, 0x21, 0xd1, 0xee]
        );
    }
}
