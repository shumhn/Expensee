import type { NextApiRequest, NextApiResponse } from 'next';
import { execFile } from 'child_process';
import path from 'path';

const ENABLED = (process.env.ENABLE_DEVNET_SCRIPTS || '').toLowerCase() === 'true';
const LEGACY_V3_ENABLED = (process.env.ENABLE_LEGACY_V3 || '').toLowerCase() === 'true';
const SCRIPT_TIMEOUT_MS = 120_000;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ENABLED) {
    res.status(403).json({ error: 'Devnet scripts are disabled. Set ENABLE_DEVNET_SCRIPTS=true.' });
    return;
  }
  if (!LEGACY_V3_ENABLED) {
    res.status(410).json({ error: 'Legacy v3 devnet route is disabled. Use v4 or set ENABLE_LEGACY_V3=true.' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { nonce } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  if (!nonce || Number.isNaN(Number(nonce))) {
    res.status(400).json({ error: 'Missing or invalid nonce' });
    return;
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'v3-claim-payout.cjs');

  execFile(
    'node',
    [scriptPath],
    {
      timeout: SCRIPT_TIMEOUT_MS,
      env: {
        ...process.env,
        NONCE: String(nonce),
        RPC_URL: process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
      },
    },
    (error, stdout, stderr) => {
      if (error) {
        res.status(500).json({
          error: error.message,
          stdout,
          stderr,
        });
        return;
      }
      res.status(200).json({ ok: true, stdout, stderr });
    }
  );
}
