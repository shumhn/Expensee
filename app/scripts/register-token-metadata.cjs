#!/usr/bin/env node

/**
 * Register Metaplex Token Metadata for the devnet pUSDC mint.
 *
 * This makes the token show a proper name, symbol, and (optional) logo
 * in wallets like Phantom instead of "Unknown Token".
 *
 * Usage:
 *   node app/scripts/register-token-metadata.cjs
 *
 * Environment (reads from app/.env.local via dotenv):
 *   NEXT_PUBLIC_PUBLIC_USDC_MINT  – the SPL token mint address
 *   NEXT_PUBLIC_SOLANA_RPC_URL    – devnet RPC
 *   keys/payroll-authority.json   – mint authority keypair
 */

const fs = require('fs');
const path = require('path');
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');

// ── Load .env.local ──────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* ignore */ }

// ── Constants ────────────────────────────────────────────────────

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

// ── Helpers ──────────────────────────────────────────────────────

function loadKeypair(keypairPath) {
  const raw = fs.readFileSync(keypairPath, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function getMetadataPDA(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Build a CreateMetadataAccountV3 instruction (Metaplex Token Metadata v3).
 *
 * We serialise the Borsh payload manually to avoid pulling in large deps.
 */
function buildCreateMetadataV3Ix({
  metadataPDA,
  mint,
  mintAuthority,
  payer,
  updateAuthority,
  name,
  symbol,
  uri,
}) {
  // ── Borsh-encode the instruction data ──
  // Discriminator for CreateMetadataAccountV3 = 33
  const discriminator = Buffer.from([33]);

  // Borsh helpers
  function borshString(s) {
    const buf = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length);
    return Buffer.concat([len, buf]);
  }
  function borshU16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  }
  function borshBool(v) {
    return Buffer.from([v ? 1 : 0]);
  }
  function borshOption(present, data) {
    if (!present) return Buffer.from([0]);
    return Buffer.concat([Buffer.from([1]), data]);
  }

  // DataV2 struct
  const dataV2 = Buffer.concat([
    borshString(name),
    borshString(symbol),
    borshString(uri),
    borshU16(0),                      // seller_fee_basis_points
    borshOption(false, Buffer.alloc(0)), // creators: None
    borshOption(false, Buffer.alloc(0)), // collection: None
    borshOption(false, Buffer.alloc(0)), // uses: None
  ]);

  const instructionData = Buffer.concat([
    discriminator,
    dataV2,
    borshBool(true),                  // is_mutable
    borshOption(false, Buffer.alloc(0)), // collection_details: None
  ]);

  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPDA, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const mintAddress = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT;
  if (!mintAddress) throw new Error('Missing NEXT_PUBLIC_PUBLIC_USDC_MINT');
  const mint = new PublicKey(mintAddress);

  const keypairPath = path.join(process.cwd(), 'keys', 'payroll-authority.json');
  if (!fs.existsSync(keypairPath)) throw new Error(`Keypair not found: ${keypairPath}`);
  const authority = loadKeypair(keypairPath);

  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const metadataPDA = getMetadataPDA(mint);

  // Check if metadata already exists
  const existing = await connection.getAccountInfo(metadataPDA);
  if (existing) {
    console.log('⚠️  Metadata account already exists:', metadataPDA.toBase58());
    console.log('   If you want to update it, use UpdateMetadataAccountV2 instead.');
    return;
  }

  const name = 'pUSDC';
  const symbol = 'pUSDC';
  const uri = ''; // no off-chain JSON needed for basic name/symbol

  console.log('Registering token metadata...');
  console.log('  Mint:', mint.toBase58());
  console.log('  Authority:', authority.publicKey.toBase58());
  console.log('  Metadata PDA:', metadataPDA.toBase58());
  console.log('  Name:', name);
  console.log('  Symbol:', symbol);

  const ix = buildCreateMetadataV3Ix({
    metadataPDA,
    mint,
    mintAuthority: authority.publicKey,
    payer: authority.publicKey,
    updateAuthority: authority.publicKey,
    name,
    symbol,
    uri,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);

  console.log('');
  console.log('✅ Token metadata registered!');
  console.log('   tx:', sig);
  console.log('   Explorer:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log('');
  console.log('Phantom should now show "pUSDC" instead of "Unknown Token".');
}

main().catch((err) => {
  console.error('❌', err.message || err);
  process.exit(1);
});
