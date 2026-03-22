import type { NextApiRequest, NextApiResponse } from 'next';
import { getMongoDb, isMongoConfigured } from '../../../lib/server/mongodb';

type RunStateResponse =
  | {
      ok: true;
      enabled: boolean;
      state: Record<string, unknown> | null;
      updatedAt?: string | null;
    }
  | {
      ok: false;
      enabled: boolean;
      error: string;
    };

type RunStateDoc = {
  owner: string;
  scope: string;
  state: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

function readOwner(req: NextApiRequest): string {
  if (req.method === 'GET' || req.method === 'DELETE') {
    const value = req.query.owner;
    return typeof value === 'string' ? value.trim() : '';
  }
  const value = req.body?.owner;
  return typeof value === 'string' ? value.trim() : '';
}

function readScope(req: NextApiRequest): string {
  if (req.method === 'GET' || req.method === 'DELETE') {
    const value = req.query.scope;
    return typeof value === 'string' && value.trim() ? value.trim() : 'employer';
  }
  const value = req.body?.scope;
  return typeof value === 'string' && value.trim() ? value.trim() : 'employer';
}

function isLikelyPubkey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<RunStateResponse>) {
  if (!isMongoConfigured()) {
    return res.status(200).json({ ok: true, enabled: false, state: null, updatedAt: null });
  }

  const owner = readOwner(req);
  const scope = readScope(req);

  if (!owner || !isLikelyPubkey(owner)) {
    return res.status(400).json({
      ok: false,
      enabled: true,
      error: 'Invalid owner wallet',
    });
  }

  try {
    const db = await getMongoDb();
    const collection = db.collection<RunStateDoc>('agent_run_state');
    await collection.createIndex({ owner: 1, scope: 1 }, { unique: true });

    if (req.method === 'GET') {
      const doc = await collection.findOne({ owner, scope });
      return res.status(200).json({
        ok: true,
        enabled: true,
        state: doc?.state || null,
        updatedAt: doc?.updatedAt?.toISOString?.() || null,
      });
    }

    if (req.method === 'POST') {
      const rawState = req.body?.state;
      if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
        return res.status(400).json({
          ok: false,
          enabled: true,
          error: 'state must be an object',
        });
      }

      const encoded = JSON.stringify(rawState);
      if (encoded.length > 200_000) {
        return res.status(413).json({
          ok: false,
          enabled: true,
          error: 'state payload too large',
        });
      }

      const now = new Date();
      await collection.updateOne(
        { owner, scope },
        {
          $set: {
            state: rawState as Record<string, unknown>,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
            owner,
            scope,
          },
        },
        { upsert: true }
      );

      return res.status(200).json({
        ok: true,
        enabled: true,
        state: rawState as Record<string, unknown>,
        updatedAt: now.toISOString(),
      });
    }

    if (req.method === 'DELETE') {
      await collection.deleteOne({ owner, scope });
      return res.status(200).json({
        ok: true,
        enabled: true,
        state: null,
        updatedAt: null,
      });
    }

    res.setHeader('Allow', 'GET,POST,DELETE');
    return res.status(405).json({
      ok: false,
      enabled: true,
      error: 'Method not allowed',
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      enabled: true,
      error: e?.message || 'Unexpected server error',
    });
  }
}

