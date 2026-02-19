import type { NextApiRequest, NextApiResponse } from 'next';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

type RevealOk = {
  ok: true;
  salaryLamportsPerSec: string;
  accruedLamportsCheckpoint: string;
  signer: string; // which address performed the attested decrypt
};

type RevealErr = {
  ok: false;
  error: string;
};

function sha256(buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(buf).digest();
}

function readU128LE(buf16: Buffer): bigint {
  let out = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    out = out * 256n + BigInt(buf16[i] || 0);
  }
  return out;
}

function loadKeypairFromPath(p: string): Keypair {
  const raw = fs.readFileSync(p, 'utf-8');
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
}

function defaultRevealKeypairPath(): string | null {
  const env = process.env.INCO_REVEAL_KEYPAIR_PATH;
  if (env && fs.existsSync(env)) return env;

  // Try common local-dev locations.
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'keys', 'payroll-authority.json'),
    path.join(cwd, '..', 'keys', 'payroll-authority.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function buildEmployeeProofMessage(params: {
  employer: string;
  streamIndex: number;
  employee: string;
  ts: number;
}): Buffer {
  // Stable, explicit message that the employee signs to authorize a reveal request.
  const msg =
    `Expensee Reveal Earnings\n` +
    `employer=${params.employer}\n` +
    `stream_index=${params.streamIndex}\n` +
    `employee=${params.employee}\n` +
    `ts=${params.ts}\n`;
  return Buffer.from(msg, 'utf-8');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<RevealOk | RevealErr>) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const {
      employerWallet,
      streamIndex,
      employeeWallet,
      ts,
      signatureBase58,
      payrollProgramId,
      readRpcUrl,
    } = req.body || {};

    if (typeof employerWallet !== 'string' || employerWallet.length < 20) {
      res.status(400).json({ ok: false, error: 'Invalid employerWallet' });
      return;
    }
    if (typeof employeeWallet !== 'string' || employeeWallet.length < 20) {
      res.status(400).json({ ok: false, error: 'Invalid employeeWallet' });
      return;
    }
    const idx = Number(streamIndex);
    if (!Number.isFinite(idx) || idx < 0) {
      res.status(400).json({ ok: false, error: 'Invalid streamIndex' });
      return;
    }
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || tsNum <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid ts' });
      return;
    }
    if (typeof signatureBase58 !== 'string' || signatureBase58.length < 20) {
      res.status(400).json({ ok: false, error: 'Invalid signatureBase58' });
      return;
    }

    // Basic replay protection window (5 minutes).
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > 300) {
      res.status(400).json({ ok: false, error: 'Signature timestamp too old/new' });
      return;
    }

    const programId = new PublicKey(
      typeof payrollProgramId === 'string' && payrollProgramId.length > 20
        ? payrollProgramId
        : process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || 'CgRkrU26uERpZEPXUQ2ANXgPMFHXPrX4bFaM5UHFdPEh'
    );

    const rpc =
      (typeof readRpcUrl === 'string' && readRpcUrl.length > 10
        ? readRpcUrl
        : process.env.SOLANA_READ_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL) ||
      'https://api.devnet.solana.com';
    const connection = new Connection(rpc, 'confirmed');

    const employerPk = new PublicKey(employerWallet);
    const employeePk = new PublicKey(employeeWallet);

    // Verify employee signature (proof of request).
    const msg = buildEmployeeProofMessage({
      employer: employerPk.toBase58(),
      streamIndex: idx,
      employee: employeePk.toBase58(),
      ts: tsNum,
    });
    const sigBytes = bs58.decode(signatureBase58);
    const okSig = nacl.sign.detached.verify(msg, sigBytes, employeePk.toBytes());
    if (!okSig) {
      res.status(401).json({ ok: false, error: 'Invalid employee signature' });
      return;
    }

    // Derive PDAs (must match on-chain).
    const [businessPda] = PublicKey.findProgramAddressSync([Buffer.from('business'), employerPk.toBuffer()], programId);
    const idxBuf = Buffer.alloc(8);
    idxBuf.writeBigUInt64LE(BigInt(idx));
    const [streamPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('employee_v2'), businessPda.toBuffer(), idxBuf],
      programId
    );

    const info = await connection.getAccountInfo(streamPda, 'confirmed');
    if (!info) {
      res.status(404).json({ ok: false, error: `Stream account not found: ${streamPda.toBase58()}` });
      return;
    }

    // Verify this employee is authorized for this stream via auth hash.
    // Layout matches app/lib/payroll-client.ts.
    const data = Buffer.from(info.data);
    const authHash = data.subarray(48, 80);
    const expected = sha256(Buffer.from(employeePk.toBytes()));
    if (!authHash.equals(expected)) {
      res.status(403).json({ ok: false, error: 'Employee not authorized for this stream' });
      return;
    }

    const salaryHandle32 = data.subarray(112, 144);
    const accruedHandle32 = data.subarray(144, 176);
    const salaryHandle = readU128LE(Buffer.from(salaryHandle32.subarray(0, 16))).toString();
    const accruedHandle = readU128LE(Buffer.from(accruedHandle32.subarray(0, 16))).toString();

    const kpPath = defaultRevealKeypairPath();
    if (!kpPath) {
      res.status(500).json({
        ok: false,
        error:
          'Server reveal keypair not configured. Set INCO_REVEAL_KEYPAIR_PATH (server-only) to a keypair that can decrypt this stream.',
      });
      return;
    }
    const revealKeypair = loadKeypairFromPath(kpPath);

    const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
    const result = await decrypt([salaryHandle, accruedHandle], {
      address: revealKeypair.publicKey,
      signMessage: async (message: Uint8Array) => nacl.sign.detached(message, revealKeypair.secretKey),
    });

    res.status(200).json({
      ok: true,
      salaryLamportsPerSec: String(result.plaintexts[0] || '0'),
      accruedLamportsCheckpoint: String(result.plaintexts[1] || '0'),
      signer: revealKeypair.publicKey.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Reveal failed' });
  }
}

