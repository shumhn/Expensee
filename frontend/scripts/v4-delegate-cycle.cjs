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
    console.warn(`⚠️  TEE token generation failed for ${keypair.publicKey.toBase58().slice(0, 8)}...: ${err.message}`);
    return null;
  }
}

function createTeeConnection(teeUrl, token) {
  const url = token ? `${teeUrl}?token=${token}` : teeUrl;
  return new Connection(url, 'confirmed');
}

function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const SEEDS = {
  master_vault_v4b: Buffer.from('master_vault_v4b'),
  business_v4: Buffer.from('business_v4'),
  stream_config_v4: Buffer.from('stream_config_v4'),
  employee_v4: Buffer.from('employee_v4'),
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

function resolveRouterUrl(rawUrl) {
  const value = (rawUrl || '').trim();
  if (!value) return 'https://devnet-router.magicblock.app';
  const lower = value.toLowerCase();
  if (lower.includes('tee.magicblock.app')) {
    console.warn(`⚠️  ${value} is a TEE endpoint, not a router. Falling back to https://devnet-router.magicblock.app`);
    return 'https://devnet-router.magicblock.app';
  }
  if (lower.includes('magicblock') || lower.includes('router') || lower.includes('localhost') || lower.includes('127.0.0.1')) {
    return value;
  }
  console.warn(`⚠️  ${value} does not look like a MagicBlock router endpoint. Falling back to https://devnet-router.magicblock.app`);
  return 'https://devnet-router.magicblock.app';
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

function deriveMasterVaultV4Pda(programId) {
  return PublicKey.findProgramAddressSync([SEEDS.master_vault_v4b], programId)[0];
}

function deriveBusinessV4Pda(masterVault, businessIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.business_v4, masterVault.toBuffer(), u64LE(businessIndex)],
    programId
  )[0];
}

function deriveStreamConfigV4Pda(business, programId) {
  return PublicKey.findProgramAddressSync([SEEDS.stream_config_v4, business.toBuffer()], programId)[0];
}

function deriveEmployeeV4Pda(business, employeeIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.employee_v4, business.toBuffer(), u64LE(employeeIndex)],
    programId
  )[0];
}

function deriveBufferPda(employee, programId) {
  return PublicKey.findProgramAddressSync([SEEDS.buffer, employee.toBuffer()], programId)[0];
}

function derivePermissionBufferPda(permission, permissionProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.buffer, permission.toBuffer()], permissionProgramId)[0];
}

function deriveDelegationRecordPda(employee, delegationProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.delegation, employee.toBuffer()], delegationProgramId)[0];
}

function deriveDelegationMetadataPda(employee, delegationProgramId) {
  return PublicKey.findProgramAddressSync([SEEDS.delegation_metadata, employee.toBuffer()], delegationProgramId)[0];
}

function getWritableAccounts(transaction) {
  const writableAccounts = new Set();
  if (transaction.feePayer) {
    writableAccounts.add(transaction.feePayer.toBase58());
  }
  for (const instruction of transaction.instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) {
        writableAccounts.add(key.pubkey.toBase58());
      }
    }
  }
  return Array.from(writableAccounts);
}

async function getRouterBlockhash(connection, transaction) {
  const writableAccounts = getWritableAccounts(transaction);
  const response = await fetch(connection.rpcEndpoint, {
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

async function sendIx(connection, payer, instruction, extraSigners = [], label = 'tx') {
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;

  if (connection instanceof ConnectionMagicRouter) {
    const { blockhash, lastValidBlockHeight } = await getRouterBlockhash(connection, tx);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.sign(payer, ...extraSigners);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`${label}: ${sig}`);
    return sig;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`${label}: ${sig}`);
  return sig;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const validator = envPublicKey(
    'MAGICBLOCK_VALIDATOR',
    process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 
    (useTee ? 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA' : 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e')
  );

  const payerPath = envString(
    'PAYER_KEYPAIR_PATH',
    process.env.KEEPER_KEYPAIR_PATH || process.env.SOLANA_KEYPAIR_PATH || path.join(os.homedir(), '.config/solana/id.json')
  );

  const repoRoot = path.resolve(__dirname, '..', '..');
  const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');
  const state = readJson(statePath, {});
  const businessIndex = Number(process.env.BUSINESS_INDEX || state.businessIndex || 0);
  const employeeIndex = Number(process.env.EMPLOYEE_INDEX || state.employeeIndex || 0);
  const employeeWallet = envPublicKey('EMPLOYEE_WALLET', state.employeeWallet || '');
  if (!Number.isFinite(businessIndex) || !Number.isFinite(employeeIndex)) {
    throw new Error('BUSINESS_INDEX and EMPLOYEE_INDEX must be numbers');
  }

  const commitRpcUrl = resolveRouterUrl(
    process.env.COMMIT_RPC_URL ||
      process.env.MAGICBLOCK_ROUTER_RPC_URL ||
      process.env.KEEPER_ROUTER_RPC_URL ||
      'https://devnet-router.magicblock.app'
  );
  const teeRpcUrl = (process.env.TEE_RPC_URL ||
    process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL ||
    'https://tee.magicblock.app').trim();
  const keeperTeeToken = (process.env.TEE_TOKEN_KEEPER || '').trim();
  const useTee = (process.env.USE_TEE || '').toLowerCase() === 'true' || (process.env.USE_TEE || '') === '1';

  const connection = new Connection(rpcUrl, 'confirmed');
  const skipCommit = (process.env.SKIP_COMMIT || '').toLowerCase() === 'true' || (process.env.SKIP_COMMIT || '') === '1';
  const doRedelegate = !((process.env.REDELEGATE_AFTER_COMMIT || '').toLowerCase() === 'false' || (process.env.REDELEGATE_AFTER_COMMIT || '') === '0');
  const payer = loadKeypairFromPath(payerPath);

  let commitConnection = null;
  if (useTee) {
    console.log(`🔐 TEE mode enabled (Node: ${validator.toBase58().slice(0, 8)}...)`);
    let effectiveToken = keeperTeeToken;
    if (!effectiveToken) {
      effectiveToken = await generateTeeToken(teeRpcUrl, payer) || '';
    }
    if (!effectiveToken) {
      throw new Error('TEE token required for commit/undelegate on TEE endpoint');
    }
    commitConnection = createTeeConnection(teeRpcUrl, effectiveToken);
    console.log('✅ Keeper TEE token acquired (commit/undelegate via TEE)');
  } else {
    // ER (non-TEE) uses MagicBlock Router.
    commitConnection = new ConnectionMagicRouter(commitRpcUrl);
  }

  const masterVault = deriveMasterVaultV4Pda(programId);
  const business = deriveBusinessV4Pda(masterVault, businessIndex, programId);
  const streamConfig = deriveStreamConfigV4Pda(business, programId);
  const employee = deriveEmployeeV4Pda(business, employeeIndex, programId);

  const employeeInfo = await connection.getAccountInfo(employee, 'confirmed');
  if (!employeeInfo) {
    throw new Error('Employee v4 account not found');
  }
  const alreadyDelegated = employeeInfo.owner.equals(delegationProgramId);

  const bufferPda = deriveBufferPda(employee, programId);
  const delegationRecord = deriveDelegationRecordPda(employee, delegationProgramId);
  const delegationMetadata = deriveDelegationMetadataPda(employee, delegationProgramId);
  const [permissionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), employee.toBuffer()],
    permissionProgramId
  );
  const permissionBufferPda = derivePermissionBufferPda(permissionPda, permissionProgramId);
  const permissionDelegationRecord = deriveDelegationRecordPda(permissionPda, delegationProgramId);
  const permissionDelegationMetadata = deriveDelegationMetadataPda(permissionPda, delegationProgramId);

  const employeeIndexBuf = u64LE(employeeIndex);

  const delegateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: business, isSigner: false, isWritable: false },
      { pubkey: streamConfig, isSigner: false, isWritable: false },
      { pubkey: bufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },
      { pubkey: employee, isSigner: false, isWritable: true },
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
    data: Buffer.concat([discriminator('delegate_stream_v4'), employeeIndexBuf]),
  });

  const commitIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: business, isSigner: false, isWritable: false },
      { pubkey: streamConfig, isSigner: false, isWritable: false },
      { pubkey: employee, isSigner: false, isWritable: true },
      { pubkey: permissionPda, isSigner: false, isWritable: true },
      { pubkey: permissionProgramId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // authority
      { pubkey: magicProgramId, isSigner: false, isWritable: false },
      { pubkey: magicContextId, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([discriminator('commit_and_undelegate_stream_v4'), employeeIndexBuf]),
  });

  const redelegateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: business, isSigner: false, isWritable: false },
      { pubkey: streamConfig, isSigner: false, isWritable: false },
      { pubkey: bufferPda, isSigner: false, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },
      { pubkey: employee, isSigner: false, isWritable: true },
      { pubkey: permissionBufferPda, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationRecord, isSigner: false, isWritable: true },
      { pubkey: permissionDelegationMetadata, isSigner: false, isWritable: true },
      { pubkey: permissionPda, isSigner: false, isWritable: true },
      { pubkey: permissionProgramId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // authority
      { pubkey: validator, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: delegationProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('redelegate_stream_v4'), employeeIndexBuf]),
  });

  console.log('delegate_stream_v4...');
  if (!alreadyDelegated) {
    await sendIx(connection, payer, delegateIx, [], 'delegate_stream_v4');
  } else {
    console.log('delegate_stream_v4: already delegated, skipping');
  }

  console.log('commit_and_undelegate_stream_v4...');
  if (!skipCommit) {
    await sendIx(commitConnection, payer, commitIx, [], 'commit_and_undelegate_stream_v4');
  } else {
    console.log('commit_and_undelegate_stream_v4: skipped (SKIP_COMMIT=true)');
  }

  if (doRedelegate && !skipCommit) {
    console.log('redelegate_stream_v4...');
    let ready = false;
    for (let i = 0; i < 15; i += 1) {
      const info = await connection.getAccountInfo(employee, 'confirmed');
      if (info && info.owner.equals(programId)) {
        ready = true;
        break;
      }
      await sleep(2000);
    }
    if (!ready) {
      console.log('redelegate_stream_v4: employee still delegated; skipping');
    } else {
      await sendIx(connection, payer, redelegateIx, [], 'redelegate_stream_v4');
    }
  } else if (doRedelegate && skipCommit) {
    console.log('redelegate_stream_v4: skipped because commit was skipped');
  }

  console.log('done');
}

main().catch((err) => {
  console.error('v4-delegate-cycle failed:', err);
  process.exit(1);
});
