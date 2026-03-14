#!/usr/bin/env node

/**
 * End-to-end v4 withdraw flow (manual keeper) for devnet.
 *
 * Steps:
 * 1) Ensure Inco allowance for employee ID handle.
 * 2) Request withdraw (employee signer).
 * 3) Accrue (keeper signer) to satisfy freshness guard.
 * 4) Create payout token account (owned by payout PDA).
 * 5) Process withdraw (keeper signer).
 * 6) Claim payout (employee signer) to destination token account.
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

function withTeeToken(url, token) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

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

  try {
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
    console.log(`${label}: ${sig}`);
    return sig;
  } catch (err) {
    if (err && typeof err.getLogs === 'function') {
      try {
        const logs = await err.getLogs();
        if (logs && logs.length) {
          console.error(`${label} logs:\n${logs.join('\n')}`);
        }
      } catch (logErr) {
        // Log fetching might fail on some RPCs
      }
    }
    throw err;
  }
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
    data: Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]),
  });
  const txid = await sendIx(connection, payer, ix, [tokenKeypair], `${label}_create_token_account`);
  return { txid, tokenAccount: tokenKeypair.publicKey };
}

function parseMasterVaultV4(data) {
  if (!data || data.length < 160) return null;
  return {
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

function parseStreamConfigV4(data) {
  if (!data || data.length < 90) return null;
  return {
    settleIntervalSecs: Number(data.readBigUInt64LE(72)),
    isPaused: data[80] === 1,
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

async function main() {
  const rpcUrl = envString('RPC_URL', process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  const commitRpcUrl = resolveRouterUrl(
    process.env.COMMIT_RPC_URL ||
      process.env.MAGICBLOCK_ROUTER_RPC_URL ||
      process.env.KEEPER_ROUTER_RPC_URL ||
      'https://devnet-router.magicblock.app'
  );
  const teeUrl =
    (process.env.TEE_URL || process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_URL || 'https://tee.magicblock.app').trim();
  const employeeTeeToken = (process.env.TEE_TOKEN_EMPLOYEE || '').trim();
  const keeperTeeToken = (process.env.TEE_TOKEN_KEEPER || '').trim();
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
  const validator = envPublicKey(
    'MAGICBLOCK_VALIDATOR',
    process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 
    (useTee ? 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA' : 'MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e')
  );
  const incoLightningId = envPublicKey('INCO_LIGHTNING_ID', process.env.NEXT_PUBLIC_INCO_PROGRAM_ID);
  const incoTokenProgramId = envPublicKey('INCO_TOKEN_PROGRAM_ID', process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID);
  const mintEnv = (process.env.PAYUSD_MINT || process.env.NEXT_PUBLIC_PAYUSD_MINT || '').trim();
  const mintFromEnv = mintEnv ? new PublicKey(mintEnv) : null;
  const keeperKeypairPath = envString('KEEPER_KEYPAIR_PATH', 'keys/payroll-authority.json');
  const employeeKeypairPath = envString(
    'EMPLOYEE_KEYPAIR_PATH',
    path.join(__dirname, '..', '..', 'services', 'keeper', 'demo-employee-keypair.json')
  );
  const flowMode = (process.env.FLOW_MODE || '').toLowerCase();
  const keeperOnly = flowMode === 'keeper' || (process.env.KEEPER_ONLY || '').toLowerCase() === 'true';
  const skipRequest = keeperOnly || (process.env.SKIP_REQUEST_WITHDRAW || '').toLowerCase() === 'true';
  const skipClaim = keeperOnly || (process.env.SKIP_CLAIM || '').toLowerCase() === 'true';
  const skipAllowance = keeperOnly || (process.env.SKIP_ALLOWANCE || '').toLowerCase() === 'true';
  const needsEmployee = !skipRequest || !skipClaim || !skipAllowance;

  const repoRoot = path.resolve(__dirname, '..', '..');
  const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};

  const businessIndex = Number(process.env.BUSINESS_INDEX || state.businessIndex || 0);
  const employeeIndex = Number(process.env.EMPLOYEE_INDEX || state.employeeIndex || 0);
  if (!Number.isFinite(businessIndex) || !Number.isFinite(employeeIndex)) {
    throw new Error('BUSINESS_INDEX and EMPLOYEE_INDEX must be numbers');
  }

  const readConnection = new Connection(rpcUrl, 'confirmed');
  const keeper = loadKeypairFromPath(keeperKeypairPath);
  const employee = needsEmployee ? loadKeypairFromPath(employeeKeypairPath) : null;
  const doRedelegate =
    (process.env.REDELEGATE_AFTER_WITHDRAW || 'true').toLowerCase() !== 'false';

  // Auto-generate TEE tokens if USE_TEE is set and no manual tokens provided
  let effectiveKeeperToken = keeperTeeToken;
  let effectiveEmployeeToken = employeeTeeToken;
  if (useTee) {
    console.log('🔐 TEE mode enabled, generating auth tokens...');
    if (!effectiveKeeperToken) {
      effectiveKeeperToken = await generateTeeToken(teeUrl, keeper) || '';
    }
    if (needsEmployee && !effectiveEmployeeToken) {
      effectiveEmployeeToken = await generateTeeToken(teeUrl, employee) || '';
    }
    if (!effectiveKeeperToken) {
      throw new Error('TEE token required for keeper connection');
    }
    if (needsEmployee && !effectiveEmployeeToken) {
      throw new Error('TEE token required for employee connection');
    }
  }

  const employeeConnection = needsEmployee
    ? effectiveEmployeeToken
      ? new Connection(withTeeToken(teeUrl, effectiveEmployeeToken), 'confirmed')
      : readConnection
    : readConnection;
  const keeperConnection = effectiveKeeperToken
    ? new Connection(withTeeToken(teeUrl, effectiveKeeperToken), 'confirmed')
    : readConnection;
  const commitConnection = useTee
    ? new Connection(withTeeToken(teeUrl, effectiveKeeperToken), 'confirmed')
    : new ConnectionMagicRouter(commitRpcUrl);

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

  const employeeInfo = await readConnection.getAccountInfo(employeePda, 'confirmed');
  if (!employeeInfo) throw new Error('Employee v4 account not found');
  const employeeParsed = parseEmployeeV4(employeeInfo.data);
  if (!employeeParsed) throw new Error('Unable to parse employee v4 data');
  const isDelegated = employeeInfo.owner.equals(delegationProgramId);

  const masterInfo = await readConnection.getAccountInfo(masterVault, 'confirmed');
  if (!masterInfo) throw new Error('Master vault v4 not found');
  const masterParsed = parseMasterVaultV4(masterInfo.data);
  if (!masterParsed) throw new Error('Unable to parse master vault v4');

  let allowancePda = null;
  if (needsEmployee) {
    if (!employee) {
      throw new Error('EMPLOYEE_KEYPAIR_PATH required for this flow.');
    }
    const handleU128 = u128FromBytesLE(employeeParsed.encryptedEmployeeIdHandle.subarray(0, 16));
    allowancePda = deriveAllowancePda(handleU128, employee.publicKey, incoLightningId);
    if (!skipAllowance) {
      const handleBuf = Buffer.alloc(16);
      let h = BigInt(handleU128);
      for (let i = 0; i < 16; i += 1) {
        handleBuf[i] = Number(h & 0xffn);
        h >>= 8n;
      }
      const allowanceInfo = await readConnection.getAccountInfo(allowancePda, 'confirmed');
      if (!allowanceInfo) {
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
        await sendIx(readConnection, employee, allowIx, [], 'inco_allow_employee_id');
      } else {
        console.log('allowance: already exists');
      }
    }
  }

  const existingRequest = await readConnection.getAccountInfo(withdrawRequestPda, 'confirmed');
  if (!existingRequest) {
    if (skipRequest) {
      throw new Error('Withdraw request not found. Ask the employee to request a withdraw first.');
    }
    if (!employee || !allowancePda) {
      throw new Error('Employee keypair + allowance are required to request withdraw.');
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
    await sendIx(readConnection, employee, requestIx, [], 'request_withdraw_v4');
  } else {
    const parsed = parseWithdrawRequestV4(existingRequest.data);
    if (parsed && !parsed.isPending) {
      throw new Error('Withdraw request already processed. Use a new employee index or recreate employee.');
    }
    console.log('withdraw_request_v4: already exists');
  }

  const configInfo = await readConnection.getAccountInfo(streamConfigPda, 'confirmed');
  if (!configInfo) throw new Error('Stream config v4 not found');
  const configParsed = parseStreamConfigV4(configInfo.data);
  if (!configParsed) throw new Error('Unable to parse stream config');
  if (configParsed.isPaused) throw new Error('Stream config is paused');

  const now = Math.floor(Date.now() / 1000);
  const elapsedSinceSettle = now - employeeParsed.lastSettleTime;
  if (elapsedSinceSettle < configParsed.settleIntervalSecs) {
    const waitMs = (configParsed.settleIntervalSecs - elapsedSinceSettle + 1) * 1000;
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s to satisfy settle interval...`);
    await sleep(waitMs);
  }

  const accrueIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: false },
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: false },
      { pubkey: employeePda, isSigner: false, isWritable: true },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('accrue_v4'), u64LE(employeeIndex)]),
  });
  await sendIx(keeperConnection, keeper, accrueIx, [], 'accrue_v4');

  if (isDelegated) {
    const commitIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVault, isSigner: false, isWritable: false },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: false },
        { pubkey: employeePda, isSigner: false, isWritable: true },
        { pubkey: permissionPda, isSigner: false, isWritable: true },
        { pubkey: permissionProgramId, isSigner: false, isWritable: false },
        { pubkey: keeper.publicKey, isSigner: false, isWritable: false }, // authority
        { pubkey: magicProgramId, isSigner: false, isWritable: false },
        { pubkey: magicContextId, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([discriminator('commit_and_undelegate_stream_v4'), u64LE(employeeIndex)]),
    });
    await sendIx(commitConnection, keeper, commitIx, [], 'commit_and_undelegate_stream_v4');

    let ready = false;
    for (let i = 0; i < 15; i += 1) {
      const info = await readConnection.getAccountInfo(employeePda, 'confirmed');
      if (info && info.owner.equals(programId)) {
        ready = true;
        break;
      }
      await sleep(2000);
    }
    if (!ready) {
      throw new Error('Employee v4 did not return to base layer after commit');
    }
  }

  const mint = mintFromEnv || masterParsed.mint;
  if (!mint.equals(masterParsed.mint)) {
    throw new Error(
      `PAYUSD_MINT mismatch: master vault uses ${masterParsed.mint.toBase58()} but PAYUSD_MINT=${mint.toBase58()}`
    );
  }
  const vaultTokenAccount = masterParsed.vaultTokenAccount;

  const nonce = Math.floor(Date.now() / 1000);
  const payoutPda = deriveShieldedPayoutV4Pda(businessPda, employeeIndex, nonce, programId);
  const { tokenAccount: payoutTokenAccount } = await createIncoTokenAccount(
    readConnection,
    keeper,
    incoTokenProgramId,
    mint,
    payoutPda,
    incoLightningId,
    'payout'
  );

  const processIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: masterVault, isSigner: false, isWritable: true },
      { pubkey: businessPda, isSigner: false, isWritable: true },
      { pubkey: streamConfigPda, isSigner: false, isWritable: true },
      { pubkey: employeePda, isSigner: false, isWritable: true },
      { pubkey: withdrawRequestPda, isSigner: false, isWritable: true },
      { pubkey: payoutPda, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
      { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('process_withdraw_request_v4'), u64LE(employeeIndex), u64LE(nonce)]),
  });
  await sendIx(readConnection, keeper, processIx, [], 'process_withdraw_request_v4');

  let claimerTokenAccount = null;
  if (!skipClaim) {
    if (!employee || !allowancePda) {
      throw new Error('Employee keypair + allowance are required to claim payout.');
    }
    const created = await createIncoTokenAccount(
      readConnection,
      employee,
      incoTokenProgramId,
      mint,
      employee.publicKey,
      incoLightningId,
      'claimer'
    );
    claimerTokenAccount = created.tokenAccount;

    const claimIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: employee.publicKey, isSigner: true, isWritable: true },
        { pubkey: masterVault, isSigner: false, isWritable: false },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: payoutPda, isSigner: false, isWritable: true },
        { pubkey: payoutTokenAccount, isSigner: false, isWritable: true },
        { pubkey: claimerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: allowancePda, isSigner: false, isWritable: false },
        { pubkey: incoTokenProgramId, isSigner: false, isWritable: false },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator('claim_payout_v4'), u64LE(employeeIndex), u64LE(nonce)]),
    });
    await sendIx(readConnection, employee, claimIx, [], 'claim_payout_v4');
  }

  if (isDelegated && doRedelegate) {
    const redelegateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
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
        { pubkey: keeper.publicKey, isSigner: false, isWritable: false }, // authority
        { pubkey: validator, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: programId, isSigner: false, isWritable: false },
        { pubkey: delegationProgramId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator('redelegate_stream_v4'), u64LE(employeeIndex)]),
    });
    await sendIx(readConnection, keeper, redelegateIx, [], 'redelegate_stream_v4');
  }

  const nextState = {
    ...state,
    payoutNonce: nonce,
    payoutPda: payoutPda.toBase58(),
    payoutTokenAccount: payoutTokenAccount.toBase58(),
  };
  if (claimerTokenAccount) {
    nextState.claimerTokenAccount = claimerTokenAccount.toBase58();
    nextState.destinationTokenAccount = claimerTokenAccount.toBase58();
  } else {
    if (state.claimerTokenAccount) nextState.claimerTokenAccount = state.claimerTokenAccount;
    if (state.destinationTokenAccount) nextState.destinationTokenAccount = state.destinationTokenAccount;
  }
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n');

  console.log('v4 withdraw flow complete');
  console.log('nonce:', nonce);
  console.log('payout_pda:', payoutPda.toBase58());
  console.log('payout_token_account:', payoutTokenAccount.toBase58());
  if (claimerTokenAccount) {
    console.log('claimer_token_account:', claimerTokenAccount.toBase58());
  }
}

main().catch((err) => {
  console.error('v4-withdraw-flow failed:', err);
  process.exit(1);
});
