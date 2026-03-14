#!/usr/bin/env node
/**
 * v4-crank-e2e.cjs — End-to-end CLI test for MagicBlock Native Cranks
 *
 * This script:
 *   1. Delegates the employee account to the ER (if not already delegated)
 *   2. Sends schedule_crank_v4 to the ER endpoint
 *   3. Monitors the employee account on the ER for data mutations (proving the crank runs)
 *
 * Usage:
 *   node scripts/v4-crank-e2e.cjs
 *
 * Env vars (all have sane defaults from .env.local / devnet-v4-state.json):
 *   RPC_URL, PAYROLL_PROGRAM_ID, BUSINESS_INDEX, EMPLOYEE_INDEX,
 *   PAYER_KEYPAIR_PATH, MAGICBLOCK_ROUTER_RPC_URL
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const { getAuthToken } = require('@magicblock-labs/ephemeral-rollups-sdk');

async function generateTeeToken(teeUrl, keypair) {
  let ed25519;
  try {
    ed25519 = (await import('@noble/curves/ed25519')).ed25519;
  } catch {
    console.warn('⚠️  @noble/curves not available, skipping TEE token generation');
    return null;
  }
  const signMessage = async (message) => ed25519.sign(message, keypair.secretKey.slice(0, 32));
  try {
    const auth = await getAuthToken(teeUrl, keypair.publicKey, signMessage);
    return typeof auth === 'string' ? auth : auth.token;
  } catch (err) {
    console.warn(`⚠️  TEE token generation failed: ${err.message}`);
    return null;
  }
}


// ── Helpers ──────────────────────────────────────────────────────────────────

function discriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u64LE(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

function expandHome(p) { return p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(p), 'utf8'))));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SEEDS = {
  master_vault_v4b:      Buffer.from('master_vault_v4b'),
  business_v4:           Buffer.from('business_v4'),
  stream_config_v4:      Buffer.from('stream_config_v4'),
  employee_v4:           Buffer.from('employee_v4'),
  buffer:                Buffer.from('buffer'),
  delegation:            Buffer.from('delegation'),
  'delegation_metadata': Buffer.from('delegation-metadata'),
};

// ── PDA derivation ───────────────────────────────────────────────────────────

function deriveMasterVault(pid)         { return PublicKey.findProgramAddressSync([SEEDS.master_vault_v4b], pid)[0]; }
function deriveBusiness(mv, idx, pid)   { return PublicKey.findProgramAddressSync([SEEDS.business_v4, mv.toBuffer(), u64LE(idx)], pid)[0]; }
function deriveStreamCfg(biz, pid)      { return PublicKey.findProgramAddressSync([SEEDS.stream_config_v4, biz.toBuffer()], pid)[0]; }
function deriveEmployee(biz, idx, pid)  { return PublicKey.findProgramAddressSync([SEEDS.employee_v4, biz.toBuffer(), u64LE(idx)], pid)[0]; }
function deriveBuffer(emp, pid)         { return PublicKey.findProgramAddressSync([SEEDS.buffer, emp.toBuffer()], pid)[0]; }
function deriveDelegRec(emp, dpid)      { return PublicKey.findProgramAddressSync([SEEDS.delegation, emp.toBuffer()], dpid)[0]; }
function deriveDelegMeta(emp, dpid)     { return PublicKey.findProgramAddressSync([SEEDS['delegation_metadata'], emp.toBuffer()], dpid)[0]; }
function deriveTaskContext(payer, taskId, mpid) {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync([Buffer.from('task_context'), payer.toBuffer(), taskIdBuf], mpid)[0];
}

// ── Send instruction via base-layer ──────────────────────────────────────────

async function sendIx(conn, payer, ix, label = 'tx') {
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: 'confirmed', skipPreflight: false, maxRetries: 5,
  });
  console.log(`  ✅ ${label}: ${sig}`);
  return sig;
}

// ── Send instruction via MagicBlock Router ───────────────────────────────────

async function getRouterBlockhash(rpcUrl, tx) {
  const writableAccounts = new Set();
  if (tx.feePayer) writableAccounts.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions)
    for (const k of ix.keys)
      if (k.isWritable) writableAccounts.add(k.pubkey.toBase58());

  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getBlockhashForAccounts',
      params: [Array.from(writableAccounts)],
    }),
  });
  const payload = await resp.json();
  const val = payload?.result?.value ?? payload?.result;
  if (!val || !val.blockhash) throw new Error('Router blockhash missing: ' + JSON.stringify(payload));
  return val;
}

async function sendIxOnER(erUrl, payer, ix, label = 'tx') {
  const erConn = new Connection(erUrl, 'confirmed');
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;

  const { blockhash, lastValidBlockHeight } = await getRouterBlockhash(erUrl, tx);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(payer);

  const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  console.log(`  ✅ ${label} (ER): ${sig}`);
  
  // Wait for confirmation
  try {
    await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`  ✅ ${label} confirmed on ER`);
  } catch (e) {
    console.warn(`  ⚠️  ${label} confirmation timeout (may still be processing): ${e.message}`);
  }
  return sig;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  // ── Load env ────────────────────────────────────────────────────────────────
  // Try loading .env.local
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }

  const rpcUrl    = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const programId = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
  const delegPid  = new PublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM || 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
  const permPid   = new PublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_PERMISSION_PROGRAM || 'ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
  const magicPid  = new PublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM || 'Magic11111111111111111111111111111111111111');
  const incoPid   = new PublicKey(process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
  const validator = new PublicKey(process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
  const baseErUrl   = process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL || 'https://devnet-router.magicblock.app';

  const payerPath = process.env.PAYER_KEYPAIR_PATH || path.resolve(__dirname, '..', '..', 'keys', 'payroll-authority.json');
  const payer = loadKeypair(payerPath);

  // Load state
  const stateFile = path.resolve(__dirname, '..', '..', 'services', 'keeper', 'devnet-v4-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const bizIdx = Number(process.env.BUSINESS_INDEX ?? state.businessIndex ?? 0);
  const empIdx = Number(process.env.EMPLOYEE_INDEX ?? state.employeeIndex ?? 0);
  const empWallet = new PublicKey(process.env.EMPLOYEE_WALLET || state.employeeWallet || payer.publicKey.toBase58());

  // Generate TEE token if hitting TEE url
  let erUrl = baseErUrl;
  if (baseErUrl.includes('tee.magicblock.app')) {
    const token = await generateTeeToken(baseErUrl, payer);
    if (!token) throw new Error('Failed to generate TEE token, required for TEE router');
    erUrl = `${baseErUrl}?token=${token}`;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  MagicBlock Native Crank — E2E CLI Test');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Payer:       ${payer.publicKey.toBase58()}`);
  console.log(`  Program:     ${programId.toBase58()}`);
  console.log(`  Business:    ${bizIdx}`);
  console.log(`  Employee:    ${empIdx}`);
  console.log(`  ER URL:      ${baseErUrl}`);
  if (baseErUrl.includes('tee.magicblock.app')) console.log(`  🔐 TEE Authed: Yes`);
  console.log(`  Validator:   ${validator.toBase58()}`);
  console.log('');
  
  const conn = new Connection(rpcUrl, 'confirmed');

  // ── Derive PDAs ─────────────────────────────────────────────────────────────
  const masterVault  = deriveMasterVault(programId);
  const business     = deriveBusiness(masterVault, bizIdx, programId);
  const streamConfig = deriveStreamCfg(business, programId);
  const employee     = deriveEmployee(business, empIdx, programId);
  const bufferPda    = deriveBuffer(employee, programId);
  const delegRec     = deriveDelegRec(employee, delegPid);
  const delegMeta    = deriveDelegMeta(employee, delegPid);
  const [permPda]    = PublicKey.findProgramAddressSync([Buffer.from('permission:'), employee.toBuffer()], permPid);
  const permBuf      = PublicKey.findProgramAddressSync([SEEDS.buffer, permPda.toBuffer()], permPid)[0];
  const permDelegRec = deriveDelegRec(permPda, delegPid);
  const permDelegMet = deriveDelegMeta(permPda, delegPid);

  console.log(`  Employee PDA: ${employee.toBase58()}`);

  // ── Step 1: Check if already delegated ──────────────────────────────────────
  const empInfo = await conn.getAccountInfo(employee, 'confirmed');
  if (!empInfo) {
    console.error('❌ Employee account not found on-chain. Please add an employee first.');
    process.exit(1);
  }
  const isDelegated = empInfo.owner.equals(delegPid);
  console.log(`  Currently delegated: ${isDelegated}`);

  // ── Step 2: Delegate if needed ──────────────────────────────────────────────
  if (!isDelegated) {
    console.log('\n🔷 Step 1: Delegating stream to ER...');
    const delegateIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey,     isSigner: true,  isWritable: true },
        { pubkey: masterVault,         isSigner: false, isWritable: false },
        { pubkey: business,            isSigner: false, isWritable: false },
        { pubkey: streamConfig,        isSigner: false, isWritable: false },
        { pubkey: bufferPda,           isSigner: false, isWritable: true },
        { pubkey: delegRec,            isSigner: false, isWritable: true },
        { pubkey: delegMeta,           isSigner: false, isWritable: true },
        { pubkey: employee,            isSigner: false, isWritable: true },
        { pubkey: permBuf,             isSigner: false, isWritable: true },
        { pubkey: permDelegRec,        isSigner: false, isWritable: true },
        { pubkey: permDelegMet,        isSigner: false, isWritable: true },
        { pubkey: permPda,             isSigner: false, isWritable: true },
        { pubkey: permPid,             isSigner: false, isWritable: false },
        { pubkey: payer.publicKey,     isSigner: false, isWritable: false }, // authority
        { pubkey: empWallet,           isSigner: false, isWritable: false },
        { pubkey: validator,           isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: programId,           isSigner: false, isWritable: false },
        { pubkey: delegPid,            isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([discriminator('delegate_stream_v4'), u64LE(empIdx)]),
    });
    await sendIx(conn, payer, delegateIx, 'delegate_stream_v4');

    // Wait for delegation to propagate to the ER
    console.log('  ⏳ Waiting for delegation to propagate to ER...');
    const erConn = new Connection(erUrl, 'confirmed');
    for (let i = 0; i < 30; i++) {
      const info = await erConn.getAccountInfo(employee, 'confirmed').catch(() => null);
      if (info) {
        console.log('  ✅ Employee account visible on ER!');
        break;
      }
      process.stdout.write('.');
      await sleep(2000);
    }
  } else {
    console.log('\n🔷 Step 1: Already delegated, skipping.');
  }

  // ── Step 3: Schedule crank on the ER ────────────────────────────────────────
  console.log('\n🔷 Step 2: Scheduling crank on ER...');
  const taskId = Number(Date.now() % 1000000);
  const taskContext = deriveTaskContext(payer.publicKey, taskId, magicPid);
  
  // Build schedule_crank_v4 instruction
  const argsBuf = Buffer.alloc(32);
  argsBuf.writeBigUInt64LE(BigInt(taskId), 0);
  argsBuf.writeBigUInt64LE(BigInt(1_000), 8);           // 1s interval — real-time streaming
  argsBuf.writeBigUInt64LE(BigInt(999_999_999), 16);     // iterations
  argsBuf.writeBigUInt64LE(BigInt(empIdx), 24);           // employee_index

  const scheduleIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: magicPid,            isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,     isSigner: true,  isWritable: true },
      { pubkey: employee,            isSigner: false, isWritable: true },
      { pubkey: programId,           isSigner: false, isWritable: false },
      { pubkey: taskContext,         isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator('schedule_crank_v4'), argsBuf]),
  });

  try {
    await sendIxOnER(erUrl, payer, scheduleIx, 'schedule_crank_v4');
    console.log(`  📋 Task ID: ${taskId}`);
  } catch (err) {
    console.error(`  ❌ schedule_crank_v4 failed: ${err.message}`);
    console.error('     (This may mean the ER has not fully received the account yet)');
    process.exit(1);
  }

  // ── Step 4: Monitor the employee account for data changes ───────────────────
  console.log('\n🔷 Step 3: Monitoring employee account on ER for crank execution...');
  console.log('  (Watching for data mutations every 5s. Press Ctrl+C to stop.)\n');

  const erConn = new Connection(erUrl, 'confirmed');
  let lastHash = '';
  let checks = 0;
  let mutations = 0;

  const interval = setInterval(async () => {
    try {
      checks++;
      const info = await erConn.getAccountInfo(employee, 'confirmed');
      if (!info) {
        console.log(`  [${checks}] ❌ Account not found on ER`);
        return;
      }

      const hash = crypto.createHash('sha256').update(info.data).digest('hex').slice(0, 16);
      if (hash !== lastHash) {
        if (lastHash === '') {
          console.log(`  [${checks}] 🟢 Baseline loaded | Hash: ${hash} | Size: ${info.data.length}b`);
        } else {
          mutations++;
          console.log(`  [${checks}] ⚡ CRANK EXECUTED! Data changed! (mutation #${mutations}) | Hash: ${hash}`);
        }
        lastHash = hash;
      } else {
        process.stdout.write('.');
      }

      // After 2 minutes of monitoring (24 checks * 5s), print summary
      if (checks >= 24) {
        console.log(`\n\n═══════════════════════════════════════════════════════`);
        console.log(`  MONITORING SUMMARY (${checks * 5}s elapsed)`);
        console.log(`  Data mutations observed: ${mutations}`);
        if (mutations > 0) {
          console.log(`  🎉 CRANK IS WORKING! The MagicBlock validator is autonomously executing crank_settle_v4!`);
        } else {
          console.log(`  ⚠️  No data mutations detected. The crank may not be executing.`);
          console.log(`     Possible causes:`);
          console.log(`     - The ER validator hasn't picked up the task yet`);
          console.log(`     - The schedule_crank_v4 instruction wasn't accepted`);
          console.log(`     - The crank_settle_v4 is failing silently on the ER`);
        }
        console.log(`═══════════════════════════════════════════════════════\n`);
        clearInterval(interval);
        process.exit(mutations > 0 ? 0 : 1);
      }
    } catch (e) {
      console.log(`  [${checks}] ⚠️  ${e.message}`);
    }
  }, 5000);
}

main().catch(err => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
