import Head from 'next/head';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/router';

import { createIncoTokenAccount } from '../lib/payroll-client';

const WalletButton = dynamic(() => import('../components/WalletButton'), { ssr: false });

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');
const PUBLIC_USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || '11111111111111111111111111111111');

function getAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx(params: { payer: PublicKey; ata: PublicKey; owner: PublicKey; mint: PublicKey }) {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false }, // SystemProgram
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  };
}

export default function BridgePage() {
  const router = useRouter();
  const { connection } = useConnection();
  const wallet = useWallet();

  const [amountUi, setAmountUi] = useState('10');
  const [publicMint, setPublicMint] = useState(PUBLIC_USDC_MINT.toBase58());
  const [confidentialTokenAccount, setConfidentialTokenAccount] = useState('');

  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  const enabled = (process.env.NEXT_PUBLIC_BRIDGE_ENABLED ?? 'false') === 'true';
  const publicMintConfigured = useMemo(() => {
    try {
      const m = new PublicKey(publicMint);
      return !m.equals(new PublicKey('11111111111111111111111111111111'));
    } catch {
      return false;
    }
  }, [publicMint]);

  const userAta = useMemo(() => {
    try {
      if (!wallet.publicKey) return '';
      const mint = new PublicKey(publicMint);
      return getAssociatedTokenAddress(wallet.publicKey, mint).toBase58();
    } catch {
      return '';
    }
  }, [wallet.publicKey, publicMint]);

  useEffect(() => {
    if (!router.isReady) return;
    const qToken = router.query.confidentialTokenAccount;
    const qAmount = router.query.amountUi;
    if (typeof qToken === 'string' && qToken.trim().length > 0) {
      setConfidentialTokenAccount(qToken.trim());
    }
    if (typeof qAmount === 'string' && qAmount.trim().length > 0) {
      setAmountUi(qAmount.trim());
    }
  }, [router.isReady, router.query.amountUi, router.query.confidentialTokenAccount]);

  async function run(label: string, fn: () => Promise<void>) {
    setError('');
    setStatus(`${label}...`);
    try {
      await fn();
      setStatus(`${label}: done`);
    } catch (e: any) {
      setStatus('');
      setError(e?.message || String(e));
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F7F2]">
      <Head>
        <title>Bridge: USDC In/Out</title>
      </Head>

      <header className="bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-[#2D2D2A]">Bridge (Public USDC ↔ Confidential Payroll Token)</h1>
          </div>
          <WalletButton />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-4">
          <Link href="/" className="text-sm text-[#1D3557] underline">
            Back
          </Link>
        </div>

        {!enabled && (
          <div className="rounded-2xl bg-amber-50 p-5 text-sm text-amber-900">
            Bridge is disabled. Set <span className="font-mono">NEXT_PUBLIC_BRIDGE_ENABLED=true</span> in{' '}
            <span className="font-mono">app/.env.local</span>.
          </div>
        )}
        {enabled && !publicMintConfigured && (
          <div className="mt-4 rounded-2xl bg-amber-50 p-5 text-sm text-amber-900">
            Configure <span className="font-mono">NEXT_PUBLIC_PUBLIC_USDC_MINT</span> (a public SPL mint, 6 decimals recommended) in{' '}
            <span className="font-mono">app/.env.local</span>.
          </div>
        )}

        <section className="mt-4 rounded-3xl bg-white p-8 shadow-sm">
          <h2 className="text-2xl font-semibold text-[#2D2D2A]">What This Does</h2>
          <p className="mt-3 text-sm text-gray-700">
            This is the practical real-world model: public stablecoins are used for entry/exit, but payroll runs in a confidential token for the
            private middle. On devnet, this bridge is custodial: the backend signs mint/escrow steps.
          </p>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 p-5">
              <h3 className="font-semibold text-[#2D2D2A]">Inputs</h3>
              <label className="mt-3 block text-xs text-gray-700">
                Public USDC-like mint
                <input
                  value={publicMint}
                  onChange={(e) => setPublicMint(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-gray-700">
                Amount (UI)
                <input
                  value={amountUi}
                  onChange={(e) => setAmountUi(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-gray-700">
                Your public token account (ATA)
                <input value={userAta} readOnly className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm" />
              </label>
              <label className="mt-3 block text-xs text-gray-700">
                Your confidential token account (Inco)
                <input
                  value={confidentialTokenAccount}
                  onChange={(e) => setConfidentialTokenAccount(e.target.value)}
                  placeholder="Paste / create your Inco token account for payroll token"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>

              <button
                disabled={!wallet.publicKey || !publicMintConfigured}
                onClick={() =>
                  run('Create public ATA', async () => {
                    if (!wallet.publicKey) throw new Error('Wallet not connected');
                    const mint = new PublicKey(publicMint);
                    const ata = getAssociatedTokenAddress(wallet.publicKey, mint);
                    const info = await connection.getAccountInfo(ata, 'confirmed');
                    if (info) {
                      setStatus(`Public ATA already exists: ${ata.toBase58()}`);
                      return;
                    }
                    // Create ATA with wallet as payer.
                    const ix = createAssociatedTokenAccountIx({
                      payer: wallet.publicKey,
                      ata,
                      owner: wallet.publicKey,
                      mint,
                    }) as any;
                    const tx = new Transaction().add(ix);
                    const sig = await wallet.sendTransaction(tx, connection);
                    setStatus(`Create ATA tx: ${sig}`);
                  })
                }
                className="mt-4 w-full rounded-xl bg-[#1D3557] px-5 py-3 text-center text-sm font-medium text-white disabled:opacity-50"
              >
                Create Public Token Account (ATA)
              </button>

              <button
                disabled={!wallet.publicKey}
                onClick={() =>
                  run('Create confidential token account', async () => {
                    if (!wallet.publicKey) throw new Error('Wallet not connected');
                    const mint = new PublicKey(process.env.NEXT_PUBLIC_PAYUSD_MINT || '');
                    if (mint.equals(new PublicKey('11111111111111111111111111111111'))) {
                      throw new Error('NEXT_PUBLIC_PAYUSD_MINT not configured');
                    }
                    const { txid, tokenAccount } = await createIncoTokenAccount(connection as Connection, wallet as any, wallet.publicKey, mint);
                    setConfidentialTokenAccount(tokenAccount.toBase58());
                    setStatus(`Created confidential token account: ${tokenAccount.toBase58()} (tx=${txid})`);
                  })
                }
                className="mt-2 w-full rounded-xl border border-gray-300 px-5 py-3 text-center text-sm font-medium disabled:opacity-50"
              >
                Create Confidential Token Account (Inco)
              </button>
            </div>

            <div className="rounded-2xl border border-gray-200 p-5">
              <h3 className="font-semibold text-[#2D2D2A]">Actions</h3>
              <p className="mt-2 text-sm text-gray-600">
                Wrap mints payUSD tokens after a public transfer into bridge escrow. Unwrap returns public tokens after a confidential
                transfer back to escrow.
              </p>

              <button
                disabled={!enabled || !wallet.publicKey || !confidentialTokenAccount || !publicMintConfigured}
                onClick={() =>
                  run('Wrap (USDC -> confidential)', async () => {
                    if (!wallet.publicKey) throw new Error('Wallet not connected');
                    const resp = await fetch('/api/bridge/build-wrap', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        userPublicKey: wallet.publicKey.toBase58(),
                        userPublicUsdcAta: userAta,
                        userConfidentialTokenAccount: confidentialTokenAccount,
                        amountUi,
                        publicUsdcMint: publicMint,
                      }),
                    });
                    const json = await resp.json();
                    if (!resp.ok || !json?.ok) throw new Error(json?.error || `wrap build failed (${resp.status})`);
                    const tx = Transaction.from(Buffer.from(json.txBase64, 'base64'));
                    const sig = await wallet.sendTransaction(tx, connection);
                    setStatus(`Wrap tx sent: ${sig}`);
                  })
                }
                className="mt-4 w-full rounded-xl bg-[#2A9D8F] px-5 py-3 text-center text-sm font-medium text-white disabled:opacity-50"
              >
                Wrap Public {'->'} Confidential
              </button>

              <button
                disabled={!enabled || !wallet.publicKey || !confidentialTokenAccount || !publicMintConfigured}
                onClick={() =>
                  run('Unwrap (confidential -> USDC)', async () => {
                    if (!wallet.publicKey) throw new Error('Wallet not connected');
                    const resp = await fetch('/api/bridge/build-unwrap', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        userPublicKey: wallet.publicKey.toBase58(),
                        userPublicUsdcAta: userAta,
                        userConfidentialTokenAccount: confidentialTokenAccount,
                        amountUi,
                        publicUsdcMint: publicMint,
                      }),
                    });
                    const json = await resp.json();
                    if (!resp.ok || !json?.ok) throw new Error(json?.error || `unwrap build failed (${resp.status})`);
                    const tx = Transaction.from(Buffer.from(json.txBase64, 'base64'));
                    let sig = '';
                    try {
                      if (!wallet.signTransaction) throw new Error('Wallet does not support signTransaction');
                      const signed = await wallet.signTransaction(tx);
                      sig = await connection.sendRawTransaction(signed.serialize(), {
                        skipPreflight: false,
                        maxRetries: 3,
                      });
                    } catch (e: any) {
                      const message = e?.message || String(e);
                      const logs =
                        e?.logs && Array.isArray(e.logs)
                          ? e.logs
                          : e?.transactionLogs && Array.isArray(e.transactionLogs)
                            ? e.transactionLogs
                            : null;
                      const details = logs ? ` | logs: ${logs.join(' → ')}` : '';
                      console.error('Unwrap send failed:', message, logs || '');
                      throw new Error(`Unwrap send failed: ${message}${details}`);
                    }
                    setStatus(`Unwrap tx sent: ${sig}`);
                  })
                }
                className="mt-2 w-full rounded-xl border border-gray-300 px-5 py-3 text-center text-sm font-medium disabled:opacity-50"
              >
                Unwrap Confidential {'->'} Public
              </button>

              {status && <p className="mt-4 rounded bg-green-50 px-3 py-2 text-sm text-green-700">{status}</p>}
              {error && <p className="mt-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
