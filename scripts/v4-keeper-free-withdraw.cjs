#!/usr/bin/env node

/**
 * End-to-end v4 keeper-free withdraw flow for devnet.
 *
 * Steps:
 * 1) Request withdraw & commit stream to base layer (Employee Signer).
 * 2) Wait for the Ephemeral Rollup validator to execute `commit_and_undelegate_stream_v4`.
 * 3) Execute Full Withdrawal (Process + Claim + Redelegate) on base layer (Employee Signer).
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
} = require('@solana/web3.js');
const { ConnectionMagicRouter, getAuthToken } = require('@magicblock-labs/ephemeral-rollups-sdk');

// TEE token generation for Node.js (Keypair-based signing)
async function generateTeeToken(teeUrl, keypair) {
  let ed25519;
  try {
    ed25519 = (await import('@noble/curves/ed25519')).ed25519;
  } catch {
    console.warn('⚠️  @noble/curves not available, skipping TEE token generation');
    return null;
  }
  const signMessage = async (message) => {
    const secret = keypair.secretKey.slice(0, 32);
    return ed25519.sign(message, secret);
  };
  try {
    const auth = await getAuthToken(teeUrl, keypair.publicKey, signMessage);
    const token = typeof auth === 'string' ? auth : auth.token;
    console.log(`✅ TEE token for ${keypair.publicKey.toBase58().slice(0, 8)}...: ${token.slice(0, 12)}...`);
    return token;
  } catch (err) {
    console.warn(`⚠️  TEE token generation failed: ${err.message}`);
    return null;
  }
}

function withTeeToken(url, token) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

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

const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);
const INCO_ALLOW_DISCRIMINATOR = Buffer.from([60, 103, 140, 65, 110, 109, 147, 164]);

const SEEDS = {
  buffer: Buffer.from('buffer'),
  delegation: Buffer.from('delegation'),
  delegation_metadata: Buffer.from('delegation-metadata'),
};

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

async function sendIx(connection, payer, instructions, extraSigners = [], label = 'tx') {
  const tx = new Transaction();
  for (const ix of instructions) {
    tx.add(ix);
  }
  tx.feePayer = payer.publicKey;

  try {
    // Handle MagicBlock Router connections
    if (connection instanceof ConnectionMagicRouter) {
      const { blockhash, lastValidBlockHeight } = await getRouterBlockhash(connection, tx);
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.sign(payer, ...extraSigners);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      console.log(`✅ ${label} (ER Router): ${sig}`);
      return sig;
    }

    // Handle TEE connections
    if (connection._isTeeConnection) {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(payer, ...extraSigners);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      console.log(`✅ ${label} (TEE): ${sig}`);
      return sig;
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(payer, ...extraSigners);
    const rawTx = tx.serialize();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    const confirmation = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    console.log(`✅ ${label}: ${sig}`);
    return sig;
  } catch (err) {
    if (err && typeof err.getLogs === 'function') {
      try {
        const logs = await err.getLogs();
        if (logs && logs.length) {
          console.error(`❌ ${label} logs:\n${logs.join('\n')}`);
        }
      } catch (logErr) {}
    }
    throw err;
  }
}

function getWritableAccounts(transaction) {
  const writableAccounts = new Set();
  if (transaction.feePayer) writableAccounts.add(transaction.feePayer.toBase58());
  for (const instruction of transaction.instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) writableAccounts.add(key.pubkey.toBase58());
    }
  }
  return Array.from(writableAccounts);
}

async function getRouterBlockhash(connection, transaction) {
  const endpoint = connection.rpcEndpoint || connection._rpcEndpoint;
  const writableAccounts = getWritableAccounts(transaction);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlockhashForAccounts',
      params: [writableAccounts],
    }),
  });
  const payload = await response.json();
  const result = payload?.result;
  const value = result?.value ?? result;
  if (!value || !value.blockhash) {
    throw new Error(`Router blockhash missing: ${JSON.stringify(payload)}`);
  }
  return value;
}

function parseMasterVaultV4(data) {
  if (!data || data.length < 160) return null;
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    vaultTokenAccount: new PublicKey(data.subarray(40, 72)),
    mint: new PublicKey(data.subarray(72, 104)),
  };
}

function parseEmployeeV4(data) {
  if (!data || data.length < 180) return null;
  return {
    encryptedEmployeeIdHandle: data.subarray(48, 80),
    lastSettleTime: Number(data.readBigInt64LE(152)),
    lastAccrualTime: Number(data.readBigInt64LE(144)),
  };
}

function parseWithdrawRequestV4(data) {
  if (!data || data.length < 122) return null;
  return {
    isPending: data[88] === 1,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Emulate user token account creation (simulates TS client linkUserTokenAccountV4)
async function getOrCreateUserRegistryIncoToken(connection, employee, registryPda, programId, mint, incoTokenProgramId, incoLightningId) {
    const info = await connection.getAccountInfo(registryPda, 'confirmed');
    if (info) {
        return new PublicKey(info.data.subarray(40, 72));
    }

    const tokenKeypair = Keypair.generate();
    
    // Create Inco Token (key order must match: token, mint, owner, payer, system, incoLightning)
    console.log("  DEBUG createIncoToken:");
    console.log("    token:", tokenKeypair.publicKey.toBase58());
    console.log("    mint:", mint.toBase58());
    console.log("    owner:", employee.publicKey.toBase58());
    console.log("    payer:", employee.publicKey.toBase58());
    console.log("    incoTokenProgramId:", incoTokenProgramId.toBase58());
    const createIx = new TransactionInstruction({
        programId: incoTokenProgramId,
        keys: [
          { pubkey: tokenKeypair.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: employee.publicKey, isSigner: false, isWritable: false },
          { pubkey: employee.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: incoLightningId, isSigner: false, isWritable: false }
        ],
        data: Buffer.concat([INCO_INIT_ACCOUNT_DISCRIMINATOR])
    });

    // Init registry (needs: owner, user_token_account_v4, mint, inco_lightning_program, system_program)
    const initIx = new TransactionInstruction({
        programId: programId,
        keys: [
            { pubkey: employee.publicKey, isSigner: true, isWritable: true },
            { pubkey: registryPda, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: incoLightningId, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        data: Buffer.concat([discriminator("init_user_token_account_v4")])
    });

    // Link registry (needs: owner, user_token_account_v4, inco_token_account, inco_lightning_program, system_program)
    // Data: discriminator + encrypted_balance: Vec<u8> (we pass empty vec = 4 bytes of 0 for length)
    const emptyVecBuf = Buffer.alloc(4); // u32 length = 0
    const linkIx = new TransactionInstruction({
        programId: programId,
        keys: [
            { pubkey: employee.publicKey, isSigner: true, isWritable: true },
            { pubkey: registryPda, isSigner: false, isWritable: true },
            { pubkey: tokenKeypair.publicKey, isSigner: false, isWritable: true },
            { pubkey: incoLightningId, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([discriminator("link_user_token_account_v4"), emptyVecBuf])
    });

    await sendIx(connection, employee, [createIx, initIx, linkIx], [tokenKeypair], "create_and_link_user_registry");
    return tokenKeypair.publicKey;
}


async function main() {
  const rpcUrl = envString('RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  const programId = envPublicKey('PAYROLL_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const delegationProgramId = envPublicKey(
    'MAGICBLOCK_DELEGATION_PROGRAM',
    process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM || 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
  );
  const permissionProgramId = envPublicKey(
    'MAGICBLOCK_PERMISSION_PROGRAM',
    process.env.NEXT_PUBLIC_MAGICBLOCK_PERMISSION_PROGRAM || 'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1'
  );
  const magicProgramId = envPublicKey(
    'MAGICBLOCK_MAGIC_PROGRAM',
    process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM || 'Magic11111111111111111111111111111111111111'
  );
  const magicContextId = envPublicKey(
    'MAGICBLOCK_MAGIC_CONTEXT',
    process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT || 'MagicContext1111111111111111111111111111111'
  );
  
  const useTee = (process.env.USE_TEE || '').toLowerCase() === 'true' || (process.env.USE_TEE || '') === '1';
  const teeValidator = envPublicKey(
    'MAGICBLOCK_VALIDATOR',
    process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 
    (useTee ? 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA' : 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e')
  );

  const incoLightningId = envPublicKey('INCO_LIGHTNING_ID', process.env.NEXT_PUBLIC_INCO_PROGRAM_ID);
  const incoTokenProgramId = envPublicKey('INCO_TOKEN_PROGRAM_ID', process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID);
  const payusdMint = envPublicKey('PAYUSD_MINT', process.env.NEXT_PUBLIC_PAYUSD_MINT);
  
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

  // Setup ER connection for the commit step
  const teeUrl = (process.env.TEE_URL || process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL || 'https://tee.magicblock.app').trim();
  const useTeeEnv = (process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED || '').toLowerCase() === 'true';
  let erConnection;
  if (useTee || useTeeEnv) {
    console.log('🔐 TEE mode: generating auth token for employee...');
    const token = await generateTeeToken(teeUrl, employee);
    if (token) {
      const teeWithToken = withTeeToken(teeUrl, token);
      erConnection = new Connection(teeWithToken, 'confirmed');
      erConnection._isTeeConnection = true;
    } else {
      console.warn('⚠️ Falling back to MagicBlock Router (no TEE)');
      const routerUrl = (process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app').trim();
      erConnection = new ConnectionMagicRouter(routerUrl);
    }
  } else {
    const routerUrl = (process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app').trim();
    erConnection = new ConnectionMagicRouter(routerUrl);
  }

  const masterVault = deriveMasterVaultV4Pda(programId);
  const businessPda = deriveBusinessV4Pda(masterVault, businessIndex, programId);
  const employeePda = deriveEmployeeV4Pda(businessPda, employeeIndex, programId);
  const streamConfigPda = deriveStreamConfigV4Pda(businessPda, programId);
  const withdrawRequestPda = deriveWithdrawRequestV4Pda(businessPda, employeeIndex, programId);

  const [permissionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), employeePda.toBuffer()],
    permissionProgramId
  );
  const bufferPda = deriveBufferPda(employeePda, programId);
  const delegationRecord = deriveDelegationRecordPda(employeePda, delegationProgramId);
  const delegationMetadata = deriveDelegationMetadataPda(employeePda, delegationProgramId);
  const permissionBufferPda = derivePermissionBufferPda(permissionPda, permissionProgramId);
  const permissionDelegationRecord = deriveDelegationRecordPda(permissionPda, delegationProgramId);
  const permissionDelegationMetadata = deriveDelegationMetadataPda(permissionPda, delegationProgramId);

  // 1. Get Accounts
  console.log('Fetching accounts...');
  const masterInfo = await connection.getAccountInfo(masterVault, 'confirmed');
  if (!masterInfo) throw new Error('Master vault v4 not found');
  const masterParsed = parseMasterVaultV4(masterInfo.data);
  const authority = masterParsed.authority;
  // Use env-based mint since master vault may not store it in all layouts
  const mint = payusdMint;
  // Get vault token account from state file if master vault doesn't have it
  const vaultTokenAccount = masterParsed.vaultTokenAccount.equals(SystemProgram.programId)
    ? (state.poolVaultTokenAccount ? new PublicKey(state.poolVaultTokenAccount) : (() => { throw new Error('No vault token account found'); })())
    : masterParsed.vaultTokenAccount;


  const employeeInfo = await connection.getAccountInfo(employeePda, 'confirmed');
  if (!employeeInfo) throw new Error('Employee v4 account not found');
  const employeeParsed = parseEmployeeV4(employeeInfo.data);
  const isDelegated = employeeInfo.owner.equals(delegationProgramId);

  // 2. Resolve Allowances & Tokens
  const handleU128 = u128FromBytesLE(employeeParsed.encryptedEmployeeIdHandle.subarray(0, 16));
  const allowancePda = deriveAllowancePda(handleU128, employee.publicKey, incoLightningId);
  const allowanceInfo = await connection.getAccountInfo(allowancePda, 'confirmed');
  
  if (!allowanceInfo) {
    console.log("Creating employee ID Handle allowance...");
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
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        INCO_ALLOW_DISCRIMINATOR,
        handleBuf,
        Buffer.from([1]),
        employee.publicKey.toBuffer(),
      ]),
    });
    await sendIx(connection, employee, [allowIx], [], 'inco_allow');
  }

  const destinationRegistryPda = PublicKey.findProgramAddressSync(
      [Buffer.from('user_token_v4'), employee.publicKey.toBuffer(), mint.toBuffer()],
      programId
  )[0];
  console.log("Resolving employee destination token account...");
  const destinationToken = await getOrCreateUserRegistryIncoToken(
      connection, 
      employee, 
      destinationRegistryPda, 
      programId, 
      mint, 
      incoTokenProgramId, 
      incoLightningId
  );


  // 3. Request & Commit Stream
  console.log('\n--- Step 1: Request & Commit ---');
  let withdrawRequested = false;
  const existingRequest = await connection.getAccountInfo(withdrawRequestPda, 'confirmed');
  
  if (!existingRequest || !parseWithdrawRequestV4(existingRequest.data)?.isPending) {
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

    const commitIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: employee.publicKey, isSigner: true, isWritable: true },
          { pubkey: masterVault, isSigner: false, isWritable: false },
          { pubkey: businessPda, isSigner: false, isWritable: false },
          { pubkey: streamConfigPda, isSigner: false, isWritable: false },
          { pubkey: employeePda, isSigner: false, isWritable: true },
          { pubkey: permissionPda, isSigner: false, isWritable: true },
          { pubkey: permissionProgramId, isSigner: false, isWritable: false },
          { pubkey: authority, isSigner: false, isWritable: false }, 
          { pubkey: magicProgramId, isSigner: false, isWritable: false },
          { pubkey: magicContextId, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([discriminator('commit_and_undelegate_stream_v4'), u64LE(employeeIndex)]),
    });

    // Send request + commit through the ER connection (the permission PDA lives on the ER)
    console.log("Sending bundled Request Withdraw & Commit/Undelegate via ER...");
    await sendIx(erConnection, employee, [requestIx, commitIx], [], 'request_and_commit');
    withdrawRequested = true;
  } else {
    console.log("Withdraw request already exists and is pending.");
  }

  // Wait for it to fall back to the base layer
  console.log('\n--- Step 2: Transition to Base Layer ---');
  let ready = false;
  process.stdout.write("Waiting for Ephemeral Rollup sync...");
  for (let i = 0; i < 20; i += 1) {
    const info = await connection.getAccountInfo(employeePda, 'confirmed');
    if (info && info.owner.equals(programId)) {
      ready = true;
      break;
    }
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log();
  if (!ready) {
    throw new Error('Employee did not return to the Solana base layer. Is MagicBlock validator running?');
  }
  console.log("Employee stream is successfully undelegated on the base layer.");


  // 4. Full Withdrawal (Process + Claim + Redelegate)
  console.log('\n--- Step 3: Execute Full Withdrawal ---');
  
  const payoutNonce = Math.floor(Date.now() / 1000);
  const payoutPda = deriveShieldedPayoutV4Pda(businessPda, employeeIndex, payoutNonce, programId);
  const payoutTokenKeypair = Keypair.generate();
  
  const initPayoutTokenIx = new TransactionInstruction({
    programId: incoTokenProgramId,
    keys: [
      { pubkey: payoutTokenKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: payoutPda, isSigner: false, isWritable: false },
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([INCO_INIT_ACCOUNT_DISCRIMINATOR]),
  });

  const processIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: true },
      { pubkey: businessPda, isSigner: false, isWritable: true },
      { pubkey: streamConfigPda, isSigner: false, isWritable: true },
      { pubkey: employeePda, isSigner: false, isWritable: true },
      { pubkey: withdrawRequestPda, isSigner: false, isWritable: true },
      { pubkey: payoutPda, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payoutTokenKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('process_withdraw_request_v4'), u64LE(employeeIndex), u64LE(payoutNonce)]),
  });

  const claimIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: payoutPda, isSigner: false, isWritable: true },
      { pubkey: payoutTokenKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: destinationToken, isSigner: false, isWritable: true },
      { pubkey: allowancePda, isSigner: false, isWritable: false },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('claim_payout_v4'), u64LE(employeeIndex), u64LE(payoutNonce)]),
  });

  const redelegateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: employee.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
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
      { pubkey: authority, isSigner: false, isWritable: false }, // authority
      { pubkey: teeValidator, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('redelegate_stream_v4'), u64LE(employeeIndex)]),
  });

  console.log("Executing bundled Init Payout + Process + Claim + Redelegate...");
  
  await sendIx(
      connection, 
      employee, 
      [initPayoutTokenIx, processIx, claimIx, redelegateIx], 
      [payoutTokenKeypair], 
      'execute_full_withdrawal'
  );

  console.log('\n🎉 Successfully completed keeper-free autonomous withdrawal.');
}

main().catch((err) => {
  console.error('\nv4-keeper-free-withdraw failed:', err);
  process.exit(1);
});
