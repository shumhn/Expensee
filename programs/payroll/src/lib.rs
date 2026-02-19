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
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("CgRkrU26uERpZEPXUQ2ANXgPMFHXPrX4bFaM5UHFdPEh");

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
    pub fn register_business(ctx: Context<RegisterBusiness>) -> Result<()> {
        let business = &mut ctx.accounts.business;
        let clock = Clock::get()?;

        business.owner = ctx.accounts.owner.key();
        business.vault = Pubkey::default(); // Set by init_vault
        business.next_employee_index = 0;
        business.is_active = true;
        business.created_at = clock.unix_timestamp;
        business.bump = ctx.bumps.business;
        business.encrypted_employee_count = EncryptedHandle::default();

        msg!("✅ Business registered");
        msg!("   Owner: {}", business.owner);

        emit!(BusinessRegistered {
            business_index: 0,
            timestamp: clock.unix_timestamp,
        });

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

        msg!("✅ Vault initialized");
        msg!("   Vault PDA: {}", vault.key());
        msg!("   Token Account: {}", vault.token_account);

        emit!(VaultInitialized {
            business: business.key(),
            vault: vault.key(),
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

        msg!("✅ Vault token account rotated");
        msg!("   Vault PDA: {}", vault.key());
        msg!("   New Mint: {}", vault.mint);
        msg!("   New Token Account: {}", vault.token_account);

        emit!(VaultTokenAccountRotated {
            business: ctx.accounts.business.key(),
            vault: vault.key(),
            mint: vault.mint,
            token_account: vault.token_account,
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
    pub fn deposit(
        ctx: Context<Deposit>,
        encrypted_amount: Vec<u8>,
    ) -> Result<()> {
        require!(!encrypted_amount.is_empty(), PayrollError::InvalidAmount);
        require!(
            encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::CiphertextTooLarge
        );

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

        msg!("✅ Deposit completed");
        msg!("   Vault: {}", ctx.accounts.vault.key());
        msg!("   Amount: ENCRYPTED");

        emit!(FundsDeposited {
            business: ctx.accounts.business.key(),
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
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            business_key.as_ref(),
            &[bump],
        ]];

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

        msg!("✅ Admin vault withdrawal completed");
        msg!("   Business: {}", business_key);
        msg!("   Amount: ENCRYPTED");

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // EMPLOYEE MANAGEMENT
    // ════════════════════════════════════════════════════════

    /// Add an employee with encrypted salary rate
    ///
    /// Creates an Employee PDA using INDEX-BASED derivation:
    /// Seeds: ["employee", business, employee_index]
    ///
    /// No employee pubkey in seeds = no address correlation!
    pub fn add_employee(
        ctx: Context<AddEmployee>,
        encrypted_employee_id: Vec<u8>,  // Hash of wallet pubkey, encrypted
        encrypted_salary_rate: Vec<u8>,  // Per-second rate, encrypted
    ) -> Result<()> {
        require!(!encrypted_employee_id.is_empty(), PayrollError::InvalidCiphertext);
        require!(!encrypted_salary_rate.is_empty(), PayrollError::InvalidCiphertext);
        require!(
            encrypted_employee_id.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::CiphertextTooLarge
        );
        require!(
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::CiphertextTooLarge
        );

        let business = &mut ctx.accounts.business;
        let employee = &mut ctx.accounts.employee;
        let clock = Clock::get()?;

        // Use next available index (privacy: no pubkey in PDA)
        let employee_index = business.next_employee_index;
        business.next_employee_index += 1;

        employee.business = business.key();
        employee.employee_index = employee_index;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_active = true;
        employee.is_delegated = false;
        employee.bump = ctx.bumps.employee;

        // Store encrypted data as handles
        employee.encrypted_employee_id = EncryptedHandle {
            handle: to_handle_bytes(&encrypted_employee_id)
        };
        employee.encrypted_salary_rate = EncryptedHandle {
            handle: to_handle_bytes(&encrypted_salary_rate)
        };
        employee.encrypted_accrued = EncryptedHandle::default();

        msg!("✅ Employee added (Maximum Privacy)");
        msg!("   Employee Index: {} (no pubkey visible)", employee_index);
        msg!("   Employee ID: ENCRYPTED");
        msg!("   Salary Rate: ENCRYPTED");

        emit!(EmployeeAdded {
            employee_index,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // MAGICBLOCK TEE STREAMING
    // ════════════════════════════════════════════════════════

    /// Delegate employee account to MagicBlock TEE
    ///
    /// Once delegated, the TEE will auto-accrue salary in real-time.
    /// The employee account state is locked on L1 during delegation.
    pub fn delegate_to_tee(ctx: Context<DelegateToTee>) -> Result<()> {
        // Validate before delegation
        require!(ctx.accounts.employee.is_active, PayrollError::InactiveEmployee);
        require!(!ctx.accounts.employee.is_delegated, PayrollError::AlreadyDelegated);

        msg!("⚡ Delegating to MagicBlock TEE...");

        let business_key = ctx.accounts.business.key();
        let employee_index_bytes = ctx.accounts.employee.employee_index.to_le_bytes();

        let seeds: &[&[u8]] = &[
            EMPLOYEE_SEED,
            business_key.as_ref(),
            &employee_index_bytes,
        ];

        let validator_key = ctx.accounts.validator
            .as_ref()
            .map(|v| v.key())
            .or_else(|| Pubkey::try_from(TEE_VALIDATOR).ok());

        ctx.accounts.delegate_employee(
            &ctx.accounts.payer,
            seeds,
            DelegateConfig {
                validator: validator_key,
                ..Default::default()
            },
        )?;

        let validator = validator_key.unwrap_or_default();
        msg!("✅ Delegated to TEE");
        msg!("   Employee Index: {}", ctx.accounts.employee.employee_index);
        msg!("   Validator: {}", validator);

        emit!(DelegatedToTee {
            employee_index: ctx.accounts.employee.employee_index,
            validator,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Mark employee as delegated (called after successful delegation)
    pub fn mark_delegated(ctx: Context<MarkDelegated>) -> Result<()> {
        ctx.accounts.employee.is_delegated = true;
        Ok(())
    }

    /// Accrue salary (called automatically by TEE)
    ///
    /// Computes: accrued += salary_rate * elapsed_seconds
    /// Uses Inco homomorphic operations on encrypted values.
    pub fn accrue(ctx: Context<Accrue>) -> Result<()> {
        let employee = &mut ctx.accounts.employee;
        let clock = Clock::get()?;

        let elapsed = clock.unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;

        if elapsed <= 0 {
            return Ok(());
        }

        msg!("⚡ Accruing salary in TEE...");
        let elapsed_u128 = elapsed as u128;
        let elapsed_ciphertext = elapsed_u128.to_le_bytes().to_vec();
        let signer = ctx.accounts.payer.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        let elapsed_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            elapsed_ciphertext,
            0,
        )?;

        let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
        let current_accrued = handle_to_u128(&employee.encrypted_accrued);

        let delta = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_mul",
            salary_rate,
            elapsed_handle,
            0,
        )?;

        let updated_accrued = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_accrued,
            delta,
            0,
        )?;

        employee.encrypted_accrued = u128_to_handle(updated_accrued);
        employee.last_accrual_time = clock.unix_timestamp;

        msg!("✅ Accrued (PRIVATE)");
        msg!("   Employee Index: {}", employee.employee_index);
        msg!("   Elapsed: {} seconds", elapsed);

        Ok(())
    }

    // ════════════════════════════════════════════════════════
    // WITHDRAWAL INSTRUCTIONS
    // ════════════════════════════════════════════════════════

    /// Auto payment (triggered by TEE on schedule)
    ///
    /// The TEE calls this to:
    /// 1. Commit and undelegate the employee account
    /// 2. Transfer full accrued balance to employee
    pub fn auto_payment(_ctx: Context<AutoPayment>) -> Result<()> {
        err!(PayrollError::DeprecatedInstruction)
    }

    /// Manual withdrawal (employee signs)
    ///
    /// Employee proves identity by signing the transaction.
    pub fn manual_withdraw(_ctx: Context<ManualWithdraw>) -> Result<()> {
        err!(PayrollError::DeprecatedInstruction)
    }

    /// Simple withdrawal (for testing without MagicBlock TEE)
    ///
    /// Transfers a specified encrypted amount from vault to employee.
    /// Does NOT require MagicBlock delegation - useful for devnet testing.
    pub fn simple_withdraw(
        _ctx: Context<SimpleWithdraw>,
        _encrypted_amount: Vec<u8>,
    ) -> Result<()> {
        err!(PayrollError::DeprecatedInstruction)
    }

    /// Undelegate employee from TEE (stop streaming)
    pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
        require!(ctx.accounts.employee.is_delegated, PayrollError::NotDelegated);

        msg!("⚡ Undelegating from TEE...");

        ctx.accounts.employee.exit(&crate::ID)?;
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.employee.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("✅ Undelegated from TEE");
        msg!("   Employee Index: {}", ctx.accounts.employee.employee_index);

        emit!(UndelegatedFromTee {
            employee_index: ctx.accounts.employee.employee_index,
            timestamp: Clock::get()?.unix_timestamp,
        });

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

        msg!("✅ v2 stream config initialized");
        msg!("   Business: {}", cfg.business);
        msg!("   Keeper: {}", cfg.keeper_pubkey);
        msg!("   Settle interval: {}s", cfg.settle_interval_secs);

        Ok(())
    }

    /// Rotate the authorized keeper wallet for v2 stream operations.
    pub fn update_keeper_v2(
        ctx: Context<UpdateKeeperV2>,
        keeper_pubkey: Pubkey,
    ) -> Result<()> {
        require!(keeper_pubkey != Pubkey::default(), PayrollError::InvalidKeeper);

        let cfg = &mut ctx.accounts.stream_config_v2;
        cfg.keeper_pubkey = keeper_pubkey;

        msg!("✅ v2 keeper updated");
        msg!("   Business: {}", cfg.business);
        msg!("   New Keeper: {}", cfg.keeper_pubkey);

        Ok(())
    }

    /// Add a v2 employee stream with fixed payout destination.
    pub fn add_employee_stream_v2(
        ctx: Context<AddEmployeeStreamV2>,
        employee_auth_hash: [u8; 32],
        employee_token_account: Pubkey,
        encrypted_salary_rate: Vec<u8>,
        period_start: i64,
        period_end: i64,
    ) -> Result<()> {
        require!(
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES && !encrypted_salary_rate.is_empty(),
            PayrollError::InvalidCiphertext
        );
        require!(
            employee_auth_hash != [0u8; 32],
            PayrollError::InvalidEmployeeAuthHash
        );
        require!(
            !ctx.accounts.stream_config_v2.is_paused,
            PayrollError::StreamPaused
        );

        let cfg = &mut ctx.accounts.stream_config_v2;
        let stream = &mut ctx.accounts.employee_stream_v2;
        let clock = Clock::get()?;

        let stream_index = cfg.next_stream_index;
        cfg.next_stream_index = cfg
            .next_stream_index
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        stream.business = ctx.accounts.business.key();
        stream.stream_index = stream_index;
        stream.employee_auth_hash = employee_auth_hash;
        stream.employee_token_account = employee_token_account;
        // Register the encrypted salary rate with Inco Lightning and store the returned handle.
        // IMPORTANT: Lightning expects a ciphertext payload here (not a handle).
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.owner.to_account_info();
        let salary_rate_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0, // input_type 0 = hex-encoded ciphertext bytes
        )?;
        stream.encrypted_salary_rate = u128_to_handle(salary_rate_handle);

        // Initialize accrued to an encrypted zero handle (NOT an uninitialized handle=0).
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0)?;
        stream.encrypted_accrued = u128_to_handle(zero_handle);
        stream.last_accrual_time = clock.unix_timestamp;
        stream.last_settle_time = clock.unix_timestamp;
        stream.is_active = true;
        stream.is_delegated = false;
        stream.bump = ctx.bumps.employee_stream_v2;

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

        msg!("✅ v2 employee stream created");
        msg!("   Stream Index: {}", stream.stream_index);
        msg!("   Payout Token Account: {}", stream.employee_token_account);
        msg!("   Salary: ENCRYPTED");
        if period_end != 0 {
            msg!("   Period: {} → {}", period_start, period_end);
        } else {
            msg!("   Period: UNBOUNDED");
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
        // Keep it strict: only the business owner can grant decrypt access (matches handle registration signer).
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            PayrollError::Unauthorized
        );
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

        // Ensure the passed employee wallet matches the auth hash stored in the stream.
        let expected_hash = Sha256::digest(ctx.accounts.employee_wallet.key().to_bytes());
        require!(
            employee.employee_auth_hash == expected_hash[..32],
            PayrollError::InvalidEmployeeSigner
        );

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

        msg!("✅ v2 employee view access granted");
        msg!("   Stream: {}", stream_index);
        msg!("   Employee: {}", allowed);
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
        // Only the business owner can grant decrypt access (matches handle registration signer).
        require_keys_eq!(
            ctx.accounts.caller.key(),
            ctx.accounts.business.owner,
            PayrollError::Unauthorized
        );
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

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

        msg!("✅ v2 keeper view access granted");
        msg!("   Stream: {}", stream_index);
        msg!("   Keeper: {}", allowed);
        Ok(())
    }

    /// Initialize rate history PDA for a v2 stream.
    /// This enables "selective disclosure" payslips without revealing all history publicly.
    ///
    /// NOTE: This requires the stream to be owned by this program (not delegated) so we can read it.
    pub fn init_rate_history_v2(
        ctx: Context<InitRateHistoryV2>,
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

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

        msg!("✅ v2 rate history initialized");
        msg!("   Stream: {}", stream_index);
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
            encrypted_salary_rate.len() <= MAX_CIPHERTEXT_BYTES && !encrypted_salary_rate.is_empty(),
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // Accrue up to now using the old rate to avoid losing earnings across a rate change.
        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        if elapsed > 0 {
            let elapsed_handle = inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128)?;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);
            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed_handle,
                0,
            )?;
            let updated_accrued = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_add",
                current_accrued,
                delta,
                0,
            )?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        // Register new encrypted salary rate and store handle.
        let new_rate_handle = inco_new_euint128(
            &signer,
            &inco_lightning_program,
            encrypted_salary_rate,
            0,
        )?;
        employee.encrypted_salary_rate = u128_to_handle(new_rate_handle);
        employee.last_accrual_time = clock.unix_timestamp;

        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        // Append to rate history for selective disclosure payslips.
        let history = &mut ctx.accounts.rate_history_v2;
        require!(history.business == business_key, PayrollError::InvalidRateHistory);
        require!(history.stream_index == stream_index, PayrollError::InvalidRateHistory);
        let idx = history.count as usize;
        require!(idx < RATE_HISTORY_MAX_ENTRIES, PayrollError::RateHistoryFull);
        history.entries[idx] = RateHistoryEntryV2 {
            effective_at: clock.unix_timestamp,
            encrypted_salary_rate: employee.encrypted_salary_rate.clone(),
        };
        history.count = history
            .count
            .checked_add(1)
            .ok_or(PayrollError::InvalidAmount)?;

        msg!("✅ v2 salary rate updated (encrypted)");
        msg!("   Stream: {}", stream_index);
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

        let clock = Clock::get()?;
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // Accrue up to now first so the bonus is additive on top of current earned amount.
        let elapsed = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        if elapsed > 0 {
            let elapsed_handle = inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128)?;
            let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
            let current_accrued = handle_to_u128(&employee.encrypted_accrued);
            let delta = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_mul",
                salary_rate,
                elapsed_handle,
                0,
            )?;
            let updated_accrued = inco_binary_op_u128(
                &signer,
                &inco_lightning_program,
                "e_add",
                current_accrued,
                delta,
                0,
            )?;
            employee.encrypted_accrued = u128_to_handle(updated_accrued);
        }

        let bonus_handle = inco_new_euint128(&signer, &inco_lightning_program, encrypted_bonus, 0)?;
        let current_accrued = handle_to_u128(&employee.encrypted_accrued);
        let updated_accrued = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_accrued,
            bonus_handle,
            0,
        )?;
        employee.encrypted_accrued = u128_to_handle(updated_accrued);
        employee.last_accrual_time = clock.unix_timestamp;

        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        msg!("✅ v2 bonus granted (encrypted)");
        msg!("   Stream: {}", stream_index);
        Ok(())
    }

    /// Delegate v2 stream account to MagicBlock TEE.
    pub fn delegate_stream_v2(
        ctx: Context<DelegateStreamV2>,
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
        // If the account is already delegated on the base layer, its owner will be the delegation program.
        // In that case we cannot delegate it again.
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::AlreadyDelegated
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee.to_account_info())?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();

        let seeds: &[&[u8]] = &[
            EMPLOYEE_V2_SEED,
            business_key.as_ref(),
            &stream_index_bytes,
        ];

        let validator_key = ctx.accounts.validator
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
        msg!("✅ v2 stream delegated to TEE");
        msg!("   Stream Index: {}", stream_index);

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
        require!(ctx.accounts.employee.is_active, PayrollError::InactiveEmployee);
        require!(
            ctx.accounts.employee.stream_index == stream_index,
            PayrollError::InvalidStreamIndex
        );

        let employee = &mut ctx.accounts.employee;
        let clock = Clock::get()?;

        // Clamp effective time at period_end for bounded streams.
        let effective_now = if employee.period_end > 0 && clock.unix_timestamp > employee.period_end {
            employee.period_end
        } else {
            clock.unix_timestamp
        };

        let elapsed = effective_now
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;

        if elapsed <= 0 {
            // Nothing left to accrue. For bounded streams this means period end has been reached.
            // Keep stream active so withdraw/redelegate flows remain valid; accrual stays clipped by period_end.
            return Ok(());
        }

        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();

        // elapsed is public, so use trivial encryption (deterministic) rather than client ciphertext.
        let elapsed_handle = inco_as_euint128(&signer, &inco_lightning_program, elapsed as u128)?;

        let salary_rate = handle_to_u128(&employee.encrypted_salary_rate);
        let current_accrued = handle_to_u128(&employee.encrypted_accrued);

        let delta = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_mul",
            salary_rate,
            elapsed_handle,
            0,
        )?;

        let updated_accrued = inco_binary_op_u128(
            &signer,
            &inco_lightning_program,
            "e_add",
            current_accrued,
            delta,
            0,
        )?;

        employee.encrypted_accrued = u128_to_handle(updated_accrued);
        employee.last_accrual_time = effective_now;

        msg!("✅ v2 accrued");
        msg!("   Stream: {}", stream_index);
        msg!("   Delta: ENCRYPTED");
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

        msg!("✅ v2 commit+undelegate scheduled");
        msg!("   Stream: {}", stream_index);
        Ok(())
    }

    /// Auto-settle v2 stream to fixed employee token account.
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
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);
        require!(
            ctx.accounts.employee_token_account.key() == employee.employee_token_account,
            PayrollError::InvalidPayoutDestination
        );

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
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            business_key.as_ref(),
            &[bump],
        ]];

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
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_stream_v2(&ctx.accounts.employee, &employee)?;

        msg!("✅ v2 auto-settle completed");
        msg!("   Stream: {}", stream_index);
        msg!("   Amount: ENCRYPTED");
        Ok(())
    }

    /// Re-delegate v2 stream after settlement.
    pub fn redelegate_stream_v2(
        ctx: Context<RedelegateStreamV2>,
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
        require!(
            ctx.accounts.employee.owner == &crate::ID,
            PayrollError::AlreadyDelegated
        );

        let employee = load_employee_stream_v2(&ctx.accounts.employee.to_account_info())?;
        require!(employee.is_active, PayrollError::InactiveEmployee);
        require!(employee.stream_index == stream_index, PayrollError::InvalidStreamIndex);

        let business_key = ctx.accounts.business.key();
        let stream_index_bytes = stream_index.to_le_bytes();

        let seeds: &[&[u8]] = &[
            EMPLOYEE_V2_SEED,
            business_key.as_ref(),
            &stream_index_bytes,
        ];

        let validator_key = ctx.accounts.validator
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
        msg!("✅ v2 stream re-delegated");
        msg!("   Stream: {}", stream_index);
        Ok(())
    }

    /// Employee requests a v2 withdrawal (withdraw-all).
    ///
    /// This does not transfer funds immediately. A keeper processes the request
    /// and settles to the registered destination token account.
    pub fn request_withdraw_v2(
        ctx: Context<RequestWithdrawV2>,
        stream_index: u64,
    ) -> Result<()> {
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

        // Authenticate requester via employee auth hash.
        let requester = ctx.accounts.employee_signer.key();
        let digest: [u8; 32] = Sha256::digest(requester.as_ref()).into();
        require!(
            digest == employee.employee_auth_hash,
            PayrollError::InvalidEmployeeSigner
        );

        let clock = Clock::get()?;
        let req = &mut ctx.accounts.withdraw_request_v2;
        req.business = business_key;
        req.stream_index = stream_index;
        req.requester = requester;
        req.requested_at = clock.unix_timestamp;
        req.is_pending = true;
        req.bump = ctx.bumps.withdraw_request_v2;

        msg!("✅ v2 withdraw requested");
        msg!("   Stream: {}", stream_index);
        Ok(())
    }

    /// Keeper processes a pending v2 withdrawal request (withdraw-all).
    ///
    /// Preconditions:
    /// - Stream must not be delegated (keeper should commit+undelegate first).
    /// - Keeper should checkpoint accrual via `accrue_v2` before settling.
    pub fn process_withdraw_request_v2(
        ctx: Context<ProcessWithdrawRequestV2>,
        stream_index: u64,
        encrypted_amount: Vec<u8>,
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

        // Ensure the withdraw request is from the correct employee wallet.
        let requester = ctx.accounts.withdraw_request_v2.requester;
        let digest: [u8; 32] = Sha256::digest(requester.as_ref()).into();
        require!(
            digest == employee.employee_auth_hash,
            PayrollError::InvalidWithdrawRequester
        );

        require!(
            ctx.accounts.employee_token_account.key() == employee.employee_token_account,
            PayrollError::InvalidPayoutDestination
        );

        let clock = Clock::get()?;

        // Freshness guard: accrual must have happened within 30 seconds.
        // This forces the keeper to call accrue_v2 immediately before settling,
        // ensuring the on-chain accrued state is current and the payout is based
        // on the latest checkpoint — not a stale or manipulated value.
        let accrual_age = clock
            .unix_timestamp
            .checked_sub(employee.last_accrual_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            accrual_age <= 30,
            PayrollError::AccrualNotFresh
        );

        // Anti-spam cadence guard (shared config).
        let elapsed_since_settle = clock
            .unix_timestamp
            .checked_sub(employee.last_settle_time)
            .ok_or(PayrollError::InvalidTimestamp)?;
        require!(
            elapsed_since_settle as u64 >= ctx.accounts.stream_config_v2.settle_interval_secs,
            PayrollError::SettleTooSoon
        );

        require!(
            !encrypted_amount.is_empty() && encrypted_amount.len() <= MAX_CIPHERTEXT_BYTES,
            PayrollError::InvalidCiphertext
        );

        // Vault authority signer seeds.
        let bump = ctx.accounts.vault.bump;
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            business_key.as_ref(),
            &[bump],
        ]];

        let transfer_ix = build_inco_transfer_ix(
            ctx.accounts.vault_token_account.key(),
            ctx.accounts.employee_token_account.key(),
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
                ctx.accounts.employee_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.inco_lightning_program.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            seeds,
        )?;

        // Capture accrued handle BEFORE reset — this is the value the payout was based on.
        let accrued_handle_at_settle = handle_to_u128(&employee.encrypted_accrued);

        // Reset stream accrued state and timestamps.
        // Reset accrued to encrypted zero (NOT handle=0).
        let signer = ctx.accounts.caller.to_account_info();
        let inco_lightning_program = ctx.accounts.inco_lightning_program.to_account_info();
        let zero_handle = inco_as_euint128(&signer, &inco_lightning_program, 0)?;
        employee.encrypted_accrued = u128_to_handle(zero_handle);
        employee.last_settle_time = clock.unix_timestamp;
        employee.last_accrual_time = clock.unix_timestamp;
        employee.is_delegated = false;
        save_employee_stream_v2(&ctx.accounts.employee_stream, &employee)?;

        // Clear request.
        ctx.accounts.withdraw_request_v2.is_pending = false;

        // Audit event: log the accrued handle that was on-chain at settle time.
        // Any auditor can later decrypt this handle and verify the payout matched.
        emit!(WithdrawSettled {
            stream_index,
            accrued_handle: accrued_handle_at_settle,
            timestamp: clock.unix_timestamp,
        });

        msg!("✅ v2 withdraw processed");
        msg!("   Stream: {}", stream_index);
        msg!("   Amount: ENCRYPTED (audit handle logged)");
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

        msg!("⏸️ v2 streams paused");
        msg!("   Reason: {}", reason);
        Ok(())
    }

    /// Resume v2 streams for a business.
    pub fn resume_stream_v2(ctx: Context<ResumeStreamV2>) -> Result<()> {
        let cfg = &mut ctx.accounts.stream_config_v2;
        cfg.is_paused = false;
        cfg.pause_reason = PAUSE_REASON_NONE;

        msg!("▶️ v2 streams resumed");
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
