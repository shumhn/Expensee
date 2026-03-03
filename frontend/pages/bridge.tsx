import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/router';

import { createIncoTokenAccount } from '../lib/payroll-client';
import PageShell from '../components/PageShell';
import ActionResult from '../components/ActionResult';
import { COPY } from '../lib/copy';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSVAR_RENT_PUBKEY = new PublicKey('SysvarRent111111111111111111111111111111111');
const PUBLIC_USDC_MINT = new PublicKey(process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || '11111111111111111111111111111111');
const BRIDGE_LAST_RESULT_KEY = 'ghoststream_bridge_last_result_v1';

function formatActionError(e: any): string {
  const objectFallback =
    e && typeof e === 'object'
      ? (() => {
          try {
            return JSON.stringify(e);
          } catch {
            return '';
          }
        })()
      : '';
  const primary =
    e?.message ||
    e?.error?.message ||
    (typeof e === 'string' ? e : '') ||
    objectFallback ||
    'Unexpected error';
  if (Array.isArray(e?.logs) && e.logs.length > 0) {
    return `${primary} | logs: ${e.logs.join(' -> ')}`;
  }
  return primary;
}

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
  const [cashoutWallet, setCashoutWallet] = useState('');

  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [lastResult, setLastResult] = useState<string>('');

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
  const unwrapDestinationAta = useMemo(() => {
    try {
      const mint = new PublicKey(publicMint);
      const owner =
        cashoutWallet.trim().length > 0
          ? new PublicKey(cashoutWallet.trim())
          : wallet.publicKey;
      if (!owner) return '';
      return getAssociatedTokenAddress(owner, mint).toBase58();
    } catch {
      return '';
    }
  }, [cashoutWallet, wallet.publicKey, publicMint]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(BRIDGE_LAST_RESULT_KEY);
      if (saved) setLastResult(saved);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    const qToken = router.query.confidentialTokenAccount;
    const qAmount = router.query.amountUi;
    const qCashout = router.query.cashoutWallet;
    if (typeof qToken === 'string' && qToken.trim().length > 0) {
      setConfidentialTokenAccount(qToken.trim());
    }
    if (typeof qAmount === 'string' && qAmount.trim().length > 0) {
      setAmountUi(qAmount.trim());
    }
    if (typeof qCashout === 'string' && qCashout.trim().length > 0) {
      setCashoutWallet(qCashout.trim());
    }
  }, [router.isReady, router.query.amountUi, router.query.cashoutWallet, router.query.confidentialTokenAccount]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 7000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 6000);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function run(label: string, fn: () => Promise<void>) {
    const inProgressLabel = `${label}...`;
    setError('');
    setStatus(inProgressLabel);
    try {
      await fn();
      let finalMessage = `${label}: done`;
      setStatus((prev) => {
        if (prev && prev !== inProgressLabel) {
          finalMessage = prev;
          return prev;
        }
        return finalMessage;
      });
      setLastResult(finalMessage);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(BRIDGE_LAST_RESULT_KEY, finalMessage);
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      setStatus('');
      const message = formatActionError(e);
      setError(message);
      setLastResult(`Last failed: ${message}`);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(BRIDGE_LAST_RESULT_KEY, `Last failed: ${message}`);
        } catch {
          // ignore
        }
      }
    }
  }

  return (
    <PageShell
      icon=""
      title="Expensee"
      subtitle="Bridge public and private payroll balances"
      navItems={[
        { href: '/employer', label: COPY.nav.company },
        { href: '/employee', label: COPY.nav.worker },
      ]}
    >
      <Head>
        <title>Move Money In/Out</title>
      </Head>
      <div className="bridge-portal">
        <section className="hero-card setup-hero">
          <p className="hero-eyebrow">Bridge</p>
          <h1 className="hero-title">Move Money In and Out</h1>
          <p className="hero-subtitle">
            Wrap moves public tokens into confidential payroll mode. Unwrap moves confidential balances back to normal wallet tokens.
          </p>
        </section>

        <div className="mb-2">
          <Link href="/" className="text-sm text-[var(--app-primary)] underline">
            Back
          </Link>
        </div>

        {!enabled && (
          <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5 text-sm text-amber-300">
            Bridge is disabled. Set <span className="font-mono">NEXT_PUBLIC_BRIDGE_ENABLED=true</span> in{' '}
            <span className="font-mono">app/.env.local</span>.
          </div>
        )}
        {enabled && !publicMintConfigured && (
          <div className="rounded-2xl border border-amber-300/30 bg-amber-500/10 p-5 text-sm text-amber-300">
            Configure <span className="font-mono">NEXT_PUBLIC_PUBLIC_USDC_MINT</span> (a public SPL mint, 6 decimals recommended) in{' '}
            <span className="font-mono">app/.env.local</span>.
          </div>
        )}

        <section className="panel-card">
          <h2 className="text-2xl font-semibold text-[var(--app-ink)]">What This Does</h2>
          <p className="mt-3 text-sm text-[var(--app-muted)]">
            Use this page to move between normal wallet money and private payroll money.
            Wrap = move into private mode. Unwrap = move back to normal wallet money.
          </p>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)]/40 p-5">
              <h3 className="font-semibold text-[var(--app-ink)]">Inputs</h3>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Public token mint
                <input
                  value={publicMint}
                  onChange={(e) => setPublicMint(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Amount (UI)
                <input
                  value={amountUi}
                  onChange={(e) => setAmountUi(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Your public token account
                <input value={userAta} readOnly className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm" />
              </label>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Wallet to receive money on unwrap (optional)
                <input
                  value={cashoutWallet}
                  onChange={(e) => setCashoutWallet(e.target.value)}
                  placeholder="Leave empty to use your connected wallet"
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Receiver token account
                <input
                  value={unwrapDestinationAta}
                  readOnly
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block text-xs text-[var(--app-muted)]">
                Your private payroll account
                <input
                  value={confidentialTokenAccount}
                  onChange={(e) => setConfidentialTokenAccount(e.target.value)}
                  placeholder="Paste / create your Inco token account for payroll token"
                  className="mt-1 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-sm"
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
                className="mt-4 w-full premium-btn premium-btn-primary disabled:opacity-50"
              >
                Create Public Token Account
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
                className="mt-2 w-full premium-btn premium-btn-secondary disabled:opacity-50"
              >
                Create Private Payroll Account
              </button>
            </div>

            <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)]/40 p-5">
              <h3 className="font-semibold text-[var(--app-ink)]">Actions</h3>
              <p className="mt-2 text-sm text-[var(--app-muted)]">
                Wrap moves money from public wallet to private payroll.
                Unwrap moves money from private payroll back to public wallet.
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
                    const raw = await resp.text();
                    let json: any = null;
                    try {
                      json = raw ? JSON.parse(raw) : null;
                    } catch {
                      throw new Error(`wrap build failed (${resp.status}): ${raw || 'invalid JSON response'}`);
                    }
                    if (!resp.ok || !json?.ok) throw new Error(json?.error || `wrap build failed (${resp.status})`);
                    const tx = Transaction.from(Buffer.from(json.txBase64, 'base64'));
                    const sig = await wallet.sendTransaction(tx, connection);
                    setStatus(`Wrap tx sent: ${sig}`);
                  })
                }
                className="mt-4 w-full premium-btn premium-btn-secondary disabled:opacity-50"
              >
                Wrap: Public to Private
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
                        userPublicUsdcAta: unwrapDestinationAta || userAta,
                        cashoutWallet: cashoutWallet.trim() || null,
                        userConfidentialTokenAccount: confidentialTokenAccount,
                        amountUi,
                        publicUsdcMint: publicMint,
                      }),
                    });
                    const raw = await resp.text();
                    let json: any = null;
                    try {
                      json = raw ? JSON.parse(raw) : null;
                    } catch {
                      throw new Error(`unwrap build failed (${resp.status}): ${raw || 'invalid JSON response'}`);
                    }
                    if (!resp.ok || !json?.ok) throw new Error(json?.error || `unwrap build failed (${resp.status})`);
                    const tx = Transaction.from(Buffer.from(json.txBase64, 'base64'));
                    const sig = await wallet.sendTransaction(tx, connection);
                    setStatus(`Unwrap tx sent: ${sig}`);
                  })
                }
                className="mt-2 w-full premium-btn premium-btn-primary disabled:opacity-50"
              >
                Unwrap: Private to Public
              </button>

              {status ? <ActionResult kind="success">{status}</ActionResult> : null}
              {error ? <ActionResult kind="error">{error}</ActionResult> : null}
              {!status && !error && lastResult ? (
                <ActionResult kind="info">Last result: {lastResult}</ActionResult>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
