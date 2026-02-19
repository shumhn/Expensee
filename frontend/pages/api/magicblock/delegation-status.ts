import type { NextApiRequest, NextApiResponse } from 'next';

type DelegationStatusResponse = {
  delegated?: boolean;
  isDelegated?: boolean;
  fqdn?: string;
  endpoint?: string;
  delegation?: {
    fqdn?: string;
    endpoint?: string;
    delegated?: boolean | number;
  };
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pubkey = String(req.query.pubkey || '').trim();
  if (!pubkey) {
    res.status(400).json({ ok: false, error: 'Missing pubkey query param' });
    return;
  }

  const routerUrl = (process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL ||
    process.env.MAGICBLOCK_ROUTER_RPC_URL ||
    'https://devnet-router.magicblock.app').replace(/\/+$/, '');

  try {
    const rpcRes = await fetch(routerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getDelegationStatus',
        params: [pubkey],
      }),
    });

    const json = await rpcRes.json();
    if (!rpcRes.ok || json?.error) {
      res.status(502).json({
        ok: false,
        error: json?.error?.message || `Router error (${rpcRes.status})`,
      });
      return;
    }

    res.status(200).json({ ok: true, result: (json?.result || {}) as DelegationStatusResponse });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to query router' });
  }
}

