import type { NextApiRequest, NextApiResponse } from 'next';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type Ok = {
  ok: true;
  txBase64: string;
  feePayer: string;
  userUsdcAta: string;
  escrowUsdcAta: string;
  confidentialMint: string;
};

type Err = { ok: false; error: string };

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

function requiredEnv(name: string): string {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function resolveKeypairPath(pathOrJson: string): string {
  const trimmed = pathOrJson.trim();
  if (!trimmed || trimmed.startsWith('[')) return trimmed;
  if (path.isAbsolute(trimmed)) return trimmed;

  const candidates = [
    path.resolve(process.cwd(), trimmed),
    path.resolve(process.cwd(), '..', trimmed),
    path.resolve(process.cwd(), '..', '..', trimmed),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return trimmed;
}

function loadKeypairFromPath(pathOrJson: string): Keypair {
  // Support inline JSON array (for Vercel where filesystem isn't available)
  const trimmed = pathOrJson.trim();
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(trimmed)));
  }
  const resolved = resolveKeypairPath(trimmed);
  const raw = fs.readFileSync(resolved, 'utf-8');
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
}

function sha256Disc(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u32LE(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function getAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx(params: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  // ATA create instruction data is empty.
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function tokenTransferIx(params: {
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  // SPL Token Transfer instruction = 3, followed by u64 LE amount.
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(params.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Ok | Err>) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    if ((process.env.NEXT_PUBLIC_BRIDGE_ENABLED ?? 'false') !== 'true') {
      res.status(400).json({ ok: false, error: 'Bridge disabled (set NEXT_PUBLIC_BRIDGE_ENABLED=true)' });
      return;
    }

    const {
      userPublicKey,
      userPublicUsdcAta,
      userConfidentialTokenAccount,
      amountUi,
      publicUsdcMint,
    } = req.body || {};

    const user = new PublicKey(String(userPublicKey || ''));
    const userConfidential = new PublicKey(String(userConfidentialTokenAccount || ''));
    const mint = new PublicKey(
      String(publicUsdcMint || process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || process.env.PUBLIC_USDC_MINT || '')
    );

    const publicDecimals = Number(process.env.BRIDGE_PUBLIC_DECIMALS || '6');
    const confidentialDecimals = Number(process.env.BRIDGE_CONFIDENTIAL_DECIMALS || '9');
    const amount = Number(amountUi);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amountUi');

    const publicLamports = BigInt(Math.floor(amount * Math.pow(10, publicDecimals)));
    const confidentialLamports = BigInt(Math.floor(amount * Math.pow(10, confidentialDecimals)));

    const escrow = loadKeypairFromPath(requiredEnv('BRIDGE_ESCROW_KEYPAIR_PATH'));
    const mintAuthorityPath =
      process.env.BRIDGE_CONFIDENTIAL_USDC_MINT_AUTHORITY_KEYPAIR_PATH ||
      process.env.BRIDGE_PAYUSD_MINT_AUTHORITY_KEYPAIR_PATH;
    if (!mintAuthorityPath) {
      throw new Error('BRIDGE_CONFIDENTIAL_USDC_MINT_AUTHORITY_KEYPAIR_PATH not configured');
    }
    const mintAuthority = loadKeypairFromPath(mintAuthorityPath);

    const incoTokenProgramId = new PublicKey(
      process.env.BRIDGE_INCO_TOKEN_PROGRAM_ID ||
      process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID ||
      '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N'
    );
    const incoLightningId = new PublicKey(
      process.env.BRIDGE_INCO_PROGRAM_ID ||
      process.env.NEXT_PUBLIC_INCO_PROGRAM_ID ||
      '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj'
    );
    const confidentialMint = new PublicKey(
      process.env.BRIDGE_CONFIDENTIAL_USDC_MINT ||
        process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT ||
        process.env.BRIDGE_PAYUSD_MINT ||
        process.env.NEXT_PUBLIC_PAYUSD_MINT ||
        ''
    );

    const rpc =
      process.env.BRIDGE_SOLANA_RPC_URL ||
      process.env.SOLANA_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      'https://api.devnet.solana.com';
    const connection = new Connection(rpc, 'confirmed');

    const derivedUserAta = getAssociatedTokenAddress(user, mint);
    const userAta = userPublicUsdcAta ? new PublicKey(String(userPublicUsdcAta)) : derivedUserAta;
    const escrowAta = getAssociatedTokenAddress(escrow.publicKey, mint);

    const ixs: TransactionInstruction[] = [];

    // Ensure user ATA exists and has enough balance for the wrap.
    const userAtaInfo = await connection.getAccountInfo(userAta, 'confirmed');
    if (!userAtaInfo) {
      throw new Error('No public USDC account found. Get devnet USDC in Phantom first.');
    }
    const userBalance = await connection.getTokenAccountBalance(userAta, 'confirmed');
    const userAmount = BigInt(userBalance?.value?.amount || '0');
    if (userAmount < publicLamports) {
      throw new Error(
        `Insufficient public USDC. Need ${publicLamports.toString()} base units, have ${userAmount.toString()}.`
      );
    }

    // Create escrow ATA if missing (payer = user).
    const escrowAtaInfo = await connection.getAccountInfo(escrowAta, 'confirmed');
    if (!escrowAtaInfo) {
      ixs.push(createAssociatedTokenAccountIx({ payer: user, ata: escrowAta, owner: escrow.publicKey, mint }));
    }

    // Transfer public USDC -> escrow (public entry).
    ixs.push(tokenTransferIx({ source: userAta, destination: escrowAta, owner: user, amount: publicLamports }));

    // Mint confidential token to user (private middle funding).
    const { encryptValue } = await import('@inco/solana-sdk/encryption');
    const encryptedHex = await encryptValue(confidentialLamports);
    const encryptedBytes = Buffer.from(encryptedHex, 'hex');
    const mintToData = Buffer.concat([
      sha256Disc('mint_to'),
      u32LE(encryptedBytes.length),
      encryptedBytes,
      u32LE(0), // security zone
    ]);

    ixs.push(
      new TransactionInstruction({
        programId: incoTokenProgramId,
        keys: [
          { pubkey: confidentialMint, isSigner: false, isWritable: true },
          { pubkey: userConfidential, isSigner: false, isWritable: true },
          { pubkey: mintAuthority.publicKey, isSigner: true, isWritable: false },
          { pubkey: incoLightningId, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: mintToData,
      })
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.add(...ixs);

    // Server signs mint authority; client signs as fee payer + token owner.
    tx.partialSign(mintAuthority);

    res.status(200).json({
      ok: true,
      txBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
      feePayer: user.toBase58(),
      userUsdcAta: userAta.toBase58(),
      escrowUsdcAta: escrowAta.toBase58(),
      confidentialMint: confidentialMint.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'wrap build failed' });
  }
}
