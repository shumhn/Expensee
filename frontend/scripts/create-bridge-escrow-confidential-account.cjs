#!/usr/bin/env node

/**
 * Devnet helper: create an Inco confidential token account for the BRIDGE escrow signer.
 *
 * This is required for "unwrap" (confidential -> public), where the user transfers
 * confidential tokens back to an operator-controlled escrow token account.
 *
 * Env:
 * - RPC_URL (optional) defaults to NEXT_PUBLIC_SOLANA_RPC_URL or devnet
 * - ESCROW_KEYPAIR_PATH (optional) defaults to BRIDGE_ESCROW_KEYPAIR_PATH or keys/payroll-authority.json
 * - NEXT_PUBLIC_PAYUSD_MINT (required) confidential mint
 * - NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID (required)
 * - NEXT_PUBLIC_INCO_PROGRAM_ID (required) lightning
 */

const fs = require('fs');
const path = require('path');

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } =
  require('@solana/web3.js');

// Anchor sha256("global:initialize_account")[0..8]
const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);

function required(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadKeypair(keypairPath) {
  const raw = fs.readFileSync(keypairPath, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const rpcUrl = (process.env.RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com').trim();
  const mint = new PublicKey(required('NEXT_PUBLIC_PAYUSD_MINT'));
  const incoTokenProgramId = new PublicKey(required('NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID'));
  const incoLightningId = new PublicKey(required('NEXT_PUBLIC_INCO_PROGRAM_ID'));

  const defaultEscrowPath = path.join(process.cwd(), 'keys', 'payroll-authority.json');
  const escrowPath = (process.env.ESCROW_KEYPAIR_PATH || process.env.BRIDGE_ESCROW_KEYPAIR_PATH || defaultEscrowPath).trim();
  if (!fs.existsSync(escrowPath)) {
    throw new Error(`Escrow keypair not found: ${escrowPath}`);
  }
  const escrow = loadKeypair(escrowPath);

  const connection = new Connection(rpcUrl, 'confirmed');

  // Generate a new keypair for the Inco token account address.
  const tokenAccountKeypair = Keypair.generate();

  const ix = new TransactionInstruction({
    programId: incoTokenProgramId,
    keys: [
      { pubkey: tokenAccountKeypair.publicKey, isSigner: true, isWritable: true }, // token_account
      { pubkey: mint, isSigner: false, isWritable: false }, // mint
      { pubkey: escrow.publicKey, isSigner: false, isWritable: false }, // owner (authority)
      { pubkey: escrow.publicKey, isSigner: true, isWritable: true }, // payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
    ],
    data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = escrow.publicKey;

  console.log('rpc:', rpcUrl);
  console.log('escrow:', escrow.publicKey.toBase58());
  console.log('mint (confidential):', mint.toBase58());
  console.log('creating escrow inco token account...');

  const sig = await sendAndConfirmTransaction(connection, tx, [escrow, tokenAccountKeypair], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log('init_account tx:', sig);
  console.log('escrow_inco_token_account:', tokenAccountKeypair.publicKey.toBase58());
  console.log('');
  console.log('Set this in app/.env.local (server-only):');
  console.log(`BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT=${tokenAccountKeypair.publicKey.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

