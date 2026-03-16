#!/usr/bin/env node

/**
 * Setup v4 pooled-vault payroll (devnet).
 *
 * Steps:
 * 1) Init master vault v4 (if missing)
 * 2) Create pooled vault token account (owned by master vault PDA) + set_pool_vault_v4
 * 3) Register business v4 (index-based)
 * 4) Init stream config v4 (keeper + cadence)
 * 5) Add employee v4 (encrypted salary + employee ID)
 * 6) Optional: mint test tokens + deposit into pooled vault
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
const { encryptValue } = require('@inco/solana-sdk/encryption');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const repoRoot = path.resolve(__dirname, '..', '..');
loadEnvFile(path.join(repoRoot, 'frontend', '.env.local'));
loadEnvFile(path.join(repoRoot, '.env'));

function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const DISCRIMINATORS = {
  init_master_vault_v4: discriminator('init_master_vault_v4'),
  set_pool_vault_v4: discriminator('set_pool_vault_v4'),
  register_business_v4: discriminator('register_business_v4'),
  init_stream_config_v4: discriminator('init_stream_config_v4'),
  update_keeper_v4: discriminator('update_keeper_v4'),
  add_employee_v4: discriminator('add_employee_v4'),
  deposit_v4: discriminator('deposit_v4'),
  init_user_token_account_v4: discriminator('init_user_token_account_v4'),
  link_user_token_account_v4: discriminator('link_user_token_account_v4'),
  delegate_stream_v4: discriminator('delegate_stream_v4'),
};

const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);
const INCO_MINT_TO_DISCRIMINATOR = discriminator('mint_to');

const SEEDS = {
  buffer: Buffer.from('buffer'),
  delegation: Buffer.from('delegation'),
  delegation_metadata: Buffer.from('delegation-metadata'),
};

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

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function loadKeypairFromPath(keypairPath) {
  const trimmed = (keypairPath || '').trim();
  if (!trimmed) {
    throw new Error('Missing keypair path');
  }
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  const raw = fs.readFileSync(expandHome(trimmed), 'utf8');
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

function u128FromBytesLE(bytes) {
  let value = 0n;
  const len = Math.min(bytes.length, 16);
  for (let i = 0; i < len; i += 1) {
    value |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return value;
}

async function encryptForInco(value) {
  const encryptedHex = await encryptValue(value);
  return Buffer.from(encryptedHex, 'hex');
}

function getPrivacySalt() {
  const raw = (process.env.PRIVACY_ID_SALT || process.env.NEXT_PUBLIC_PRIVACY_ID_SALT || '').trim();
  return raw ? Buffer.from(raw, 'utf8') : null;
}

async function encryptPubkeyId(pubkey) {
  const hashBuilder = crypto.createHash('sha256');
  const salt = getPrivacySalt();
  if (salt) {
    hashBuilder.update(salt);
  }
  const hash = hashBuilder.update(pubkey.toBuffer()).digest().subarray(0, 16);
  const idValue = u128FromBytesLE(hash);
  const encryptedHex = await encryptValue(idValue);
  return Buffer.from(encryptedHex, 'hex');
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

function deriveUserTokenV4Pda(owner, mint, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_token_v4'), owner.toBuffer(), mint.toBuffer()],
    programId
  )[0];
}

function deriveBufferPda(employee, programId) {
  return PublicKey.findProgramAddressSync([SEEDS.buffer, employee.toBuffer()], programId)[0];
}

function derivePermissionBufferPda(permission, permissionProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.buffer, permission.toBuffer()], permissionProgramId)[0];
}

function deriveDelegationRecordPda(account, delegationProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.delegation, account.toBuffer()], delegationProgramId)[0];
}

function deriveDelegationMetadataPda(account, delegationProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.delegation_metadata, account.toBuffer()], delegationProgramId)[0];
}

function parseMasterVaultV4(data) {
  if (!data || data.length < 180) return null;
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    vaultTokenAccount: new PublicKey(data.subarray(40, 72)),
    mint: new PublicKey(data.subarray(72, 104)),
    useConfidentialTokens: data[104] === 1,
    nextBusinessIndex: Number(data.readBigUInt64LE(169)),
    isActive: data[177] === 1,
  };
}

function parseBusinessV4(data) {
  if (!data || data.length < 186) return null;
  return {
    businessIndex: Number(data.readBigUInt64LE(40)),
    nextEmployeeIndex: Number(data.readBigUInt64LE(176)),
    isActive: data[184] === 1,
  };
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
  const encrypted = await encryptForInco(amountLamports);
  const data = Buffer.concat([
    INCO_MINT_TO_DISCRIMINATOR,
    u32LE(encrypted.length),
    encrypted,
    u32LE(0),
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

async function depositToPool(
  connection,
  payer,
  programId,
  masterVaultPda,
  businessPda,
  depositorTokenAccount,
  vaultTokenAccount,
  incoTokenProgramId,
  incoLightningId,
  amountLamports
) {
  const encryptedAmount = await encryptForInco(amountLamports);
  const data = Buffer.concat([DISCRIMINATORS.deposit_v4, u32LE(encryptedAmount.length), encryptedAmount]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVaultPda, isSigner: false, isWritable: true },
      { pubkey: businessPda, isSigner: false, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return sendIx(connection, payer, ix, [], 'deposit_v4');
}

async function initUserTokenRegistry(connection, payer, programId, mint, incoLightningId) {
  const userTokenPda = deriveUserTokenV4Pda(payer.publicKey, mint, programId);
  const existing = await connection.getAccountInfo(userTokenPda, 'confirmed');
  if (existing) {
    console.log('init_user_token_account_v4: already exists');
    return userTokenPda;
  }

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISCRIMINATORS.init_user_token_account_v4,
  });
  await sendIx(connection, payer, ix, [], 'init_user_token_account_v4');
  return userTokenPda;
}

async function linkUserTokenRegistry(connection, payer, programId, mint, incoTokenAccount, incoLightningId) {
  const userTokenPda = deriveUserTokenV4Pda(payer.publicKey, mint, programId);
  const data = Buffer.concat([DISCRIMINATORS.link_user_token_account_v4, u32LE(0)]);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenPda, isSigner: false, isWritable: true },
      { pubkey: incoTokenAccount, isSigner: false, isWritable: true },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  await sendIx(connection, payer, ix, [], 'link_user_token_account_v4');
  return userTokenPda;
}

async function main() {
  const rpcUrl = envString('RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  const programId = envPublicKey('PAYROLL_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const incoLightningId = envPublicKey('INCO_LIGHTNING_ID', process.env.NEXT_PUBLIC_INCO_PROGRAM_ID);
  const incoTokenProgramId = envPublicKey('INCO_TOKEN_PROGRAM_ID', process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID);
  const delegationProgramId = envPublicKey(
    'MAGICBLOCK_DELEGATION_PROGRAM',
    process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM || 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
  );
  const permissionProgramId = envPublicKey(
    'MAGICBLOCK_PERMISSION_PROGRAM',
    process.env.NEXT_PUBLIC_MAGICBLOCK_PERMISSION_PROGRAM || 'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1'
  );
  const validator = envPublicKey(
    'MAGICBLOCK_VALIDATOR',
    process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'
  );
  const mint = envPublicKey('PAYUSD_MINT', process.env.NEXT_PUBLIC_PAYUSD_MINT);

  const keypairPath = envString('SETUP_KEYPAIR_PATH', 'keys/payroll-authority.json');
  const employeeKeypairPath = envString(
    'SETUP_EMPLOYEE_KEYPAIR_PATH',
    path.join(__dirname, '..', '..', 'services', 'keeper', 'demo-employee-keypair.json')
  );
  const employeeWalletOverride = (process.env.SETUP_EMPLOYEE_WALLET || '').trim();
  const settleIntervalSecs = Number(process.env.SETUP_SETTLE_INTERVAL_SECS || '10');
  const salaryLamportsPerSec = BigInt(process.env.SETUP_SALARY_LAMPORTS_PER_SEC || '100000');
  const periodStart = Number(process.env.SETUP_PERIOD_START || '0') || 0;
  const periodEnd = Number(process.env.SETUP_PERIOD_END || '0') || 0;

  const decimals = Number(process.env.SETUP_MINT_DECIMALS || '9');
  const depositUi = Number(process.env.SETUP_DEPOSIT_UI || '0');
  const mintUi = Number(process.env.SETUP_MINT_UI || '0');
  const mintAuthorityPath = (process.env.SETUP_MINT_AUTHORITY_KEYPAIR_PATH || process.env.MINT_AUTHORITY_KEYPAIR_PATH || '').trim();

  const repoRoot = path.resolve(__dirname, '..', '..');
  const keeperDir = path.join(repoRoot, 'services', 'keeper');
  const statePath = path.join(keeperDir, 'devnet-v4-state.json');
  const forceNewBusiness = process.env.SETUP_FORCE_NEW_BUSINESS === '1' || process.env.SETUP_FORCE_NEW_BUSINESS === 'true';
  const forceNewEmployee = process.env.SETUP_FORCE_NEW_EMPLOYEE === '1' || process.env.SETUP_FORCE_NEW_EMPLOYEE === 'true';
  const autoDelegate =
    (process.env.SETUP_AUTO_DELEGATE || 'true').toLowerCase() !== 'false';
  const initUserRegistry = (process.env.SETUP_INIT_USER_TOKEN_REGISTRY || 'true').toLowerCase() !== 'false';
  const linkUserRegistry = (process.env.SETUP_LINK_USER_TOKEN_REGISTRY || 'true').toLowerCase() !== 'false';

  const connection = new Connection(rpcUrl, 'confirmed');
  const payer = loadKeypairFromPath(keypairPath);
  const employeeKeypair = loadKeypairFromPath(employeeKeypairPath);
  const employeeWallet = employeeWalletOverride ? new PublicKey(employeeWalletOverride) : employeeKeypair.publicKey;

  console.log('payer:', payer.publicKey.toBase58());
  console.log('rpc:', rpcUrl);
  console.log('program:', programId.toBase58());
  console.log('mint:', mint.toBase58());

  const payerBalance = await connection.getBalance(payer.publicKey, 'confirmed');
  if (payerBalance < 0.05 * 1e9) throw new Error('Insufficient SOL for setup');

  const masterVaultPda = deriveMasterVaultV4Pda(programId);
  let masterInfo = await connection.getAccountInfo(masterVaultPda, 'confirmed');
  if (!masterInfo) {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: true },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: DISCRIMINATORS.init_master_vault_v4,
    });
    await sendIx(connection, payer, ix, [], 'init_master_vault_v4');
    masterInfo = await connection.getAccountInfo(masterVaultPda, 'confirmed');
  } else {
    console.log('init_master_vault_v4: already exists');
  }
  if (!masterInfo) throw new Error('Master vault v4 missing');

  let master = parseMasterVaultV4(masterInfo.data);
  if (!master) throw new Error('Unable to parse master vault v4');

  if (master.vaultTokenAccount.equals(PublicKey.default)) {
    const { tokenAccount } = await createIncoTokenAccount(
      connection,
      payer,
      incoTokenProgramId,
      mint,
      masterVaultPda,
      incoLightningId,
      'pool_vault'
    );
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISCRIMINATORS.set_pool_vault_v4,
        mint.toBuffer(),
        Buffer.from([1]),
      ]),
    });
    await sendIx(connection, payer, ix, [], 'set_pool_vault_v4');
    masterInfo = await connection.getAccountInfo(masterVaultPda, 'confirmed');
    master = parseMasterVaultV4(masterInfo?.data || null);
  }
  if (!master) throw new Error('Master vault v4 parse failed after set_pool_vault');

  const state = readJson(statePath, {});
  let businessIndex = null;
  if (!forceNewBusiness && typeof state.businessIndex === 'number') {
    const candidate = deriveBusinessV4Pda(masterVaultPda, state.businessIndex, programId);
    const existing = await connection.getAccountInfo(candidate, 'confirmed');
    if (existing) businessIndex = state.businessIndex;
  }
  if (businessIndex === null) businessIndex = master.nextBusinessIndex;

  const businessPda = deriveBusinessV4Pda(masterVaultPda, businessIndex, programId);
  let businessInfo = await connection.getAccountInfo(businessPda, 'confirmed');
  if (!businessInfo) {
    const encryptedEmployerId = await encryptPubkeyId(payer.publicKey);
    const data = Buffer.concat([
      DISCRIMINATORS.register_business_v4,
      u32LE(encryptedEmployerId.length),
      encryptedEmployerId,
      payer.publicKey.toBuffer(),
    ]);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendIx(connection, payer, ix, [], 'register_business_v4');
    businessInfo = await connection.getAccountInfo(businessPda, 'confirmed');
  } else {
    console.log('register_business_v4: already exists');
  }
  if (!businessInfo) throw new Error('Business v4 missing');

  const businessParsed = parseBusinessV4(businessInfo.data);
  if (!businessParsed) throw new Error('Unable to parse business v4');

  let employeeIndex = null;
  if (!forceNewEmployee && typeof state.employeeIndex === 'number') {
    const candidate = deriveEmployeeV4Pda(businessPda, state.employeeIndex, programId);
    const existing = await connection.getAccountInfo(candidate, 'confirmed');
    if (existing) employeeIndex = state.employeeIndex;
  }
  if (employeeIndex === null) employeeIndex = businessParsed.nextEmployeeIndex;

  const employeePda = deriveEmployeeV4Pda(businessPda, employeeIndex, programId);
  const streamConfigPda = deriveStreamConfigV4Pda(businessPda, programId);
  let employeeInfo = await connection.getAccountInfo(employeePda, 'confirmed');
  if (!employeeInfo) {
    const encryptedEmployeeId = await encryptPubkeyId(employeeWallet);
    const encryptedSalary = await encryptForInco(salaryLamportsPerSec);
    // Calculate required deposit for private solvency check:
    // salary × duration for bounded contracts, 0 for open-ended.
    const duration = periodEnd > periodStart ? BigInt(periodEnd - periodStart) : 0n;
    const requiredDeposit = duration > 0n ? salaryLamportsPerSec * duration : 0n;
    const data = Buffer.concat([
      DISCRIMINATORS.add_employee_v4,
      u64LE(employeeIndex),
      u32LE(encryptedEmployeeId.length),
      encryptedEmployeeId,
      u32LE(encryptedSalary.length),
      encryptedSalary,
      Buffer.from(new BigInt64Array([BigInt(periodStart)]).buffer),
      Buffer.from(new BigInt64Array([BigInt(periodEnd)]).buffer),
      u64LE(requiredDeposit),
    ]);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: false },
        { pubkey: businessPda, isSigner: false, isWritable: true },
        { pubkey: employeePda, isSigner: false, isWritable: true },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendIx(connection, payer, ix, [], 'add_employee_v4');
    employeeInfo = await connection.getAccountInfo(employeePda, 'confirmed');
  } else {
    console.log('add_employee_v4: already exists');
  }
  if (!employeeInfo) throw new Error('Employee v4 missing');

  const streamConfigInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
  if (!streamConfigInfo) {
    const intervalBuf = Buffer.alloc(8);
    intervalBuf.writeBigUInt64LE(BigInt(settleIntervalSecs));
    const data = Buffer.concat([DISCRIMINATORS.init_stream_config_v4, intervalBuf]);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: false },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
    await sendIx(connection, payer, ix, [], 'init_stream_config_v4');
  } else {
    console.log('init_stream_config_v4: already exists');
  }

  const employeeDelegated = employeeInfo.owner.equals(delegationProgramId);
  if (autoDelegate && !employeeDelegated) {
    const bufferPda = deriveBufferPda(employeePda, programId);
    const delegationRecord = deriveDelegationRecordPda(employeePda, delegationProgramId);
    const delegationMetadata = deriveDelegationMetadataPda(employeePda, delegationProgramId);
    const [permissionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('permission:'), employeePda.toBuffer()],
      permissionProgramId
    );
    const permissionBufferPda = derivePermissionBufferPda(permissionPda, permissionProgramId);
    const permissionDelegationRecord = deriveDelegationRecordPda(permissionPda, delegationProgramId);
    const permissionDelegationMetadata = deriveDelegationMetadataPda(permissionPda, delegationProgramId);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVaultPda, isSigner: false, isWritable: false },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: false },
        { pubkey: bufferPda, isSigner: false, isWritable: true },
        { pubkey: delegationRecord, isSigner: false, isWritable: true },
        { pubkey: delegationMetadata, isSigner: false, isWritable: true },
        { pubkey: employeePda, isSigner: false, isWritable: true },
        { pubkey: permissionBufferPda, isSigner: false, isWritable: true },
        { pubkey: permissionDelegationRecord, isSigner: false, isWritable: true },
        { pubkey: permissionDelegationMetadata, isSigner: false, isWritable: true },
        { pubkey: permissionPda, isSigner: false, isWritable: true },
        { pubkey: permissionProgramId, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // authority
        { pubkey: employeeWallet, isSigner: false, isWritable: false },
        { pubkey: validator, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISCRIMINATORS.delegate_stream_v4, u64LE(employeeIndex)]),
    });
    await sendIx(connection, payer, ix, [], 'delegate_stream_v4');
    employeeInfo = await connection.getAccountInfo(employeePda, 'confirmed');
  } else if (autoDelegate) {
    console.log('delegate_stream_v4: already delegated');
  }

  let depositorTokenAccount = (process.env.SETUP_DEPOSITOR_TOKEN_ACCOUNT || '').trim();
  let userTokenRegistryPda = null;
  if (!depositorTokenAccount) {
    const { tokenAccount } = await createIncoTokenAccount(
      connection,
      payer,
      incoTokenProgramId,
      mint,
      payer.publicKey,
      incoLightningId,
      'depositor'
    );
    depositorTokenAccount = tokenAccount.toBase58();
  }

  if (initUserRegistry) {
    userTokenRegistryPda = await initUserTokenRegistry(connection, payer, programId, mint, incoLightningId);
  }
  if (linkUserRegistry && depositorTokenAccount) {
    userTokenRegistryPda = await linkUserTokenRegistry(
      connection,
      payer,
      programId,
      mint,
      new PublicKey(depositorTokenAccount),
      incoLightningId
    );
  }

  if (mintUi > 0) {
    if (!mintAuthorityPath) throw new Error('SETUP_MINT_AUTHORITY_KEYPAIR_PATH is required for minting');
    const mintAuthority = loadKeypairFromPath(mintAuthorityPath);
    const amountLamports = BigInt(Math.round(mintUi * 10 ** decimals));
    await mintTo(connection, mintAuthority, incoTokenProgramId, incoLightningId, mint, new PublicKey(depositorTokenAccount), amountLamports);
  }

  if (depositUi > 0) {
    const amountLamports = BigInt(Math.round(depositUi * 10 ** decimals));
    await depositToPool(
      connection,
      payer,
      programId,
      masterVaultPda,
      businessPda,
      new PublicKey(depositorTokenAccount),
      master.vaultTokenAccount,
      incoTokenProgramId,
      incoLightningId,
      amountLamports
    );
  }

  writeJson(statePath, {
    businessIndex,
    businessPda: businessPda.toBase58(),
    employeeIndex,
    employeePda: employeePda.toBase58(),
    masterVault: masterVaultPda.toBase58(),
    poolVaultTokenAccount: master.vaultTokenAccount.toBase58(),
    depositorTokenAccount,
    employeeWallet: employeeWallet.toBase58(),
    userTokenRegistry: userTokenRegistryPda ? userTokenRegistryPda.toBase58() : undefined,
  });

  console.log('v4 pooled setup complete');
  console.log('businessIndex:', businessIndex);
  console.log('employeeIndex:', employeeIndex);
  console.log('poolVaultTokenAccount:', master.vaultTokenAccount.toBase58());
}

main().catch((err) => {
  console.error('setup-v4-pooled failed:', err);
  process.exit(1);
});
