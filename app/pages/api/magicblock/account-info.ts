import type { NextApiRequest, NextApiResponse } from 'next';

const ALLOWED_HOSTS = new Set([
  'devnet-router.magicblock.app',
  'devnet-eu.magicblock.app',
  'devnet-us.magicblock.app',
  'devnet-as.magicblock.app',
]);

function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  if (url.protocol !== 'https:') {
    throw new Error('Only https endpoints are allowed');
  }
  if (!ALLOWED_HOSTS.has(url.host)) {
    throw new Error(`Endpoint host not allowed: ${url.host}`);
  }
  return url.toString().replace(/\/+$/, '');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pubkey = String(req.query.pubkey || '').trim();
  const endpointRaw = String(req.query.endpoint || '').trim();
  if (!pubkey) {
    res.status(400).json({ ok: false, error: 'Missing pubkey query param' });
    return;
  }
  if (!endpointRaw) {
    res.status(400).json({ ok: false, error: 'Missing endpoint query param' });
    return;
  }

  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(endpointRaw);
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || 'Invalid endpoint' });
    return;
  }

  try {
    const rpcRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [pubkey, { encoding: 'base64' }],
      }),
    });
    const json = await rpcRes.json();
    if (!rpcRes.ok || json?.error) {
      res.status(502).json({ ok: false, error: json?.error?.message || `RPC error (${rpcRes.status})` });
      return;
    }
    res.status(200).json({ ok: true, result: json?.result || null });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to query endpoint' });
  }
}

