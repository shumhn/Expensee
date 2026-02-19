#!/usr/bin/env node

/**
 * Devnet helper: Mint "Public USDC" (pUSDC) to a destination wallet.
 * Usage:
 *   node app/scripts/mint-public-usdc.cjs <DESTINATION_WALLET> <AMOUNT>
 * Example:
 *   node app/scripts/mint-public-usdc.cjs 5G24HJ... 1000
 */

const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, clusterApiUrl } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');

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
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node app/scripts/mint-public-usdc.cjs <DESTINATION> <AMOUNT>');
    process.exit(1);
  }

  const destination = new PublicKey(args[0]);
  const amountUi = Number(args[1]);
  const decimals = 6;
  const amount = BigInt(Math.floor(amountUi * Math.pow(10, decimals)));

  // Load mint address from env or args
  const mintAddress = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || process.env.PUBLIC_USDC_MINT;
  if (!mintAddress) {
    throw new Error('Missing NEXT_PUBLIC_PUBLIC_USDC_MINT env var');
  }
  const mint = new PublicKey(mintAddress);

  // Authority
  const defaultKeyPath = path.join(process.cwd(), 'keys', 'payroll-authority.json');
  const keypairPath = process.env.MINT_AUTHORITY_KEYPAIR_PATH || defaultKeyPath;
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Mint authority keypair not found at ${keypairPath}`);
  }
  const authority = loadKeypair(keypairPath);

  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl('devnet');
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log(`Minting ${amountUi} pUSDC to ${destination.toBase58()}...`);
  console.log(`Mint: ${mint.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}`);

  // Get or create ATA
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    destination
  );

  // Mint
  const tx = await mintTo(
    connection,
    authority,
    mint,
    ata.address,
    authority,
    amount
  );

  console.log(`Success! tx: ${tx}`);
  console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
