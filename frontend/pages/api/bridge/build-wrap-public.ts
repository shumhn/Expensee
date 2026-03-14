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

type Ok = {
  ok: true;
  txBase64: string;
  feePayer: string;
  userUsdcAta: string;
  escrowUsdcAta: string;
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
  const trimmed = pathOrJson.trim();
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(trimmed)));
  }
  const resolved = resolveKeypairPath(trimmed);
  const raw = fs.readFileSync(resolved, 'utf-8');
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
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
      amountUi,
      publicUsdcMint,
    } = req.body || {};

    const user = new PublicKey(String(userPublicKey || ''));
    const mint = new PublicKey(
      String(publicUsdcMint || process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || process.env.PUBLIC_USDC_MINT || '')
    );

    const publicDecimals = Number(process.env.BRIDGE_PUBLIC_DECIMALS || '6');
    const amount = Number(amountUi);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amountUi');

    const publicLamports = BigInt(Math.floor(amount * Math.pow(10, publicDecimals)));

    const escrow = loadKeypairFromPath(requiredEnv('BRIDGE_ESCROW_KEYPAIR_PATH'));

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

    const escrowAtaInfo = await connection.getAccountInfo(escrowAta, 'confirmed');
    if (!escrowAtaInfo) {
      ixs.push(createAssociatedTokenAccountIx({ payer: user, ata: escrowAta, owner: escrow.publicKey, mint }));
    }

    ixs.push(tokenTransferIx({ source: userAta, destination: escrowAta, owner: user, amount: publicLamports }));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.add(...ixs);

    res.status(200).json({
      ok: true,
      txBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
      feePayer: user.toBase58(),
      userUsdcAta: userAta.toBase58(),
      escrowUsdcAta: escrowAta.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'wrap public build failed' });
  }
}
