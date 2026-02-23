import type { NextApiRequest, NextApiResponse } from 'next';
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
} from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import fs from 'fs';

type Ok = {
    ok: true;
    tx: string;
};

type Err = { ok: false; error: string };

function loadKeypairFromPath(pathOrJson: string): Keypair {
    const trimmed = pathOrJson.trim();
    if (trimmed.startsWith('[')) {
        return Keypair.fromSecretKey(new Uint8Array(JSON.parse(trimmed)));
    }
    const raw = fs.readFileSync(trimmed, 'utf-8');
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(new Uint8Array(arr));
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse<Ok | Err>
) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    try {
        const { destinationWallet } = req.body;
        if (!destinationWallet) {
            return res.status(400).json({ ok: false, error: 'destinationWallet required' });
        }

        const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
        const mintAddress = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT;
        if (!mintAddress || mintAddress === '11111111111111111111111111111111') {
            return res.status(400).json({ ok: false, error: 'Public USDC Mint not configured' });
        }

        const keyPath =
            process.env.MINT_AUTHORITY_KEYPAIR_PATH ||
            process.env.BRIDGE_PAYUSD_MINT_AUTHORITY_KEYPAIR_PATH ||
            '../keys/payroll-authority.json';

        let authority: Keypair;
        try {
            authority = loadKeypairFromPath(keyPath);
        } catch {
            return res.status(500).json({ ok: false, error: 'Mint authority keypair not found or invalid on server' });
        }

        const connection = new Connection(rpcUrl, 'confirmed');
        const destPubkey = new PublicKey(destinationWallet);
        const mintPubkey = new PublicKey(mintAddress);

        // Amount: 1,000 USDC (6 decimals)
        const amountUi = 1000;
        const decimals = 6;
        const amount = BigInt(Math.floor(amountUi * Math.pow(10, decimals)));

        // Get or Create ATA
        const ata = await getOrCreateAssociatedTokenAccount(
            connection,
            authority,
            mintPubkey,
            destPubkey
        );

        // Mint Tokens
        const tx = await mintTo(
            connection,
            authority,
            mintPubkey,
            ata.address,
            authority,
            amount
        );

        return res.status(200).json({ ok: true, tx });
    } catch (error: any) {
        console.error('faucet mint usdc error:', error);
        return res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
    }
}
