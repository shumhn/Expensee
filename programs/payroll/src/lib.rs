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

// MagicBlock Ephemeral Rollups SDK
use ephemeral_rollups_sdk::anchor::ephemeral;
use anchor_lang::solana_program::instruction::AccountMeta;
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

fn magicblock_delegation_program() -> Pubkey {
    Pubkey::try_from(MAGICBLOCK_DELEGATION_PROGRAM).unwrap_or(Pubkey::default())
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
        deposit_authority: Pubkey,
    ) -> Result<()> {
        require!(
            !encrypted_employer_id.is_empty() && encrypted_employer_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );
        require!(deposit_authority != Pubkey::default(), PayrollError::Unauthorized);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            deposit_authority,
            PayrollError::Unauthorized
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
        business.deposit_authority = deposit_authority;

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

    /// Initialize v4 stream config (withdrawal cooldown).
    pub fn init_stream_config_v4(
        ctx: Context<InitStreamConfigV4>,
        settle_interval_secs: u64,
    ) -> Result<()> {
        require!(
            settle_interval_secs >= MIN_SETTLE_INTERVAL_SECS,
            PayrollError::InvalidSettleInterval
        );

        let master = &ctx.accounts.master_vault_v4;
        require!(master.is_active, PayrollError::Unauthorized);
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.business_v4.deposit_authority,
            PayrollError::Unauthorized
        );

        let config = &mut ctx.accounts.stream_config_v4;
        config.business = ctx.accounts.business_v4.key();
        config.reserved_authority = [0u8; 32];
        config.settle_interval_secs = settle_interval_secs;
        config.is_paused = false;
        config.pause_reason = PAUSE_REASON_NONE;
        config.bump = ctx.bumps.stream_config_v4;

        privacy_msg!("✅ v4 stream config initialized");
        Ok(())
    }

    /// Add a v4 employee (pooled vault ledger) with private solvency check.
    ///
    /// The `required_deposit_amount` parameter specifies the minimum balance the
    /// business vault must hold (e.g. salary × contract duration). The check is
    /// performed entirely on encrypted values using Inco Lightning's `e_ge` and
    /// `e_select` — the actual balance is never revealed.
    ///
    /// If `balance >= required`: the employee is created with the requested salary.
    /// If `balance < required`:  the employee is created but salary is set to 0
    ///                           (effectively a no-op stream until more funds arrive).
    ///
    /// The encrypted boolean result (ebool handle) is returned via `set_return_data`
    /// so the frontend can optionally decrypt it for UI feedback.
    pub fn add_employee_v4(
        ctx: Context<AddEmployeeV4>,
        employee_index: u64,
        encrypted_employee_id: Vec<u8>,
        encrypted_salary_rate: Vec<u8>,
        period_start: i64,
        period_end: i64,
        required_deposit_amount: u64,
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
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.business_v4.deposit_authority,
            PayrollError::Unauthorized
        );

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

        // Register the requested salary as an encrypted handle.
        let salary_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0, None)?;

        // ── Private solvency check (Inco Lightning FHE) ──────────────
        // 1. Encrypt the required deposit amount as a euint128.
        let required_handle = inco_as_euint128(
            &signer,
            &inco_lightning_program,
            required_deposit_amount as u128,
            None,
        )?;

        // 2. Compare: is_solvent = e_ge(business.encrypted_balance, required)
        let balance_handle = handle_to_u128(&business.encrypted_balance);
        let is_solvent = inco_e_ge(
            &signer,
            &inco_lightning_program,
            balance_handle,
            required_handle,
            None,
        )?;

        // 3. Gate: final_salary = e_select(is_solvent, salary, 0)
        //    If solvent → use the requested salary.
        //    If insolvent → salary becomes encrypted 0 (no-op stream).
        let zero_salary = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        let final_salary = inco_e_select(
            &signer,
            &inco_lightning_program,
            is_solvent,
            salary_handle,
            zero_salary,
            None,
        )?;
        employee.encrypted_salary_rate = u128_to_handle(final_salary);
        // ── End solvency check ───────────────────────────────────────

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

        // Return the encrypted boolean handle so the UI can decrypt for feedback.
        anchor_lang::solana_program::program::set_return_data(&is_solvent.to_le_bytes());

        privacy_msg!("✅ v4 employee added (solvency-gated)");
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

    /// Update v4 salary rate privately (encrypted) with solvency check.
    ///
    /// For safety and simplicity on devnet demos, this requires the stream to be undelegated
    /// (owned by this program). If delegated, undelegate first and retry.
    ///
    /// The `required_deposit_amount` is the minimum balance the business vault must hold
    /// for the new rate to take effect. If insolvent, the new rate is set to encrypted 0.
    pub fn update_salary_rate_v4(
        ctx: Context<UpdateSalaryRateV4>,
        employee_index: u64,
        encrypted_salary_rate: Vec<u8>,
        required_deposit_amount: u64,
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

        // Register new encrypted salary rate handle.
        let new_rate_handle =
            inco_new_euint128(&signer, &inco_lightning_program, encrypted_salary_rate, 0, None)?;

        // ── Private solvency check (Inco Lightning FHE) ──────────────
        let required_handle = inco_as_euint128(
            &signer, &inco_lightning_program,
            required_deposit_amount as u128, None,
        )?;
        let balance_handle = handle_to_u128(&ctx.accounts.business_v4.encrypted_balance);
        let is_solvent = inco_e_ge(
            &signer, &inco_lightning_program,
            balance_handle, required_handle, None,
        )?;
        let zero_rate = inco_as_euint128(&signer, &inco_lightning_program, 0, None)?;
        let final_rate = inco_e_select(
            &signer, &inco_lightning_program,
            is_solvent, new_rate_handle, zero_rate, None,
        )?;
        employee.encrypted_salary_rate = u128_to_handle(final_rate);
        // ── End solvency check ───────────────────────────────────────

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

        // Return the encrypted solvency boolean for optional UI feedback.
        anchor_lang::solana_program::program::set_return_data(&is_solvent.to_le_bytes());

        privacy_msg!("✅ v4 salary rate updated (solvency-gated)");
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
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.business_v4.deposit_authority,
            PayrollError::Unauthorized
        );
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
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.business_v4.deposit_authority,
            PayrollError::Unauthorized
        );
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
        let permission_owner = *permission_info.owner;
        require!(
            permission_owner == magicblock_permission_program() || permission_owner == magicblock_delegation_program(),
            PayrollError::InvalidPermissionAccount
        );

        // On ER, delegated accounts can appear owned by the original program.
        // Do not gate commit/undelegate scheduling on AccountInfo.owner.
        
        privacy_msg!("🚀 Scheduling employee commit+undelegate...");
        ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder::new(
            ctx.accounts.caller.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.employee_v4.to_account_info()])
        .build_and_invoke()?;

        let employee_signer_seeds: &[&[u8]] = &[
            EMPLOYEE_V4_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
            &[employee_bump],
        ];
        
        privacy_msg!("🚀 Scheduling permission commit+undelegate...");
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

        // Per MagicBlock docs: only pass payer + the delegated target account to ScheduleTask CPI
        let schedule_ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
            crate::constants::MAGIC_PROGRAM_ID,
            &ix_data,
            vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.employee_stream.key(), false),
            ],
        );

        invoke_signed(
            &schedule_ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.employee_stream.to_account_info(),
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

    /// Keeper or employee processes a pending v4 withdrawal request (pooled vault).
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

        let caller = ctx.accounts.payer.key();
        let auth_handle_u128 = handle_to_u128(&employee.encrypted_employee_id);
        let mut handle_buf = [0u8; 16];
        handle_buf.copy_from_slice(&auth_handle_u128.to_le_bytes());
        let (expected_allowance, _) = Pubkey::find_program_address(
            &[&handle_buf, caller.as_ref()],
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v4_accounts_fit_under_4kb() {
        assert!(MasterVaultV4::LEN < 4096);
        assert!(BusinessEntryV4::LEN < 4096);
        assert!(EmployeeEntryV4::LEN < 4096);
        assert!(BusinessStreamConfigV4::LEN < 4096);
        assert!(WithdrawRequestV4::LEN < 4096);
        assert!(ShieldedPayoutV4::LEN < 4096);
        assert!(RateHistoryV4::LEN < 4096);
        assert!(UserTokenAccountV4::LEN < 4096);
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

