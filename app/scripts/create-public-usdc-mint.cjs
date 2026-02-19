#!/usr/bin/env node

/**
 * Devnet helper: create a public SPL "USDC-like" mint (6 decimals) and mint
 * some tokens to the fee payer's associated token account.
 *
 * This is used for the Public Entry/Exit demo: public stablecoin in/out,
 * confidential payroll in the middle.
 *
 * Env:
 * - RPC_URL (optional) defaults to NEXT_PUBLIC_SOLANA_RPC_URL or devnet
 * - FEE_PAYER_KEYPAIR_PATH (optional) defaults to keys/payroll-authority.json
 * - DECIMALS (optional) default 6
 * - AMOUNT (optional) UI amount to mint to fee payer, default 1000
 */

const fs = require('fs');
const path = require('path');

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

function loadKeypair(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function getAssociatedTokenAddress(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx({ payer, ata, owner, mint }) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function tokenInitializeMintIx({ mint, decimals, mintAuthority, freezeAuthority }) {
  // InitializeMint = 0
  // layout: u8 instruction, u8 decimals, pubkey mint_authority, u8 freeze_option, pubkey freeze_authority (if option=1)
  const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
  data.writeUInt8(0, 0);
  data.writeUInt8(decimals & 0xff, 1);
  Buffer.from(mintAuthority.toBytes()).copy(data, 2);
  if (freezeAuthority) {
    data.writeUInt8(1, 34);
    Buffer.from(freezeAuthority.toBytes()).copy(data, 35);
  } else {
    data.writeUInt8(0, 34);
    // remaining 32 bytes left as 0s
  }
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function tokenMintToIx({ mint, destination, authority, amount }) {
  // MintTo = 7
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const rpcUrl = (process.env.RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com').trim();
  const decimals = Number(process.env.DECIMALS || '6');
  const amountUi = Number(process.env.AMOUNT || '1000');
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid DECIMALS');
  if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error('Invalid AMOUNT');

  const defaultPayerPath = path.join(process.cwd(), 'keys', 'payroll-authority.json');
  const payerPath = (process.env.FEE_PAYER_KEYPAIR_PATH || defaultPayerPath).trim();
  if (!fs.existsSync(payerPath)) throw new Error(`Fee payer keypair not found: ${payerPath}`);
  const payer = loadKeypair(payerPath);

  const connection = new Connection(rpcUrl, 'confirmed');

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  const mintSpace = 82;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintSpace, 'confirmed');

  const ownerAta = getAssociatedTokenAddress(payer.publicKey, mint);
  const amountLamports = BigInt(Math.floor(amountUi * Math.pow(10, decimals)));

  const tx = new Transaction();
  tx.feePayer = payer.publicKey;

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      lamports,
      space: mintSpace,
      programId: TOKEN_PROGRAM_ID,
    })
  );
  tx.add(tokenInitializeMintIx({ mint, decimals, mintAuthority: payer.publicKey, freezeAuthority: null }));
  tx.add(createAssociatedTokenAccountIx({ payer: payer.publicKey, ata: ownerAta, owner: payer.publicKey, mint }));
  tx.add(tokenMintToIx({ mint, destination: ownerAta, authority: payer.publicKey, amount: amountLamports }));

  console.log('rpc:', rpcUrl);
  console.log('payer:', payer.publicKey.toBase58());
  console.log('creating public mint...');

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mintKp], {
    commitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log('tx:', sig);
  console.log('public_usdc_mint:', mint.toBase58());
  console.log('payer_public_ata:', ownerAta.toBase58());
  console.log('amount_ui:', amountUi);
  console.log('decimals:', decimals);
  console.log('');
  console.log('Set this in app/.env.local:');
  console.log(`NEXT_PUBLIC_PUBLIC_USDC_MINT=${mint.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

