import type { NextApiRequest, NextApiResponse } from 'next';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import fs from 'fs';

type Ok = {
  ok: true;
  txid: string;
};

type Err = {
  ok: false;
  error: string;
};

function requiredEnv(name: string): string {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function loadKeypairFromPath(pathOrJson: string): Keypair {
  const trimmed = pathOrJson.trim();
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(trimmed)));
  }
  const raw = fs.readFileSync(trimmed, 'utf-8');
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
}

function extractLogs(e: any): string[] {
  if (Array.isArray(e?.logs)) return e.logs as string[];
  if (Array.isArray(e?.transactionLogs)) return e.transactionLogs as string[];
  return [];
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

    const txBase64 = String(req.body?.txBase64 || '').trim();
    if (!txBase64) {
      res.status(400).json({ ok: false, error: 'Missing txBase64' });
      return;
    }

    const rpc =
      process.env.BRIDGE_SOLANA_RPC_URL ||
      process.env.SOLANA_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      'https://api.devnet.solana.com';
    const connection = new Connection(rpc, 'confirmed');
    const escrow = loadKeypairFromPath(requiredEnv('BRIDGE_ESCROW_KEYPAIR_PATH'));

    const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
    tx.partialSign(escrow);

    const sim = await connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = sim.value.logs || [];
      const details = logs.length ? ` | logs: ${logs.join(' -> ')}` : '';
      throw new Error(`Unwrap simulation failed: ${JSON.stringify(sim.value.err)}${details}`);
    }

    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(txid, 'confirmed');

    res.status(200).json({ ok: true, txid });
  } catch (e: any) {
    const logs = extractLogs(e);
    const details = logs.length ? ` | logs: ${logs.join(' -> ')}` : '';
    res.status(500).json({ ok: false, error: `${e?.message || 'submit unwrap failed'}${details}` });
  }
}
