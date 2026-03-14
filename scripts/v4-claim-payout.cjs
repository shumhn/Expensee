#!/usr/bin/env node

/**
 * Claim a v4 shielded payout by nonce.
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

function deriveUserTokenV4Pda(owner, mint, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_token_v4'), owner.toBuffer(), mint.toBuffer()],
    programId
  )[0];
}

function deriveShieldedPayoutV4Pda(business, employeeIndex, nonce, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_payout_v4'), business.toBuffer(), u64LE(employeeIndex), u64LE(nonce)],
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

function parseShieldedPayoutV4(data) {
  if (!data || data.length < 170) return null;
  return {
    employeeAuthHandle: data.subarray(56, 88),
    payoutTokenAccount: new PublicKey(data.subarray(138, 170)),
  };
}

function parseUserTokenV4(data) {
  if (!data || data.length < 145) return null;
  return {
    owner: new PublicKey(data.subarray(8, 40)),
    mint: new PublicKey(data.subarray(40, 72)),
    incoTokenAccount: new PublicKey(data.subarray(72, 104)),
  };
}

async function main() {
  const rpcUrl = envString('RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  const programId = envPublicKey('PAYROLL_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const incoLightningId = envPublicKey('INCO_LIGHTNING_ID', process.env.NEXT_PUBLIC_INCO_PROGRAM_ID);
  const incoTokenProgramId = envPublicKey('INCO_TOKEN_PROGRAM_ID', process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID);
  const mint = envPublicKey('PAYUSD_MINT', process.env.NEXT_PUBLIC_PAYUSD_MINT);
  const employeeKeypairPath = envString(
    'EMPLOYEE_KEYPAIR_PATH',
    path.join(__dirname, '..', '..', 'services', 'keeper', 'demo-employee-keypair.json')
  );

  const repoRoot = path.resolve(__dirname, '..', '..');
  const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

  const businessIndex = Number(process.env.BUSINESS_INDEX || state.businessIndex || 0);
  const employeeIndex = Number(process.env.EMPLOYEE_INDEX || state.employeeIndex || 0);
  const nonce = Number(process.env.PAYOUT_NONCE || state.payoutNonce || 0);
  if (!Number.isFinite(businessIndex) || !Number.isFinite(employeeIndex) || !Number.isFinite(nonce)) {
    throw new Error('BUSINESS_INDEX, EMPLOYEE_INDEX, PAYOUT_NONCE must be numbers');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const employee = loadKeypairFromPath(employeeKeypairPath);

  const masterVault = deriveMasterVaultV4Pda(programId);
  const businessPda = deriveBusinessV4Pda(masterVault, businessIndex, programId);
  const payoutPda = deriveShieldedPayoutV4Pda(businessPda, employeeIndex, nonce, programId);

  const payoutInfo = await connection.getAccountInfo(payoutPda, 'confirmed');
  if (!payoutInfo) throw new Error('Shielded payout v4 not found');
  const payoutParsed = parseShieldedPayoutV4(payoutInfo.data);
  if (!payoutParsed) throw new Error('Unable to parse payout');

  const handleU128 = u128FromBytesLE(payoutParsed.employeeAuthHandle.subarray(0, 16));
  const allowancePda = deriveAllowancePda(handleU128, employee.publicKey, incoLightningId);

  const payoutTokenRaw = (process.env.PAYOUT_TOKEN_ACCOUNT || state.payoutTokenAccount || payoutParsed.payoutTokenAccount.toBase58() || '').trim();
  if (!payoutTokenRaw) throw new Error('Missing PAYOUT_TOKEN_ACCOUNT');
  const payoutTokenAccount = new PublicKey(payoutTokenRaw);

  let destinationTokenRaw = (process.env.DESTINATION_TOKEN_ACCOUNT || state.destinationTokenAccount || '').trim();
  if (!destinationTokenRaw) {
    const registryPda = deriveUserTokenV4Pda(employee.publicKey, mint, programId);
    const registryInfo = await connection.getAccountInfo(registryPda, 'confirmed');
    if (registryInfo) {
      const parsed = parseUserTokenV4(registryInfo.data);
      if (parsed && !parsed.incoTokenAccount.equals(PublicKey.default)) {
        destinationTokenRaw = parsed.incoTokenAccount.toBase58();
        console.log('destination_token_from_registry:', destinationTokenRaw);
      }
    }
  }
  if (!destinationTokenRaw) throw new Error('Missing DESTINATION_TOKEN_ACCOUNT');
  const destinationTokenAccount = new PublicKey(destinationTokenRaw);

  const claimIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: payoutPda, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: allowancePda, isSigner: false, isWritable: false },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('claim_payout_v4'), u64LE(employeeIndex), u64LE(nonce)]),
  });

  await sendIx(connection, employee, claimIx, [], 'claim_payout_v4');
}

main().catch((err) => {
  console.error('v4-claim-payout failed:', err);
  process.exit(1);
});
