#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const web3 = require('@solana/web3.js');

const PROGRAM_ID = new web3.PublicKey(
  process.env.KEEPER_PROGRAM_ID || process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '3P3tYHEUykB2fH5vxpunHQH3C7zi9B3fFXyzaRP38bJn'
);
const RPC_URL = process.env.KEEPER_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const BUSINESS_SEED = Buffer.from('business');
const STREAM_CONFIG_V2_SEED = Buffer.from('stream_config_v2');
const UPDATE_KEEPER_V2_DISC = Buffer.from([52, 172, 105, 244, 89, 165, 39, 71]);

function loadKeypair(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const ownerKeypairPath = process.env.OWNER_KEYPAIR_PATH || path.resolve(__dirname, '../../keys/payroll-authority.json');
  const newKeeper = process.env.NEW_KEEPER_PUBKEY;
  if (!newKeeper) {
    throw new Error('Missing NEW_KEEPER_PUBKEY');
  }

  const owner = loadKeypair(ownerKeypairPath);
  const newKeeperPubkey = new web3.PublicKey(newKeeper);
  const connection = new web3.Connection(RPC_URL, 'confirmed');

  const [businessPda] = web3.PublicKey.findProgramAddressSync([BUSINESS_SEED, owner.publicKey.toBuffer()], PROGRAM_ID);
  const [streamConfigPda] = web3.PublicKey.findProgramAddressSync([STREAM_CONFIG_V2_SEED, businessPda.toBuffer()], PROGRAM_ID);

  const ix = new web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: businessPda, isSigner: false, isWritable: false },
      { pubkey: streamConfigPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([UPDATE_KEEPER_V2_DISC, newKeeperPubkey.toBuffer()]),
  });

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = owner.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(owner);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

  console.log('rpc:', RPC_URL);
  console.log('program:', PROGRAM_ID.toBase58());
  console.log('owner:', owner.publicKey.toBase58());
  console.log('business_pda:', businessPda.toBase58());
  console.log('stream_config_pda:', streamConfigPda.toBase58());
  console.log('new_keeper:', newKeeperPubkey.toBase58());
  console.log('update_keeper_v2 tx:', sig);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});

