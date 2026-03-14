#!/usr/bin/env node

/**
 * Create a v4 withdraw request (and Inco allowance if missing).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envString(name, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function envPublicKey(name, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return new PublicKey(value);
}

function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const INCO_ALLOW_DISCRIMINATOR = Buffer.from([60, 103, 140, 65, 110, 109, 147, 164]);

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function u128FromBytesLE(bytes) {
  let value = 0n;
  const len = Math.min(bytes.length, 16);
  for (let i = 0; i < len; i += 1) {
    value |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return value;
}

function loadKeypairFromPath(keypairPath) {
  const raw = fs.readFileSync(expandHome(keypairPath), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function deriveMasterVaultV4Pda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('master_vault_v4b')], programId)[0];
}

function deriveBusinessV4Pda(masterVault, businessIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('business_v4'), masterVault.toBuffer(), u64LE(businessIndex)],
    programId
  )[0];
}

function deriveEmployeeV4Pda(business, employeeIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('employee_v4'), business.toBuffer(), u64LE(employeeIndex)],
    programId
  )[0];
}

function deriveStreamConfigV4Pda(business, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('stream_config_v4'), business.toBuffer()], programId)[0];
}

function deriveWithdrawRequestV4Pda(business, employeeIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('withdraw_request_v4'), business.toBuffer(), u64LE(employeeIndex)],
    programId
  )[0];
}

function deriveAllowancePda(handleU128, allowed, incoLightningId) {
  const handleBuf = Buffer.alloc(16);
  let h = BigInt(handleU128);
  for (let i = 0; i < 16; i += 1) {
    handleBuf[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  return PublicKey.findProgramAddressSync([handleBuf, allowed.toBuffer()], incoLightningId)[0];
}

async function sendIx(connection, payer, instruction, extraSigners = [], label = 'tx') {
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`${label}: ${sig}`);
  return sig;
}

function parseEmployeeV4(data) {
  if (!data || data.length < 80) return null;
  return {
    encryptedEmployeeIdHandle: data.subarray(48, 80),
  };
}

async function main() {
  const rpcUrl = envString('RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  const programId = envPublicKey('PAYROLL_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const incoLightningId = envPublicKey('INCO_LIGHTNING_ID', process.env.NEXT_PUBLIC_INCO_PROGRAM_ID);
  const employeeKeypairPath = envString(
    'EMPLOYEE_KEYPAIR_PATH',
    path.join(__dirname, '..', '..', 'services', 'keeper', 'demo-employee-keypair.json')
  );

  const repoRoot = path.resolve(__dirname, '..', '..');
  const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

  const businessIndex = Number(process.env.BUSINESS_INDEX || state.businessIndex || 0);
  const employeeIndex = Number(process.env.EMPLOYEE_INDEX || state.employeeIndex || 0);
  if (!Number.isFinite(businessIndex) || !Number.isFinite(employeeIndex)) {
    throw new Error('BUSINESS_INDEX and EMPLOYEE_INDEX must be numbers');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const employee = loadKeypairFromPath(employeeKeypairPath);

  const masterVault = deriveMasterVaultV4Pda(programId);
  const businessPda = deriveBusinessV4Pda(masterVault, businessIndex, programId);
  const employeePda = deriveEmployeeV4Pda(businessPda, employeeIndex, programId);
  const streamConfigPda = deriveStreamConfigV4Pda(businessPda, programId);
  const withdrawRequestPda = deriveWithdrawRequestV4Pda(businessPda, employeeIndex, programId);

  const employeeInfo = await connection.getAccountInfo(employeePda, 'confirmed');
  if (!employeeInfo) throw new Error('Employee v4 account not found');
  const employeeParsed = parseEmployeeV4(employeeInfo.data);
  if (!employeeParsed) throw new Error('Unable to parse employee v4 data');

  const handleU128 = u128FromBytesLE(employeeParsed.encryptedEmployeeIdHandle.subarray(0, 16));
  const allowancePda = deriveAllowancePda(handleU128, employee.publicKey, incoLightningId);
  const allowanceInfo = await connection.getAccountInfo(allowancePda, 'confirmed');
  if (!allowanceInfo) {
    const handleBuf = Buffer.alloc(16);
    let h = BigInt(handleU128);
    for (let i = 0; i < 16; i += 1) {
      handleBuf[i] = Number(h & 0xffn);
      h >>= 8n;
    }
    const allowIx = new TransactionInstruction({
      programId: incoLightningId,
      keys: [
        { pubkey: allowancePda, isSigner: false, isWritable: true },
        { pubkey: employee.publicKey, isSigner: true, isWritable: true },
        { pubkey: employee.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        INCO_ALLOW_DISCRIMINATOR,
        handleBuf,
        Buffer.from([1]),
        employee.publicKey.toBuffer(),
      ]),
    });
    await sendIx(connection, employee, allowIx, [], 'inco_allow_employee_id');
  } else {
    console.log('allowance: already exists');
  }

  const requestIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: false },
      { pubkey: employeePda, isSigner: false, isWritable: false },
      { pubkey: allowancePda, isSigner: false, isWritable: false },
      { pubkey: withdrawRequestPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('request_withdraw_v4'), u64LE(employeeIndex)]),
  });
  await sendIx(connection, employee, requestIx, [], 'request_withdraw_v4');
}

main().catch((err) => {
  console.error('v4-request-withdraw failed:', err);
  process.exit(1);
});
