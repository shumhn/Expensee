import type { NextApiRequest, NextApiResponse } from 'next';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { encryptValue } from '@inco/solana-sdk/encryption';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

type Ok = {
    ok: true;
    tx: string;
    amount: number;
};

type Err = { ok: false; error: string };

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

function sha256Disc(name: string): Buffer {
    return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u32LE(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<Ok | Err>
) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    try {
        const { userConfidentialTokenAccount, amountUi } = req.body;
        if (!userConfidentialTokenAccount) {
            return res.status(400).json({ ok: false, error: 'userConfidentialTokenAccount required' });
        }

        const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
        const mintAddress =
            process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT || process.env.NEXT_PUBLIC_PAYUSD_MINT;
        if (!mintAddress || mintAddress === '11111111111111111111111111111111') {
            return res.status(400).json({ ok: false, error: 'USDC Mint not configured' });
        }

        const incoTokenProgramId = new PublicKey(process.env.NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID || '');
        const incoLightningId = new PublicKey(process.env.NEXT_PUBLIC_INCO_PROGRAM_ID || '');

        const keyPath =
            process.env.BRIDGE_CONFIDENTIAL_USDC_MINT_AUTHORITY_KEYPAIR_PATH ||
            process.env.BRIDGE_PAYUSD_MINT_AUTHORITY_KEYPAIR_PATH ||
            process.env.MINT_AUTHORITY_KEYPAIR_PATH ||
            '../keys/payroll-authority.json';

        let authority: Keypair;
        try {
            authority = loadKeypairFromPath(keyPath);
        } catch {
            return res.status(500).json({ ok: false, error: 'Mint authority keypair not found or invalid' });
        }

        const connection = new Connection(rpcUrl, 'confirmed');
        const destPubkey = new PublicKey(userConfidentialTokenAccount);
        const mintPubkey = new PublicKey(mintAddress);

        // Amount: capped for devnet faucet usage
        const requestedAmount = Number(amountUi ?? 1000);
        if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid amountUi' });
        }
        const amountUiCapped = Math.min(Math.max(requestedAmount, 1), 1000);
        const decimals = 9;
        const amountLamports = BigInt(Math.floor(amountUiCapped * Math.pow(10, decimals)));

        // Encrypt amount using Inco SDK
        const encryptedHex = await encryptValue(amountLamports);
        const encryptedBytes = Buffer.from(encryptedHex, 'hex');

        const disc = sha256Disc('mint_to');
        const data = Buffer.concat([
            disc,
            u32LE(encryptedBytes.length),
            encryptedBytes,
            u32LE(0), // security zone (default 0)
        ]);

        const ix = new TransactionInstruction({
            programId: incoTokenProgramId,
            keys: [
                { pubkey: mintPubkey, isSigner: false, isWritable: true },
                { pubkey: destPubkey, isSigner: false, isWritable: true },
                { pubkey: authority.publicKey, isSigner: true, isWritable: false },
                { pubkey: incoLightningId, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data,
        });

        const tx = new Transaction().add(ix);
        tx.feePayer = authority.publicKey;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.sign(authority);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

        return res.status(200).json({ ok: true, tx: sig, amount: amountUiCapped });
    } catch (error: any) {
        console.error('faucet mint payusd error:', error);
        return res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
    }
}
