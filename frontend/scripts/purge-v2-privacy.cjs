#!/usr/bin/env node

/**
 * Purge helper for strict privacy migrations.
 *
 * What it does (for one employer/business):
 * 1) Scans all v2 stream indices from stream_config_v2.next_stream_index.
 * 2) If stream is delegated, commits+undelegates it first.
 * 3) Deactivates active streams.
 * 4) Revokes decrypt access for wallets you provide.
 *
 * Notes:
 * - Chain history cannot be deleted; this retires old records and permissions.
 * - Revocation targets must be provided (comma-separated wallets).
 * - Dry-run is ON by default.
 *
 * Example:
 *   set -a; source backend/keeper/.env; set +a
 *   PURGE_OWNER_KEYPAIR_PATH=/abs/path/owner.json \
 *   PURGE_REVOKE_WALLETS=worker1Pubkey,worker2Pubkey \
 *   node frontend/scripts/purge-v2-privacy.cjs
 *
 * Execute for real:
 *   ... PURGE_DRY_RUN=false PURGE_CONFIRM=YES_I_UNDERSTAND \
 *   node frontend/scripts/purge-v2-privacy.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
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
  commit_and_undelegate_stream_v2: Buffer.from([221, 72, 242, 203, 64, 158, 195, 242]),
  deactivate_stream_v2: Buffer.from([18, 228, 219, 116, 117, 114, 136, 3]),
  revoke_view_access_v2: Buffer.from([79, 190, 166, 170, 246, 184, 119, 163]),
};

const BUSINESS_SEED = Buffer.from('business');
const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const EMPLOYEE_V2_SEED = Buffer.from('employee_v2');

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function envString(name, fallback = '') {
  const value = (process.env[name] || fallback || '').trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function envPublicKey(name, fallback = '') {
  return new PublicKey(envString(name, fallback));
}

function boolEnv(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

function deriveBusinessPda(owner, programId) {
  return PublicKey.findProgramAddressSync([BUSINESS_SEED, owner.toBuffer()], programId)[0];
}

function deriveStreamConfigPda(business, programId) {
  return PublicKey.findProgramAddressSync([STREAM_CONFIG_V2_SEED, business.toBuffer()], programId)[0];
}

function deriveEmployeeStreamPda(business, streamIndex, programId) {
  return PublicKey.findProgramAddressSync(
    [EMPLOYEE_V2_SEED, business.toBuffer(), u64LE(streamIndex)],
    programId
  )[0];
}

function parseStreamConfigV2(data) {
  if (!data || data.length < 91) return null;
  return {
    keeperPubkey: new PublicKey(data.subarray(40, 72)),
    nextStreamIndex: Number(data.readBigUInt64LE(80)),
  };
}

function parseEmployeeMeta(data, owner, delegationProgramId) {
  if (!data || data.length < 211) return null;
  const delegatedByFlag = data[193] === 1;
  const delegatedByOwner = owner.equals(delegationProgramId);
  return {
    isActive: data[192] === 1,
    isDelegated: delegatedByFlag || delegatedByOwner,
    salaryHandle32: Buffer.from(data.subarray(112, 144)),
    accruedHandle32: Buffer.from(data.subarray(144, 176)),
  };
}

function handle16FromHandle32(handle32) {
  return Buffer.from(handle32.subarray(0, 16));
}

function deriveAllowancePda(handle16, wallet, incoLightningId) {
  return PublicKey.findProgramAddressSync([handle16, wallet.toBuffer()], incoLightningId)[0];
}

function loadKeypair(filePath) {
  const raw = fs.readFileSync(expandHome(filePath), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function sendIx(connection, payer, ix, label) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`  ${label}: ${sig}`);
  return sig;
}

async function main() {
  const rpcUrl = envString(
    'PURGE_RPC_URL',
    process.env.KEEPER_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      process.env.KEEPER_RPC_URL ||
      'https://api.devnet.solana.com'
  );
  const programId = envPublicKey(
    'PURGE_PROGRAM_ID',
    process.env.KEEPER_PROGRAM_ID || process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID
  );
  const incoLightningId = envPublicKey(
    'PURGE_INCO_LIGHTNING_ID',
    process.env.KEEPER_INCO_LIGHTNING_ID || process.env.NEXT_PUBLIC_INCO_PROGRAM_ID
  );
  const delegationProgramId = envPublicKey(
    'PURGE_DELEGATION_PROGRAM_ID',
    process.env.KEEPER_DELEGATION_PROGRAM_ID ||
      process.env.NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM ||
      'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
  );
  const magicProgramId = envPublicKey(
    'PURGE_MAGIC_PROGRAM_ID',
    process.env.KEEPER_MAGIC_CORE_PROGRAM_ID ||
      process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM ||
      'Magic11111111111111111111111111111111111111'
  );
  const magicContextId = envPublicKey(
    'PURGE_MAGIC_CONTEXT_ID',
    process.env.KEEPER_MAGIC_CONTEXT ||
      process.env.NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT ||
      'MagicContext1111111111111111111111111111111'
  );
  const keypairPath = envString(
    'PURGE_OWNER_KEYPAIR_PATH',
    process.env.KEEPER_PAYER_KEYPAIR_PATH || path.join(os.homedir(), '.config/solana/id.json')
  );

  const dryRun = boolEnv('PURGE_DRY_RUN', true);
  const deactivate = boolEnv('PURGE_DEACTIVATE', true);
  const undelegateFirst = boolEnv('PURGE_COMMIT_UNDELEGATE', true);
  const confirm = (process.env.PURGE_CONFIRM || '').trim();

  if (!dryRun && confirm !== 'YES_I_UNDERSTAND') {
    throw new Error('Refusing to run non-dry mode without PURGE_CONFIRM=YES_I_UNDERSTAND');
  }

  const revokeWalletsCsv = (process.env.PURGE_REVOKE_WALLETS || '').trim();
  const revokeWallets = revokeWalletsCsv
    ? revokeWalletsCsv
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => new PublicKey(x))
    : [];

  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = loadKeypair(keypairPath);
  const businessPda = deriveBusinessPda(owner.publicKey, programId);
  const streamConfigPda = deriveStreamConfigPda(businessPda, programId);

  const businessInfo = await connection.getAccountInfo(businessPda, 'confirmed');
  if (!businessInfo) {
    throw new Error(`Business account not found for owner ${owner.publicKey.toBase58()}`);
  }

  const streamConfigInfo = await connection.getAccountInfo(streamConfigPda, 'confirmed');
  if (!streamConfigInfo) {
    throw new Error(`Stream config not found for business ${businessPda.toBase58()}`);
  }
  const streamConfig = parseStreamConfigV2(streamConfigInfo.data);
  if (!streamConfig) {
    throw new Error('Failed to parse stream_config_v2');
  }

  const maxIndex = streamConfig.nextStreamIndex;
  const fromIndex = Number(process.env.PURGE_INDEX_FROM || '0');
  const toIndexExclusive = Number(process.env.PURGE_INDEX_TO_EXCLUSIVE || String(maxIndex));

  console.log('=== Purge Config ===');
  console.log(`rpc=${rpcUrl}`);
  console.log(`owner=${owner.publicKey.toBase58()}`);
  console.log(`business=${businessPda.toBase58()}`);
  console.log(`stream_config=${streamConfigPda.toBase58()}`);
  console.log(`next_stream_index=${maxIndex}`);
  console.log(`range=[${fromIndex}, ${toIndexExclusive})`);
  console.log(`dry_run=${dryRun}`);
  console.log(`deactivate=${deactivate}`);
  console.log(`commit_undelegate=${undelegateFirst}`);
  console.log(`revoke_wallets=${revokeWallets.length ? revokeWallets.map((w) => w.toBase58()).join(',') : '(none)'}`);
  console.log('');

  let seen = 0;
  let deactivated = 0;
  let undelegated = 0;
  let revoked = 0;
  let skippedMissing = 0;

  for (let i = fromIndex; i < toIndexExclusive; i += 1) {
    const streamPda = deriveEmployeeStreamPda(businessPda, i, programId);
    const streamInfo = await connection.getAccountInfo(streamPda, 'confirmed');
    if (!streamInfo) {
      skippedMissing += 1;
      continue;
    }
    seen += 1;

    const meta = parseEmployeeMeta(streamInfo.data, streamInfo.owner, delegationProgramId);
    if (!meta) {
      console.log(`stream[${i}] parse failed, skipping`);
      continue;
    }

    console.log(`stream[${i}] active=${meta.isActive} delegated=${meta.isDelegated} pda=${streamPda.toBase58()}`);

    if (meta.isDelegated && undelegateFirst) {
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: businessPda, isSigner: false, isWritable: false },
          { pubkey: streamConfigPda, isSigner: false, isWritable: false },
          { pubkey: streamPda, isSigner: false, isWritable: true },
          { pubkey: magicProgramId, isSigner: false, isWritable: false },
          { pubkey: magicContextId, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([DISCRIMINATORS.commit_and_undelegate_stream_v2, u64LE(i)]),
      });

      if (dryRun) {
        console.log(`  [dry-run] commit_and_undelegate_stream_v2`);
      } else {
        await sendIx(connection, owner, ix, `commit_and_undelegate_stream_v2[${i}]`);
      }
      undelegated += 1;
    }

    if (meta.isActive && deactivate) {
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: businessPda, isSigner: false, isWritable: false },
          { pubkey: streamConfigPda, isSigner: false, isWritable: false },
          { pubkey: streamPda, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([DISCRIMINATORS.deactivate_stream_v2, u64LE(i)]),
      });

      if (dryRun) {
        console.log(`  [dry-run] deactivate_stream_v2`);
      } else {
        await sendIx(connection, owner, ix, `deactivate_stream_v2[${i}]`);
      }
      deactivated += 1;
    }

    if (revokeWallets.length > 0) {
      const salaryHandle16 = handle16FromHandle32(meta.salaryHandle32);
      const accruedHandle16 = handle16FromHandle32(meta.accruedHandle32);

      for (const targetWallet of revokeWallets) {
        const salaryAllowance = deriveAllowancePda(salaryHandle16, targetWallet, incoLightningId);
        const accruedAllowance = deriveAllowancePda(accruedHandle16, targetWallet, incoLightningId);

        const salaryAllowanceInfo = await connection.getAccountInfo(salaryAllowance, 'confirmed');
        const accruedAllowanceInfo = await connection.getAccountInfo(accruedAllowance, 'confirmed');
        if (!salaryAllowanceInfo && !accruedAllowanceInfo) {
          console.log(`  revoke skip ${targetWallet.toBase58().slice(0, 8)}... (no allowance accounts)`);
          continue;
        }

        const ix = new TransactionInstruction({
          programId,
          keys: [
            { pubkey: owner.publicKey, isSigner: true, isWritable: true },
            { pubkey: businessPda, isSigner: false, isWritable: false },
            { pubkey: streamConfigPda, isSigner: false, isWritable: false },
            { pubkey: streamPda, isSigner: false, isWritable: false },
            { pubkey: targetWallet, isSigner: false, isWritable: false },
            { pubkey: streamConfig.keeperPubkey, isSigner: false, isWritable: false },
            { pubkey: salaryAllowance, isSigner: false, isWritable: true },
            { pubkey: accruedAllowance, isSigner: false, isWritable: true },
            { pubkey: incoLightningId, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([DISCRIMINATORS.revoke_view_access_v2, u64LE(i)]),
        });

        if (dryRun) {
          console.log(`  [dry-run] revoke_view_access_v2 -> ${targetWallet.toBase58()}`);
        } else {
          await sendIx(
            connection,
            owner,
            ix,
            `revoke_view_access_v2[${i}]->${targetWallet.toBase58().slice(0, 8)}`
          );
        }
        revoked += 1;
      }
    }
  }

  console.log('');
  console.log('=== Purge Summary ===');
  console.log(`streams_seen=${seen}`);
  console.log(`streams_missing=${skippedMissing}`);
  console.log(`undelegate_attempts=${undelegated}`);
  console.log(`deactivate_attempts=${deactivated}`);
  console.log(`revoke_attempts=${revoked}`);
  console.log(dryRun ? 'mode=dry-run (no transactions sent)' : 'mode=live');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

