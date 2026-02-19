#!/usr/bin/env node

/**
 * Devnet helper: mint confidential payUSD token (or configured confidential mint) to an Inco token account.
 *
 * Requirements:
 * - You must control the mint authority for the mint you are using.
 * - Destination token account must already be initialized (Inco Token `initialize_account`).
 *
 * Env:
 * - RPC_URL (optional) defaults to NEXT_PUBLIC_SOLANA_RPC_URL or devnet
 * - MINT_AUTHORITY_KEYPAIR_PATH (optional) defaults to ~/.config/solana/id.json
 * - NEXT_PUBLIC_PAYUSD_MINT (required)
 * - NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID (required)
 * - NEXT_PUBLIC_INCO_PROGRAM_ID (required, lightning)
 * - DEST_TOKEN_ACCOUNT (required)
 * - AMOUNT (optional) UI units, default 100
 * - DECIMALS (optional) default 9
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } =
  require('@solana/web3.js');
const { encryptValue } = require('@inco/solana-sdk/encryption');

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function required(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sha256Disc(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function loadKeypair(keypairPath) {
  const raw = fs.readFileSync(expandHome(keypairPath), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const rpcUrl = (process.env.RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com').trim();
  const mint = new PublicKey(required('NEXT_PUBLIC_PAYUSD_MINT'));
  const incoTokenProgramId = new PublicKey(required('NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID'));
  const incoLightningId = new PublicKey(required('NEXT_PUBLIC_INCO_PROGRAM_ID'));
  const destinationTokenAccount = new PublicKey(required('DEST_TOKEN_ACCOUNT'));

  const decimals = Number(process.env.DECIMALS || '9');
  const amountUi = Number(process.env.AMOUNT || '100');
  if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error('Invalid AMOUNT');

  const mintAuthorityPath = (process.env.MINT_AUTHORITY_KEYPAIR_PATH || '~/.config/solana/id.json').trim();
  const mintAuthority = loadKeypair(mintAuthorityPath);

  const connection = new Connection(rpcUrl, 'confirmed');

  const disc = sha256Disc('mint_to');
  const amountLamports = BigInt(Math.floor(amountUi * Math.pow(10, decimals)));
  const encryptedHex = await encryptValue(amountLamports);
  const encryptedBytes = Buffer.from(encryptedHex, 'hex');

  const data = Buffer.concat([
    disc,
    u32LE(encryptedBytes.length),
    encryptedBytes,
    u32LE(0), // security zone
  ]);

  const ix = new TransactionInstruction({
    programId: incoTokenProgramId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
      { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = mintAuthority.publicKey;

  console.log('rpc:', rpcUrl);
  console.log('mint:', mint.toBase58());
  console.log('dest_token_account:', destinationTokenAccount.toBase58());
  console.log('mint_authority:', mintAuthority.publicKey.toBase58());
  console.log('amount_ui:', amountUi);
  console.log('decimals:', decimals);
  console.log('amount_lamports:', amountLamports.toString());

  const sig = await sendAndConfirmTransaction(connection, tx, [mintAuthority], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log('mint_to tx:', sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

