#!/usr/bin/env node

if (!process.env.ALLOW_V2) {
  console.warn('[disabled] backfill-decrypt-permissions.cjs is legacy. Set ALLOW_V2=1 to enable.');
  process.exit(1);
}

/**
 * Backfill Inco decrypt permissions for all v2 streams.
 *
 * For each stream index (0 → nextStreamIndex-1):
 *   - Grants the configured keeper decrypt access to the salary handle.
 *   - Skips streams that are already correctly permissioned (idempotent).
 *
 * Usage:
 *   cd /path/to/expensee
 *   set -a; source backend/keeper/.env; set +a
 *   node frontend/scripts/backfill-decrypt-permissions.cjs
 *
 * Env:
 *   KEEPER_PAYER_KEYPAIR_PATH — owner/authority keypair (must be the business owner)
 *   KEEPER_PROGRAM_ID / NEXT_PUBLIC_PAYROLL_PROGRAM_ID
 *   KEEPER_INCO_LIGHTNING_ID / NEXT_PUBLIC_INCO_PROGRAM_ID
 *   NEW_KEEPER_PUBKEY — (optional) override the keeper wallet to grant to; default: reads from on-chain config
 *   DRY_RUN=true — (optional) list streams without sending transactions
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

const DISCRIMINATORS = {
  grant_keeper_view_access_v2: Buffer.from([60, 78, 33, 123, 183, 61, 107, 58]),
};

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

function loadKeypairFromPath(keypairPath) {
  const raw = fs.readFileSync(expandHome(keypairPath), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function deriveBusinessPda(owner, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('business'), owner.toBuffer()], programId)[0];
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

function incoAllowancePda(handleU128, allowedAddress, incoLightningId) {
  const handleBuf = Buffer.alloc(16);
  let h = BigInt(handleU128);
  for (let i = 0; i < 16; i += 1) {
    handleBuf[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  return PublicKey.findProgramAddressSync([handleBuf, allowedAddress.toBuffer()], incoLightningId)[0];
}

function parseStreamConfigV2(data) {
  if (!data || data.length < 91) return null;
  return {
    keeper: new PublicKey(data.subarray(40, 72)),
    nextStreamIndex: Number(data.readBigUInt64LE(80)),
  };
}

function parseEmployeeStreamMeta(data) {
  if (!data || data.length < 194) return null;
  return {
    salaryHandle: data.readBigUInt64LE(112) + (data.readBigUInt64LE(120) << 64n),
    isActive: data[192] === 1,
  };
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  const rpcUrl = envString(
    'KEEPER_READ_RPC_URL',
    process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || 'https://api.devnet.solana.com'
  );
  const programId = envPublicKey('KEEPER_PROGRAM_ID', process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID);
  const incoLightningId = envPublicKey(
    'KEEPER_INCO_LIGHTNING_ID',
    process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
  );
  const keypairPath = envString(
    'KEEPER_PAYER_KEYPAIR_PATH',
    process.env.SOLANA_KEYPAIR_PATH || path.join(os.homedir(), '.config/solana/devnet-keypair.json')
  );

  const payer = loadKeypairFromPath(keypairPath);
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('rpc:', rpcUrl);
  console.log('program:', programId.toBase58());
  console.log('payer/owner:', payer.publicKey.toBase58());
  console.log('dry_run:', dryRun);

  const businessPda = deriveBusinessPda(payer.publicKey, programId);
  const streamConfigPda = deriveStreamConfigPda(businessPda, programId);

  const configInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
  if (!configInfo) throw new Error('Stream config not found. Has the business been set up?');
  const config = parseStreamConfigV2(Buffer.from(configInfo.data));
  if (!config) throw new Error('Failed to parse stream config');

  const keeperOverride = (process.env.NEW_KEEPER_PUBKEY || '').trim();
  const keeperWallet = keeperOverride ? new PublicKey(keeperOverride) : config.keeper;

  console.log('keeper:', keeperWallet.toBase58());
  console.log('next_stream_index:', config.nextStreamIndex);
  console.log('');

  let granted = 0;
  let skipped = 0;
  let missing = 0;

  for (let i = 0; i < config.nextStreamIndex; i++) {
    const employeeStreamPda = deriveEmployeeStreamPda(businessPda, i, programId);
    const streamInfo = await connection.getAccountInfo(employeeStreamPda, 'confirmed');

    if (!streamInfo || streamInfo.data.length < 194) {
      console.log(`  stream[${i}]: MISSING (skipped)`);
      missing++;
      continue;
    }

    const meta = parseEmployeeStreamMeta(Buffer.from(streamInfo.data));
    if (!meta) {
      console.log(`  stream[${i}]: PARSE_FAILED (skipped)`);
      missing++;
      continue;
    }

    // Check if allowance PDA already exists.
    const salaryAllowance = incoAllowancePda(meta.salaryHandle, keeperWallet, incoLightningId);
    const allowanceInfo = await connection.getAccountInfo(salaryAllowance, 'confirmed');
    if (allowanceInfo) {
      console.log(`  stream[${i}]: already granted (skipped) active=${meta.isActive}`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  stream[${i}]: NEEDS GRANT active=${meta.isActive} handle=${meta.salaryHandle.toString()}`);
      granted++;
      continue;
    }

    // Build and send grant_keeper_view_access_v2.
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: businessPda, isSigner: false, isWritable: false },
        { pubkey: streamConfigPda, isSigner: false, isWritable: false },
        { pubkey: employeeStreamPda, isSigner: false, isWritable: false },
        { pubkey: keeperWallet, isSigner: false, isWritable: false },
        { pubkey: salaryAllowance, isSigner: false, isWritable: true },
        { pubkey: incoLightningId, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([DISCRIMINATORS.grant_keeper_view_access_v2, u64LE(i)]),
    });

    try {
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: 'confirmed',
        skipPreflight: false,
        maxRetries: 3,
      });
      console.log(`  stream[${i}]: GRANTED tx=${sig}`);
      granted++;
    } catch (e) {
      console.error(`  stream[${i}]: FAILED ${e?.message || e}`);
    }
  }

  console.log('');
  console.log(`Done. granted=${granted} skipped=${skipped} missing=${missing}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
