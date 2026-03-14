use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
};

use crate::constants::*;
use crate::errors::PayrollError;
use crate::state::EncryptedHandle;
use crate::state::{EmployeeEntryV3, EmployeeEntryV4, EmployeeStreamV2};

// ============================================================
// Handle Conversion Helpers
// ============================================================

/// Convert a variable-length ciphertext to a fixed 32-byte handle
pub fn to_handle_bytes(data: &[u8]) -> [u8; 32] {
    let mut handle = [0u8; 32];
    let len = data.len().min(32);
    handle[..len].copy_from_slice(&data[..len]);
    handle
}

pub fn handle_to_u128(handle: &EncryptedHandle) -> u128 {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&handle.handle[..16]);
    u128::from_le_bytes(bytes)
}

pub fn u128_to_handle(value: u128) -> EncryptedHandle {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&value.to_le_bytes());
    EncryptedHandle { handle: out }
}

pub fn is_handle_zero(handle: &EncryptedHandle) -> bool {
    handle.handle.iter().all(|b| *b == 0)
}

// ============================================================
// Employee Stream V2 Serialization
// ============================================================

pub fn load_employee_stream_v2(account: &AccountInfo<'_>) -> Result<EmployeeStreamV2> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    EmployeeStreamV2::try_deserialize(&mut slice).map_err(Into::into)
}

pub fn save_employee_stream_v2(
    account: &AccountInfo<'_>,
    employee: &EmployeeStreamV2,
) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut dst: &mut [u8] = &mut data;
    employee.try_serialize(&mut dst)?;
    Ok(())
}

// ============================================================
// Employee Entry V3 Serialization
// ============================================================

pub fn load_employee_entry_v3(account: &AccountInfo<'_>) -> Result<EmployeeEntryV3> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    EmployeeEntryV3::try_deserialize(&mut slice).map_err(Into::into)
}

pub fn save_employee_entry_v3(
    account: &AccountInfo<'_>,
    employee: &EmployeeEntryV3,
) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut dst: &mut [u8] = &mut data;
    employee.try_serialize(&mut dst)?;
    Ok(())
}

// ============================================================
// Employee Entry V4 Serialization
// ============================================================

pub fn load_employee_entry_v4(account: &AccountInfo<'_>) -> Result<EmployeeEntryV4> {
    let data = account.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    EmployeeEntryV4::try_deserialize(&mut slice).map_err(Into::into)
}

pub fn save_employee_entry_v4(
    account: &AccountInfo<'_>,
    employee: &EmployeeEntryV4,
) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut dst: &mut [u8] = &mut data;
    employee.try_serialize(&mut dst)?;
    Ok(())
}

// ============================================================
// Inco Lightning CPI Helpers
// ============================================================

pub fn inco_sighash(name: &str) -> Result<[u8; 8]> {
    match name {
        "new_euint128" => Ok([0x91, 0x20, 0x66, 0xe3, 0x2f, 0xe7, 0x0a, 0xd6]),
        "as_euint128" => Ok([0x56, 0x3d, 0x17, 0xad, 0xbb, 0x02, 0xf7, 0x60]),
        "e_mul" => Ok([0xe5, 0x99, 0xf5, 0x11, 0x5f, 0x94, 0x3d, 0xf7]),
        "e_add" => Ok([0x14, 0x53, 0x12, 0xa7, 0x78, 0x21, 0xd1, 0xee]),
        "e_sub" => Ok([0xbb, 0x0b, 0x91, 0x1e, 0x32, 0x36, 0x3a, 0xe4]),
        _ => Err(PayrollError::InvalidCiphertext.into()),
    }
}

pub fn read_inco_u128_return() -> Result<u128> {
    let (program_id, return_data) = get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    require_keys_eq!(program_id, INCO_LIGHTNING_ID, PayrollError::InvalidCiphertext);
    if return_data.len() < 16 {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&return_data[..16]);
    Ok(u128::from_le_bytes(out))
}

pub fn inco_new_euint128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    ciphertext: Vec<u8>,
    input_type: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    require!(
        !ciphertext.is_empty() && ciphertext.len() <= MAX_CIPHERTEXT_BYTES,
        PayrollError::CiphertextTooLarge
    );

    let mut data = Vec::with_capacity(8 + 4 + ciphertext.len() + 1);
    data.extend_from_slice(&inco_sighash("new_euint128")?);
    data.extend_from_slice(&(ciphertext.len() as u32).to_le_bytes());
    data.extend_from_slice(&ciphertext);
    data.push(input_type);

    let ix = Instruction {
        program_id: INCO_LIGHTNING_ID,
        accounts: vec![AccountMeta::new(signer.key(), true)],
        data,
    };

    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &[signer.clone(), inco_lightning_program.clone()], seeds)?,
        None => invoke(&ix, &[signer.clone(), inco_lightning_program.clone()])?,
    }
    read_inco_u128_return()
}

pub fn inco_as_euint128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    value: u128,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    let mut data = Vec::with_capacity(8 + 16);
    data.extend_from_slice(&inco_sighash("as_euint128")?);
    data.extend_from_slice(&value.to_le_bytes());

    let ix = Instruction {
        program_id: INCO_LIGHTNING_ID,
        accounts: vec![AccountMeta::new(signer.key(), true)],
        data,
    };

    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &[signer.clone(), inco_lightning_program.clone()], seeds)?,
        None => invoke(&ix, &[signer.clone(), inco_lightning_program.clone()])?,
    }
    read_inco_u128_return()
}

pub fn inco_binary_op_u128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    op_name: &str,
    lhs: u128,
    rhs: u128,
    scalar_byte: u8,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    let mut data = Vec::with_capacity(8 + 16 + 16 + 1);
    data.extend_from_slice(&inco_sighash(op_name)?);
    data.extend_from_slice(&lhs.to_le_bytes());
    data.extend_from_slice(&rhs.to_le_bytes());
    data.push(scalar_byte);

    let ix = Instruction {
        program_id: INCO_LIGHTNING_ID,
        accounts: vec![AccountMeta::new(signer.key(), true)],
        data,
    };

    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, &[signer.clone(), inco_lightning_program.clone()], seeds)?,
        None => invoke(&ix, &[signer.clone(), inco_lightning_program.clone()])?,
    }
    read_inco_u128_return()
}

pub fn inco_add_u128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    lhs: u128,
    rhs: u128,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    inco_binary_op_u128(signer, inco_lightning_program, "e_add", lhs, rhs, 0, signer_seeds)
}

pub fn inco_sub_u128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    lhs: u128,
    rhs: u128,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    inco_binary_op_u128(signer, inco_lightning_program, "e_sub", lhs, rhs, 0, signer_seeds)
}

pub fn inco_mul_u128<'info>(
    signer: &AccountInfo<'info>,
    inco_lightning_program: &AccountInfo<'info>,
    lhs: u128,
    rhs: u128,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<u128> {
    inco_binary_op_u128(signer, inco_lightning_program, "e_mul", lhs, rhs, 0, signer_seeds)
}

// ============================================================
// Authorization
// ============================================================

pub fn authorize_keeper_or_owner(caller: Pubkey, owner: Pubkey, keeper: Pubkey) -> Result<()> {
    require!(
        caller == owner || caller == keeper,
        PayrollError::UnauthorizedKeeper
    );
    Ok(())
}

pub fn authorize_keeper_only(caller: Pubkey, keeper: Pubkey) -> Result<()> {
    require!(caller == keeper, PayrollError::UnauthorizedKeeper);
    Ok(())
}

pub fn authorize_keeper_or_master(
    caller: Pubkey,
    master_authority: Pubkey,
    keeper: Pubkey,
) -> Result<()> {
    require!(
        caller == master_authority || caller == keeper,
        PayrollError::UnauthorizedKeeper
    );
    Ok(())
}

// ============================================================
// Inco Token Transfer Builder
// ============================================================

/// Build Inco Token transfer instruction
pub fn build_inco_transfer_ix(
    source: Pubkey,
    destination: Pubkey,
    authority: Pubkey,
    inco_lightning: Pubkey,
    system_program: Pubkey,
    encrypted_amount: Vec<u8>,
    input_type: u8,
) -> Instruction {
    // Inco Token transfer discriminator: sha256("global:transfer")[0..8]
    let mut data = vec![0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba];
    // Serialize encrypted_amount as Vec<u8> (4-byte length + data)
    data.extend_from_slice(&(encrypted_amount.len() as u32).to_le_bytes());
    data.extend_from_slice(&encrypted_amount);
    // Serialize input_type as u8
    data.push(input_type);

    Instruction {
        program_id: INCO_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(source, false),           // source
            AccountMeta::new(destination, false),      // destination
            AccountMeta::new(authority, true),         // authority (signer, mutable)
            AccountMeta::new_readonly(inco_lightning, false), // inco_lightning_program
            AccountMeta::new_readonly(system_program, false), // system_program
        ],
        data,
    }
}

/// Build Inco Lightning allow instruction.
///
/// This grants/revokes decryption permission for a given handle to an allowed address.
pub fn build_inco_allow_ix(
    allowance_account: Pubkey,
    signer: Pubkey,
    allowed_address: Pubkey,
    system_program: Pubkey,
    handle: u128,
    value: bool,
) -> Instruction {
    // Inco Lightning allow discriminator: sha256("global:allow")[0..8]
    let discriminator: [u8; 8] = [60, 103, 140, 65, 110, 109, 147, 164];

    let mut data = Vec::with_capacity(8 + 16 + 1 + 32);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&handle.to_le_bytes());
    data.push(if value { 1 } else { 0 });
    data.extend_from_slice(&allowed_address.to_bytes());

    Instruction {
        program_id: INCO_LIGHTNING_ID,
        accounts: vec![
            AccountMeta::new(allowance_account, false),
            AccountMeta::new(signer, true),
            AccountMeta::new_readonly(allowed_address, false),
            AccountMeta::new_readonly(system_program, false),
        ],
        data,
    }
}
