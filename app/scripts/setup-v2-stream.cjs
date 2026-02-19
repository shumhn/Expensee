#!/usr/bin/env node

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
const { encryptValue } = require('@inco/solana-sdk/encryption');

const DISCRIMINATORS = {
  register_business: Buffer.from([73, 228, 5, 59, 229, 67, 133, 82]),
  init_vault: Buffer.from([77, 79, 85, 150, 33, 217, 52, 106]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  init_stream_config_v2: Buffer.from([189, 68, 68, 47, 176, 124, 45, 106]),
  add_employee_stream_v2: Buffer.from([159, 218, 122, 103, 242, 71, 89, 240]),
  delegate_stream_v2: Buffer.from([149, 221, 59, 171, 243, 25, 232, 241]),
  resume_stream_v2: Buffer.from([57, 120, 86, 179, 230, 106, 181, 161]),
  grant_employee_view_access_v2: Buffer.from([201, 191, 208, 133, 117, 221, 125, 147]),
  grant_keeper_view_access_v2: Buffer.from([60, 78, 33, 123, 183, 61, 107, 58]),
};

const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);
const INCO_MINT_TO_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:mint_to')
  .digest()
  .subarray(0, 8);

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envPublicKey(name, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return new PublicKey(value);
}

function envString(name, fallback) {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function loadKeypairFromPath(keypairPath) {
  const raw = fs.readFileSync(expandHome(keypairPath), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function u32LE(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

function deriveBusinessPda(owner, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('business'), owner.toBuffer()], programId)[0];
}

function deriveVaultPda(business, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), business.toBuffer()], programId)[0];
}

function deriveStreamConfigPda(business, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('stream_config_v2'), business.toBuffer()], programId)[0];
}

function deriveEmployeeStreamPda(business, streamIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('employee_v2'), business.toBuffer(), u64LE(streamIndex)],
    programId
  )[0];
}

function deriveBufferPda(employeeStream, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('buffer'), employeeStream.toBuffer()], programId)[0];
}

function deriveDelegationRecordPda(employeeStream, delegationProgramId) {
  return PublicKey.findProgramAddressSync([Buffer.from('delegation'), employeeStream.toBuffer()], delegationProgramId)[0];
}

function deriveDelegationMetadataPda(employeeStream, delegationProgramId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('delegation-metadata'), employeeStream.toBuffer()],
    delegationProgramId
  )[0];
}

function parseStreamConfigV2(data) {
  if (!data || data.length < 91) return null;
  return {
    keeper: new PublicKey(data.subarray(40, 72)),
    settleIntervalSecs: Number(data.readBigUInt64LE(72)),
    nextStreamIndex: Number(data.readBigUInt64LE(80)),
    isPaused: data[88] === 1,
    pauseReason: data[89],
  };
}

function parseVaultTokenAccount(data) {
  if (!data || data.length < 104) return null;
  return new PublicKey(data.subarray(72, 104));
}

function parseEmployeeStreamMeta(data) {
  if (!data || data.length < 194) return null;
  return {
    authHash: Buffer.from(data.subarray(48, 80)),
    salaryHandle: data.readBigUInt64LE(112) + (data.readBigUInt64LE(120) << 64n),
    accruedHandle: data.readBigUInt64LE(128) + (data.readBigUInt64LE(136) << 64n),
    isDelegated: data[193] === 1,
  };
}

function employeeAuthHash(pubkey) {
  return crypto.createHash('sha256').update(pubkey.toBuffer()).digest().subarray(0, 32);
}

function incoAllowancePda(handleU128, allowedAddress, incoLightningId) {
  const handleBuf = Buffer.alloc(16);
  let h = BigInt(handleU128);
  for (let i = 0; i < 16; i += 1) {
    handleBuf[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  return PublicKey.findProgramAddressSync([handleBuf, allowedAddress.toBuffer()], incoLightningId)[0];
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

async function createIncoTokenAccount(connection, payer, tokenProgramId, mint, owner, incoLightningId, label) {
  const tokenKeypair = Keypair.generate();
  const ix = new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: tokenKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
    ],
    data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
  });
  const txid = await sendIx(connection, payer, ix, [tokenKeypair], `${label}_create_token_account`);
  return { txid, tokenAccount: tokenKeypair.publicKey };
}

async function mintTo(connection, mintAuthority, tokenProgramId, lightningProgramId, mint, destinationTokenAccount, amountLamports) {
  const encryptedHex = await encryptValue(amountLamports);
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const data = Buffer.concat([
    INCO_MINT_TO_DISCRIMINATOR,
    u32LE(encrypted.length),
    encrypted,
    u32LE(0), // security zone
  ]);

  const ix = new TransactionInstruction({
    programId: tokenProgramId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: lightningProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return sendIx(connection, mintAuthority, ix, [], 'inco_mint_to');
}

async function depositToVault(connection, payer, programId, businessPda, vaultPda, depositorTokenAccount, vaultTokenAccount, incoTokenProgramId, incoLightningId, amountLamports) {
  const encryptedHex = await encryptValue(amountLamports);
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const data = Buffer.concat([
    DISCRIMINATORS.deposit,
    u32LE(encrypted.length),
    encrypted,
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // owner
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  return sendIx(connection, payer, ix, [], 'deposit_to_vault');
}

async function grantEmployeeDecrypt(connection, payer, programId, businessPda, streamConfigPda, employeeStreamPda, incoLightningId, systemProgramId, streamIndex, employeeWallet, salaryHandle, accruedHandle) {
  const salaryAllowance = incoAllowancePda(salaryHandle, employeeWallet, incoLightningId);
  const accruedAllowance = incoAllowancePda(accruedHandle, employeeWallet, incoLightningId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPda, isSigner: false, isWritable: false }, // stream (read-only)
      { pubkey: employeeWallet, isSigner: false, isWritable: false }, // allowed
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: accruedAllowance, isSigner: false, isWritable: true },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: systemProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISCRIMINATORS.grant_employee_view_access_v2, u64LE(streamIndex)]),
  });
  return sendIx(connection, payer, ix, [], 'grant_employee_view_access_v2');
}

async function grantKeeperDecrypt(connection, payer, programId, businessPda, streamConfigPda, employeeStreamPda, incoLightningId, systemProgramId, streamIndex, keeperWallet, salaryHandle) {
  const salaryAllowance = incoAllowancePda(salaryHandle, keeperWallet, incoLightningId);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // caller
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: false },
      { pubkey: employeeStreamPda, isSigner: false, isWritable: false }, // stream (read-only)
      { pubkey: keeperWallet, isSigner: false, isWritable: false }, // allowed keeper
      { pubkey: salaryAllowance, isSigner: false, isWritable: true },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: systemProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISCRIMINATORS.grant_keeper_view_access_v2, u64LE(streamIndex)]),
  });
  return sendIx(connection, payer, ix, [], 'grant_keeper_view_access_v2');
}

async function main() {
  // Setup must run against a base-layer Solana RPC. MagicBlock router/ER endpoints do not reliably
  // support all JSON-RPC methods needed here (e.g. getBalance).
  const baseRpcUrl = envString(
    'KEEPER_READ_RPC_URL',
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com'
  );
  const requestedRpcUrl = envString('KEEPER_RPC_URL', baseRpcUrl);
  const rpcUrl = requestedRpcUrl.includes('magicblock') ? baseRpcUrl : requestedRpcUrl;
  const programId = envPublicKey('KEEPER_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const incoLightningId = envPublicKey(
    'KEEPER_INCO_LIGHTNING_ID',
    process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
  );
  const incoTokenProgramId = envPublicKey(
    'KEEPER_INCO_TOKEN_PROGRAM_ID',
    process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID || '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N'
  );
  const mint = envPublicKey('NEXT_PUBLIC_PAYUSD_MINT', 'GhCZ59UK4Afg4WGpQ11HyRc8ya4swgWFXMh2BxuWQXHt');
  const validator = envPublicKey('KEEPER_VALIDATOR', 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e');
  const delegationProgramId = envPublicKey(
    'KEEPER_DELEGATION_PROGRAM_ID',
    process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM ||
      process.env.KEEPER_MAGIC_PROGRAM_ID ||
      'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
  );
  const keypairPath = envString(
    'KEEPER_PAYER_KEYPAIR_PATH',
    process.env.SOLANA_KEYPAIR_PATH || path.join(os.homedir(), '.config/solana/devnet-keypair.json')
  );

  const settleIntervalSecs = Number(process.env.SETUP_SETTLE_INTERVAL_SECS || '10');
  
  // Salary configuration:
  // Option A: Set total amount for the period (e.g. 5000 tokens) -> we calculate rate
  // Option B: Set rate directly (legacy)
  const periodDays = Number(process.env.SETUP_PERIOD_DAYS || '30');
  const periodSeconds = Math.floor(periodDays * 86400);
  
  let salaryLamportsPerSecond;
  if (process.env.SETUP_TOTAL_AMOUNT) {
    if (periodDays <= 0) throw new Error('Cannot use SETUP_TOTAL_AMOUNT with unbounded stream (period=0)');
    const totalAmount = Number(process.env.SETUP_TOTAL_AMOUNT);
    const totalLamports = BigInt(Math.floor(totalAmount * 1_000_000_000));
    salaryLamportsPerSecond = totalLamports / BigInt(periodSeconds);
    console.log(`Calculated rate from total amount ${totalAmount}: ${salaryLamportsPerSecond} lamports/sec`);
  } else {
    salaryLamportsPerSecond = BigInt(process.env.SETUP_SALARY_LAMPORTS_PER_SEC || '100000');
  }

  const decimals = Number(process.env.SETUP_MINT_DECIMALS || '9');
  const depositUi = Number(process.env.SETUP_DEPOSIT_UI || '0');
  const mintUi = Number(process.env.SETUP_MINT_UI || '0');
  const mintAuthorityPath = (process.env.SETUP_MINT_AUTHORITY_KEYPAIR_PATH || process.env.MINT_AUTHORITY_KEYPAIR_PATH || '').trim();

  const repoRoot = path.resolve(__dirname, '..', '..');
  const keeperDir = path.join(repoRoot, 'services', 'keeper');
  const statePath = path.join(keeperDir, 'devnet-v2-state.json');
  const employeeKeypairPath = envString('SETUP_EMPLOYEE_KEYPAIR_PATH', path.join(keeperDir, 'demo-employee-keypair.json'));
  const forceNewEmployee = process.env.SETUP_FORCE_NEW_EMPLOYEE === '1' || process.env.SETUP_FORCE_NEW_EMPLOYEE === 'true';

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = loadKeypairFromPath(keypairPath);

  console.log('payer:', payer.publicKey.toBase58());
  console.log('rpc:', rpcUrl);
  console.log('program:', programId.toBase58());
  console.log('mint:', mint.toBase58());

  const payerBalance = await connection.getBalance(payer.publicKey, 'confirmed');
  console.log('payer SOL balance:', payerBalance / 1e9);
  if (payerBalance < 0.05 * 1e9) {
    throw new Error('Insufficient SOL for setup transactions');
  }

  const businessPda = deriveBusinessPda(payer.publicKey, programId);
  const vaultPda = deriveVaultPda(businessPda, programId);
  const streamConfigPda = deriveStreamConfigPda(businessPda, programId);

  const state = readJson(statePath, {});

  const businessInfo = await connection.getAccountInfo(businessPda, 'confirmed');
  if (!businessInfo) {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: DISCRIMINATORS.register_business,
    });
    await sendIx(connection, payer, ix, [], 'register_business');
  } else {
    console.log('register_business: already exists');
  }

  let vaultInfo = await connection.getAccountInfo(vaultPda, 'confirmed');
  let vaultTokenAccount;
  if (!vaultInfo) {
    const createdVaultToken = await createIncoTokenAccount(
      connection,
      payer,
      incoTokenProgramId,
      mint,
      vaultPda,
      incoLightningId,
      'vault'
    );
    vaultTokenAccount = createdVaultToken.tokenAccount;

    const data = Buffer.concat([DISCRIMINATORS.init_vault, mint.toBuffer(), vaultTokenAccount.toBuffer()]);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendIx(connection, payer, ix, [], 'init_vault');

    vaultInfo = await connection.getAccountInfo(vaultPda, 'confirmed');
  } else {
    vaultTokenAccount = parseVaultTokenAccount(vaultInfo.data);
    console.log('init_vault: already exists');
  }

  if (!vaultTokenAccount) {
    throw new Error('Unable to resolve vault token account');
  }

  // Create or reuse a depositor token account owned by payer (source funds for vault).
  let depositorTokenAccount = state.depositorTokenAccount ? new PublicKey(state.depositorTokenAccount) : null;
  if (!depositorTokenAccount || !(await connection.getAccountInfo(depositorTokenAccount, 'confirmed'))) {
    const createdDepositorToken = await createIncoTokenAccount(
      connection,
      payer,
      incoTokenProgramId,
      mint,
      payer.publicKey,
      incoLightningId,
      'depositor'
    );
    depositorTokenAccount = createdDepositorToken.tokenAccount;
  } else {
    console.log('depositor token account: reusing existing');
  }

  // Optional: mint confidential tokens to depositor token account (requires mint authority).
  if (mintUi > 0 && mintAuthorityPath) {
    const mintAuthority = loadKeypairFromPath(mintAuthorityPath);
    const amountLamports = BigInt(Math.floor(mintUi * Math.pow(10, decimals)));
    try {
      await mintTo(
        connection,
        mintAuthority,
        incoTokenProgramId,
        incoLightningId,
        mint,
        depositorTokenAccount,
        amountLamports
      );
    } catch (e) {
      console.warn('inco mint_to failed; skipping mint:', e?.message || e);
    }
  }

  // Optional: deposit to vault from depositor token account.
  if (depositUi > 0) {
    const amountLamports = BigInt(Math.floor(depositUi * Math.pow(10, decimals)));
    try {
      await depositToVault(
        connection,
        payer,
        programId,
        businessPda,
        vaultPda,
        depositorTokenAccount,
        vaultTokenAccount,
        incoTokenProgramId,
        incoLightningId,
        amountLamports
      );
    } catch (e) {
      console.warn('deposit_to_vault failed; continue setup:', e?.message || e);
    }
  }

  let streamConfigInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
  if (!streamConfigInfo) {
    const data = Buffer.concat([
      DISCRIMINATORS.init_stream_config_v2,
      payer.publicKey.toBuffer(),
      u64LE(settleIntervalSecs),
    ]);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: streamConfigPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendIx(connection, payer, ix, [], 'init_stream_config_v2');
    streamConfigInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
  } else {
    console.log('init_stream_config_v2: already exists');
  }

  if (!streamConfigInfo) {
    throw new Error('stream config missing after initialization');
  }

  let streamConfig = parseStreamConfigV2(streamConfigInfo.data);
  if (!streamConfig) {
    throw new Error('failed to parse stream config account');
  }

  if (streamConfig.isPaused) {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: true },
      ],
      data: DISCRIMINATORS.resume_stream_v2,
    });
    await sendIx(connection, payer, ix, [], 'resume_stream_v2');
    streamConfigInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
    streamConfig = parseStreamConfigV2(streamConfigInfo.data);
  }

  let employeeKeypair;
  if (!forceNewEmployee && fs.existsSync(employeeKeypairPath)) {
    employeeKeypair = loadKeypairFromPath(employeeKeypairPath);
  } else {
    employeeKeypair = Keypair.generate();
    fs.mkdirSync(path.dirname(employeeKeypairPath), { recursive: true });
    fs.writeFileSync(employeeKeypairPath, JSON.stringify(Array.from(employeeKeypair.secretKey)));
  }

  let employeeTokenAccount = forceNewEmployee ? null : (state.employeeTokenAccount ? new PublicKey(state.employeeTokenAccount) : null);
  if (!employeeTokenAccount || !(await connection.getAccountInfo(employeeTokenAccount, 'confirmed'))) {
    const createdEmployeeToken = await createIncoTokenAccount(
      connection,
      payer,
      incoTokenProgramId,
      mint,
      employeeKeypair.publicKey,
      incoLightningId,
      'employee'
    );
    employeeTokenAccount = createdEmployeeToken.tokenAccount;
  } else {
    console.log('employee token account: reusing existing');
  }

  const authHash = employeeAuthHash(employeeKeypair.publicKey);
  let streamIndex = streamConfig.nextStreamIndex;
  let employeeStreamPda = deriveEmployeeStreamPda(businessPda, streamIndex, programId);

  // Reuse previous stream for this employee if available (idempotent reruns).
  if (!forceNewEmployee && streamIndex > 0) {
    const candidateIndex = streamIndex - 1;
    const candidatePda = deriveEmployeeStreamPda(businessPda, candidateIndex, programId);
    const candidateInfo = await connection.getAccountInfo(candidatePda, 'confirmed');
    const candidateMeta = candidateInfo ? parseEmployeeStreamMeta(candidateInfo.data) : null;
    if (candidateMeta && candidateMeta.authHash.equals(authHash)) {
      streamIndex = candidateIndex;
      employeeStreamPda = candidatePda;
      console.log(`add_employee_stream_v2: reusing existing stream index ${streamIndex}`);
    }
  }

  const existingEmployeeStream = await connection.getAccountInfo(employeeStreamPda, 'confirmed');
  if (!existingEmployeeStream) {
    const salaryEncryptedHex = await encryptValue(salaryLamportsPerSecond);
    const salaryEncrypted = Buffer.from(salaryEncryptedHex, 'hex');

    // Bounded stream: period_start defaults to now, period_end to now + SETUP_PERIOD_DAYS days.
    // Set SETUP_PERIOD_DAYS=0 for unbounded (legacy) streams.
    const periodDays = Number(process.env.SETUP_PERIOD_DAYS || '30');
    const nowUnix = Math.floor(Date.now() / 1000);
    const periodStartVal = periodDays > 0 ? BigInt(nowUnix) : 0n;
    const periodEndVal = periodDays > 0 ? BigInt(Math.floor(nowUnix + periodDays * 86400)) : 0n;
    const periodStartBuf = Buffer.alloc(8);
    periodStartBuf.writeBigInt64LE(periodStartVal);
    const periodEndBuf = Buffer.alloc(8);
    periodEndBuf.writeBigInt64LE(periodEndVal);

    if (periodDays > 0) {
      console.log(`  Bounded stream: ${periodDays} days (${new Date(nowUnix * 1000).toISOString()} → ${new Date(Number(periodEndVal) * 1000).toISOString()})`);
    } else {
      console.log('  Unbounded stream (legacy mode)');
    }

    const addData = Buffer.concat([
      DISCRIMINATORS.add_employee_stream_v2,
      authHash,
      employeeTokenAccount.toBuffer(),
      u32LE(salaryEncrypted.length),
      salaryEncrypted,
      periodStartBuf,
      periodEndBuf,
    ]);

    const addIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: streamConfigPda, isSigner: false, isWritable: true },
        { pubkey: employeeStreamPda, isSigner: false, isWritable: true },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: addData,
    });
    await sendIx(connection, payer, addIx, [], 'add_employee_stream_v2');
  } else {
    console.log('add_employee_stream_v2: already exists');
  }

  const streamInfo = await connection.getAccountInfo(employeeStreamPda, 'confirmed');
  const streamMeta = streamInfo ? parseEmployeeStreamMeta(streamInfo.data) : null;
  if (!streamMeta) {
    throw new Error('Failed to load employee stream for delegation');
  }

  // Real-world operability: grant employee + keeper decrypt access so:
  // - employee can reveal earnings in UI
  // - keeper can decrypt salary-rate handle to process withdraw requests even when keeper != owner
  const autoGrantDecrypt = process.env.SETUP_AUTO_GRANT_DECRYPT !== 'false';
  if (autoGrantDecrypt) {
    try {
      await grantEmployeeDecrypt(
        connection,
        payer,
        programId,
        businessPda,
        streamConfigPda,
        employeeStreamPda,
        incoLightningId,
        SystemProgram.programId,
        streamIndex,
        employeeKeypair.publicKey,
        streamMeta.salaryHandle,
        streamMeta.accruedHandle
      );
    } catch (e) {
      console.warn('grant_employee_view_access_v2 failed; continue setup:', e?.message || e);
    }
    try {
      await grantKeeperDecrypt(
        connection,
        payer,
        programId,
        businessPda,
        streamConfigPda,
        employeeStreamPda,
        incoLightningId,
        SystemProgram.programId,
        streamIndex,
        streamConfig.keeper,
        streamMeta.salaryHandle
      );
    } catch (e) {
      console.warn('grant_keeper_view_access_v2 failed; continue setup:', e?.message || e);
    }
  }

  let delegatedNow = streamMeta.isDelegated;
  if (!streamMeta.isDelegated) {
    const bufferEmployee = deriveBufferPda(employeeStreamPda, programId);
    const delegationRecordEmployee = deriveDelegationRecordPda(employeeStreamPda, delegationProgramId);
    const delegationMetadataEmployee = deriveDelegationMetadataPda(employeeStreamPda, delegationProgramId);

    const delegateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: false },
        { pubkey: bufferEmployee, isSigner: false, isWritable: true },
        { pubkey: delegationRecordEmployee, isSigner: false, isWritable: true },
        { pubkey: delegationMetadataEmployee, isSigner: false, isWritable: true },
        { pubkey: employeeStreamPda, isSigner: false, isWritable: true },
        { pubkey: validator, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false }, // owner_program
        { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISCRIMINATORS.delegate_stream_v2, u64LE(streamIndex)]),
    });
    try {
      await sendIx(connection, payer, delegateIx, [], 'delegate_stream_v2');
      delegatedNow = true;
    } catch (e) {
      console.warn('delegate_stream_v2 failed; continuing without delegation:', e?.message || e);
      delegatedNow = false;
    }
  } else {
    console.log('delegate_stream_v2: already delegated');
    delegatedNow = true;
  }

  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    payer: payer.publicKey.toBase58(),
    businessPda: businessPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultTokenAccount: vaultTokenAccount.toBase58(),
    depositorTokenAccount: depositorTokenAccount.toBase58(),
    streamConfigPda: streamConfigPda.toBase58(),
    latestStreamIndex: streamIndex,
    latestEmployeeStreamPda: employeeStreamPda.toBase58(),
    employeeWallet: employeeKeypair.publicKey.toBase58(),
    employeeTokenAccount: employeeTokenAccount.toBase58(),
    delegated: delegatedNow,
    settleIntervalSecs: streamConfig.settleIntervalSecs,
    salaryLamportsPerSecond: salaryLamportsPerSecond.toString(),
  };
  writeJson(statePath, nextState);

  console.log('setup complete');
  console.log(JSON.stringify(nextState, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
