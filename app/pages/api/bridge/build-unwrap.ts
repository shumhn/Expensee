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
  escrowConfidentialTokenAccount: string;
};

type Err = { ok: false; error: string };

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');

// Inco Token transfer discriminator: sha256("global:transfer")[0..8]
const INCO_TRANSFER_DISCRIMINATOR = Buffer.from([0xa3, 0x34, 0xc8, 0xe7, 0x8c, 0x03, 0x45, 0xba]);

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

function incoTransferIx(params: {
  incoTokenProgramId: PublicKey;
  incoLightningId: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  encryptedAmount: Buffer;
  inputType: number; // 0 = hex bytes
}): TransactionInstruction {
  const data = Buffer.concat([
    INCO_TRANSFER_DISCRIMINATOR,
    u32LE(params.encryptedAmount.length),
    params.encryptedAmount,
    Buffer.from([params.inputType & 0xff]),
  ]);

  return new TransactionInstruction({
    programId: params.incoTokenProgramId,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.destination, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: params.incoLightningId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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
      cashoutWallet,
    } = req.body || {};

    const user = new PublicKey(String(userPublicKey || ''));
    const userConfidential = new PublicKey(String(userConfidentialTokenAccount || ''));
    const mint = new PublicKey(
      String(publicUsdcMint || process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || process.env.PUBLIC_USDC_MINT || '')
    );

    const escrow = loadKeypairFromPath(requiredEnv('BRIDGE_ESCROW_KEYPAIR_PATH'));
    const escrowConfidential = new PublicKey(requiredEnv('BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT'));

    const publicDecimals = Number(process.env.BRIDGE_PUBLIC_DECIMALS || '6');
    const confidentialDecimals = Number(process.env.BRIDGE_CONFIDENTIAL_DECIMALS || '9');
    const amount = Number(amountUi);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid amountUi');

    const publicLamports = BigInt(Math.floor(amount * Math.pow(10, publicDecimals)));
    const confidentialLamports = BigInt(Math.floor(amount * Math.pow(10, confidentialDecimals)));

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

    const rpc =
      process.env.BRIDGE_SOLANA_RPC_URL ||
      process.env.SOLANA_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      'https://api.devnet.solana.com';
    const connection = new Connection(rpc, 'confirmed');

    // Guardrail: the connected wallet must own the private payroll account used as source.
    const userConfidentialInfo = await connection.getAccountInfo(userConfidential, 'confirmed');
    if (!userConfidentialInfo) {
      throw new Error('Private payroll account not found');
    }
    if (!userConfidentialInfo.owner.equals(incoTokenProgramId)) {
      throw new Error('Private payroll account is not an Inco token account');
    }
    if (userConfidentialInfo.data.length < 72) {
      throw new Error('Private payroll account data is invalid');
    }
    const confidentialOwner = new PublicKey(userConfidentialInfo.data.subarray(40, 72));
    if (!confidentialOwner.equals(user)) {
      throw new Error(
        `This private payroll account is owned by ${confidentialOwner.toBase58()}. Connect that wallet to unwrap.`
      );
    }

    const cashoutOwner =
      typeof cashoutWallet === 'string' && cashoutWallet.trim().length > 0
        ? new PublicKey(cashoutWallet.trim())
        : user;

    const derivedUserAta = getAssociatedTokenAddress(cashoutOwner, mint);
    const userAta = userPublicUsdcAta ? new PublicKey(String(userPublicUsdcAta)) : derivedUserAta;
    const escrowAta = getAssociatedTokenAddress(escrow.publicKey, mint);

    const ixs: TransactionInstruction[] = [];

    // Create destination ATA if missing (payer = escrow so worker doesn't need SOL to cash out).
    const userAtaInfo = await connection.getAccountInfo(userAta, 'confirmed');
    if (!userAtaInfo) {
      ixs.push(createAssociatedTokenAccountIx({ payer: escrow.publicKey, ata: userAta, owner: cashoutOwner, mint }));
    }

    // Create escrow ATA if missing (payer = escrow).
    const escrowAtaInfo = await connection.getAccountInfo(escrowAta, 'confirmed');
    if (!escrowAtaInfo) {
      ixs.push(createAssociatedTokenAccountIx({ payer: escrow.publicKey, ata: escrowAta, owner: escrow.publicKey, mint }));
    }

    // Fail early with a clear message if bridge escrow has no public liquidity for cash-out.
    const escrowUiBalance = await connection.getTokenAccountBalance(escrowAta, 'confirmed').catch(() => null);
    const escrowAmount = escrowUiBalance?.value?.amount ? BigInt(escrowUiBalance.value.amount) : 0n;
    if (escrowAmount < publicLamports) {
      throw new Error(
        `Bridge escrow has insufficient public USDC balance for unwrap. required=${publicLamports.toString()} available=${escrowAmount.toString()}`
      );
    }

    // Confidential transfer from user -> escrow (private exit from payroll token).
    const { encryptValue } = await import('@inco/solana-sdk/encryption');
    const encryptedHex = await encryptValue(confidentialLamports);
    const encryptedBytes = Buffer.from(encryptedHex, 'hex');

    ixs.push(
      incoTransferIx({
        incoTokenProgramId,
        incoLightningId,
        source: userConfidential,
        destination: escrowConfidential,
        authority: user,
        encryptedAmount: encryptedBytes,
        inputType: 0,
      })
    );

    // Public USDC transfer from escrow -> user (public cash-out).
    ixs.push(tokenTransferIx({ source: escrowAta, destination: userAta, owner: escrow.publicKey, amount: publicLamports }));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.feePayer = user;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.add(...ixs);

    // Co-sign with escrow here so the wallet can submit in one step (same UX as wrap).
    tx.partialSign(escrow);

    res.status(200).json({
      ok: true,
      txBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
      feePayer: user.toBase58(),
      userUsdcAta: userAta.toBase58(),
      escrowUsdcAta: escrowAta.toBase58(),
      escrowConfidentialTokenAccount: escrowConfidential.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'unwrap build failed' });
  }
}
