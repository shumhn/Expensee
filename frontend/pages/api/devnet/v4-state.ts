import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

const ENABLED = (process.env.ENABLE_DEVNET_SCRIPTS || '').toLowerCase() === 'true';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!ENABLED) {
    res.status(403).json({ error: 'Devnet scripts are disabled. Set ENABLE_DEVNET_SCRIPTS=true.' });
    return;
  }

  const repoRoot = process.cwd();
  const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');
  if (!fs.existsSync(statePath)) {
    res.status(404).json({ error: 'devnet-v4-state.json not found' });
    return;
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const data = JSON.parse(raw);
    res.status(200).json({ ok: true, data });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Failed to read state' });
  }
}
