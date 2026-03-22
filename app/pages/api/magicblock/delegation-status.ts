import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { ConnectionMagicRouter } from '@magicblock-labs/ephemeral-rollups-sdk';
import { normalizeMagicblockEndpoint } from '../../../lib/magicblock/index';

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

function extractDelegated(result: DelegationStatusResponse | null | undefined): boolean | null {
  if (!result) return null;
  const delegatedRaw =
    result.delegated ??
    result.isDelegated ??
    result.delegation?.delegated;
  if (typeof delegatedRaw === 'number') return delegatedRaw !== 0;
  if (typeof delegatedRaw === 'boolean') return delegatedRaw;
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pubkey = String(req.query.pubkey || '').trim();
  if (!pubkey) {
    res.status(400).json({ ok: false, error: 'Missing pubkey query param' });
    return;
  }
  let account: PublicKey;
  try {
    account = new PublicKey(pubkey);
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid pubkey' });
    return;
  }

  let routerUrl: string;
  try {
    routerUrl = normalizeMagicblockEndpoint(
      process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL ||
      process.env.MAGICBLOCK_ROUTER_RPC_URL ||
      'https://devnet-router.magicblock.app'
    );
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Invalid router endpoint configuration' });
    return;
  }

  let sdkDelegated: boolean | null = null;
  try {
    const router = new ConnectionMagicRouter(routerUrl, 'confirmed');
    const sdkStatus = await router.getDelegationStatus(account);
    sdkDelegated = Boolean(sdkStatus?.isDelegated);
  } catch {
    // Best-effort only; we'll still try metadata RPC below.
  }

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
      if (sdkDelegated !== null) {
        res.status(200).json({
          ok: true,
          result: {
            delegated: sdkDelegated,
            isDelegated: sdkDelegated,
          },
          warning: 'Router metadata unavailable; used SDK status',
        });
        return;
      }
      res.status(502).json({
        ok: false,
        error: `Router error (${rpcRes.status})`,
      });
      return;
    }

    const rawResult = (json?.result || {}) as DelegationStatusResponse;
    const rawDelegated = extractDelegated(rawResult);
    const delegated = rawDelegated ?? sdkDelegated ?? false;

    res.status(200).json({
      ok: true,
      result: {
        ...rawResult,
        delegated,
        isDelegated: delegated,
      } as DelegationStatusResponse,
      sdk: {
        delegated: sdkDelegated,
      },
    });
  } catch {
    if (sdkDelegated !== null) {
      res.status(200).json({
        ok: true,
        result: {
          delegated: sdkDelegated,
          isDelegated: sdkDelegated,
        },
        warning: 'Router metadata unavailable; used SDK status',
      });
      return;
    }
    res.status(500).json({ ok: false, error: 'Failed to query router' });
  }
}
