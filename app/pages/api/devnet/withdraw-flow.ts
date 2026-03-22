import type { NextApiRequest, NextApiResponse } from 'next';
import { execFile } from 'child_process';
import path from 'path';

const ENABLED = (process.env.ENABLE_DEVNET_SCRIPTS || '').toLowerCase() === 'true';
const SCRIPT_TIMEOUT_MS = 180_000;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ENABLED) {
    res.status(403).json({ error: 'Devnet scripts are disabled. Set ENABLE_DEVNET_SCRIPTS=true.' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const scriptPath = path.join(process.cwd(), 'scripts', 'v4-withdraw-flow.cjs');
  const body =
    typeof req.body === 'string' ? (req.body ? JSON.parse(req.body) : {}) : req.body || {};
  const businessIndex = body?.businessIndex;
  const employeeIndex = body?.employeeIndex;
  const flowMode = body?.mode;
  const skipRequest = body?.skipRequest;

  execFile(
    'node',
    [scriptPath],
    {
      timeout: SCRIPT_TIMEOUT_MS,
      env: {
        ...process.env,
        RPC_URL: process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
        ...(Number.isFinite(Number(businessIndex)) ? { BUSINESS_INDEX: String(businessIndex) } : {}),
        ...(Number.isFinite(Number(employeeIndex)) ? { EMPLOYEE_INDEX: String(employeeIndex) } : {}),
        ...(flowMode ? { FLOW_MODE: String(flowMode) } : {}),
        ...(skipRequest ? { SKIP_REQUEST_WITHDRAW: 'true' } : {}),
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
