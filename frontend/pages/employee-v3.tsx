import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import Head from 'next/head';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import ActionResult from '../components/ActionResult';
import PageShell from '../components/PageShell';
import {
  PAYUSD_MINT,
  claimPayoutV3,
  createIncoTokenAccount,
  getBusinessV3PDA,
  getEmployeeV3Account,
  getEmployeeV3PDA,
  getMasterVaultV3PDA,
  getShieldedPayoutV3Account,
  getShieldedPayoutV3PDA,
  requestWithdrawV3,
} from '../lib/payroll-client';

const LEGACY_V3_ENABLED = (process.env.NEXT_PUBLIC_ENABLE_LEGACY_V3 || '').toLowerCase() === 'true';

function parseIndex(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function mustPubkey(label: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${label} public key`);
  }
}

export default function EmployeeV3Page() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastTx, setLastTx] = useState<{ label: string; sig: string } | null>(null);

  const [businessIndexInput, setBusinessIndexInput] = useState('0');
  const [employeeIndexInput, setEmployeeIndexInput] = useState('0');
  const [nonceInput, setNonceInput] = useState('0');
  const [claimerTokenAccount, setClaimerTokenAccount] = useState('');
  const [payoutTokenAccount, setPayoutTokenAccount] = useState('');
  const [autoAllow, setAutoAllow] = useState(true);
  const [devnetNonce, setDevnetNonce] = useState('');
  const [devnetBusy, setDevnetBusy] = useState(false);
  const [devnetOutput, setDevnetOutput] = useState('');
  const [devnetError, setDevnetError] = useState('');

  const [employee, setEmployee] = useState<Awaited<ReturnType<typeof getEmployeeV3Account>>>(null);
  const [payout, setPayout] = useState<Awaited<ReturnType<typeof getShieldedPayoutV3Account>>>(null);

  const businessIndex = useMemo(() => parseIndex(businessIndexInput), [businessIndexInput]);
  const employeeIndex = useMemo(() => parseIndex(employeeIndexInput), [employeeIndexInput]);
  const nonce = useMemo(() => parseIndex(nonceInput), [nonceInput]);

  const [masterVaultPda] = useMemo(() => getMasterVaultV3PDA(), []);
  const businessPda = useMemo(() => {
    if (businessIndex === null) return null;
    return getBusinessV3PDA(masterVaultPda, businessIndex)[0];
  }, [businessIndex, masterVaultPda]);
  const employeePda = useMemo(() => {
    if (!businessPda || employeeIndex === null) return null;
    return getEmployeeV3PDA(businessPda, employeeIndex)[0];
  }, [businessPda, employeeIndex]);
  const payoutPda = useMemo(() => {
    if (!businessPda || employeeIndex === null || nonce === null) return null;
    return getShieldedPayoutV3PDA(businessPda, employeeIndex, nonce)[0];
  }, [businessPda, employeeIndex, nonce]);

  const runAction = async <T,>(label: string, action: () => Promise<T>) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const res = await action();
      const txid = typeof res === 'string' ? res : (res as any)?.txid;
      if (txid) {
        setLastTx({ label, sig: txid });
        setMessage(`${label} confirmed: ${txid}`);
      } else {
        setMessage(`${label} completed.`);
      }
      return res;
    } catch (e: any) {
      setError(e?.message || `Failed to ${label.toLowerCase()}`);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runDevnetAction = async (endpoint: string, body?: Record<string, any>) => {
    setDevnetBusy(true);
    setDevnetOutput('');
    setDevnetError('');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error || 'Request failed');
      }
      const output = String(json?.stdout || '').trim();
      setDevnetOutput(output || 'Completed.');
    } catch (e: any) {
      setDevnetError(e?.message || 'Failed to run devnet action');
    } finally {
      setDevnetBusy(false);
    }
  };

  const refreshEmployee = async () => {
    if (!businessPda || employeeIndex === null) {
      setError('Business index + employee index are required.');
      return;
    }
    await runAction('Refresh employee', async () => {
      const account = await getEmployeeV3Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      return account;
    });
  };

  const refreshPayout = async () => {
    if (!businessPda || employeeIndex === null || nonce === null) {
      setError('Business index + employee index + nonce are required.');
      return;
    }
    await runAction('Refresh payout', async () => {
      const account = await getShieldedPayoutV3Account(connection, businessPda, employeeIndex, nonce);
      setPayout(account);
      if (account?.payoutTokenAccount) {
        setPayoutTokenAccount(account.payoutTokenAccount.toBase58());
      }
      return account;
    });
  };

  if (!LEGACY_V3_ENABLED) {
    return (
      <PageShell
        icon=""
        title="Expensee"
        subtitle="Employee v3 (disabled)"
        navItems={[
          { href: '/employee', label: 'Employee' },
          { href: '/employer', label: 'Employer' },
        ]}
      >
        <Head>
          <title>Expensee Employee v3 | Disabled</title>
        </Head>
        <section className="panel-card">
          <p className="text-sm text-gray-700">
            Legacy v3 is disabled. Use the v4 employee portal at{' '}
            <Link href="/employee" className="underline font-semibold">
              /employee
            </Link>
            .
          </p>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell
      icon=""
      title="Expensee"
      subtitle="Employee v3 (privacy-first)"
      navItems={[
        { href: '/employee', label: 'Employee' },
        { href: '/employer', label: 'Employer' },
      ]}
    >
      <Head>
        <title>Expensee Employee v3 | Privacy-First Payroll</title>
      </Head>

      <div className="space-y-6">
        {!wallet.connected ? (
          <section className="panel-card">
            <p className="text-sm text-gray-700">Connect a wallet to continue.</p>
          </section>
        ) : (
          <>
            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Payroll Context</h2>
              <p className="mt-1 text-sm text-gray-600">
                Enter the business + employee index to load your v3 payroll record.
              </p>
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={businessIndexInput}
                    onChange={(e) => setBusinessIndexInput(e.target.value)}
                    placeholder="Business index"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={employeeIndexInput}
                    onChange={(e) => setEmployeeIndexInput(e.target.value)}
                    placeholder="Employee index"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="text-xs text-gray-500 break-all">
                  Business PDA: {businessPda ? businessPda.toBase58() : '—'}
                </div>
                <div className="text-xs text-gray-500 break-all">
                  Employee PDA: {employeePda ? employeePda.toBase58() : '—'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void refreshEmployee()}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Load Employee Record
                  </button>
                </div>
                {employee ? (
                  <div className="text-xs text-gray-600">
                    Active: {employee.isActive ? 'yes' : 'no'} · Last settle: {employee.lastSettleTime}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Request Withdraw</h2>
              <p className="mt-1 text-sm text-gray-600">
                Create a v3 withdraw request. The keeper will process it into a shielded payout.
              </p>
              <div className="mt-4 space-y-3">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={autoAllow}
                    onChange={(e) => setAutoAllow(e.target.checked)}
                  />
                  Auto-grant Inco allowance for your employee ID handle
                </label>
                <button
                  onClick={() => {
                    if (!businessPda || employeeIndex === null) {
                      setError('Business index + employee index are required.');
                      return;
                    }
                    return runAction('Request withdraw', () =>
                      requestWithdrawV3(connection, wallet, businessPda, employeeIndex, autoAllow)
                    );
                  }}
                  disabled={busy || !businessPda}
                  className="premium-btn premium-btn-primary disabled:opacity-50"
                >
                  Request Withdraw
                </button>
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Claim Shielded Payout</h2>
              <p className="mt-1 text-sm text-gray-600">
                Once the keeper settles your request, claim the payout by nonce.
              </p>
              <div className="mt-4 space-y-3">
                <input
                  value={nonceInput}
                  onChange={(e) => setNonceInput(e.target.value)}
                  placeholder="Payout nonce"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="text-xs text-gray-500 break-all">
                  Payout PDA: {payoutPda ? payoutPda.toBase58() : '—'}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={payoutTokenAccount}
                    onChange={(e) => setPayoutTokenAccount(e.target.value)}
                    placeholder="Payout token account"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={claimerTokenAccount}
                    onChange={(e) => setClaimerTokenAccount(e.target.value)}
                    placeholder="Your token account (destination)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!wallet.publicKey) {
                        setError('Wallet not connected.');
                        return;
                      }
                      const res = await runAction('Create destination token account', () =>
                        createIncoTokenAccount(connection, wallet, wallet.publicKey!, PAYUSD_MINT)
                      );
                      if (res && typeof res === 'object' && 'tokenAccount' in res) {
                        setClaimerTokenAccount((res as any).tokenAccount.toBase58());
                      }
                    }}
                    disabled={busy}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Create Destination Token Account
                  </button>
                  <button
                    onClick={() => void refreshPayout()}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Load Payout
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (!businessPda || employeeIndex === null || nonce === null) {
                      setError('Business index + employee index + nonce are required.');
                      return;
                    }
                    if (!payoutTokenAccount.trim() || !claimerTokenAccount.trim()) {
                      setError('Payout + destination token accounts are required.');
                      return;
                    }
                    return runAction('Claim payout', () =>
                      claimPayoutV3(
                        connection,
                        wallet,
                        businessPda,
                        employeeIndex,
                        nonce,
                        mustPubkey('payout token account', payoutTokenAccount),
                        mustPubkey('destination token account', claimerTokenAccount)
                      )
                    );
                  }}
                  disabled={busy || !businessPda}
                  className="premium-btn premium-btn-primary disabled:opacity-50"
                >
                  Claim Payout
                </button>
                {payout ? (
                  <div className="text-xs text-gray-600">
                    Claimed: {payout.claimed ? 'yes' : 'no'} · Cancelled: {payout.cancelled ? 'yes' : 'no'}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Devnet Tools (Server-Run)</h2>
              <p className="mt-1 text-sm text-gray-600">
                Runs the devnet scripts on the Next.js server. Set `ENABLE_DEVNET_SCRIPTS=true` to use.
              </p>
              <div className="mt-4 space-y-3">
                <button
                  onClick={() => void runDevnetAction('/api/devnet/v3-request-withdraw')}
                  disabled={devnetBusy}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  Server Request Withdraw
                </button>
                <input
                  value={devnetNonce}
                  onChange={(e) => setDevnetNonce(e.target.value)}
                  placeholder="Nonce for claim"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  onClick={() => void runDevnetAction('/api/devnet/v3-claim-payout', { nonce: devnetNonce })}
                  disabled={devnetBusy || !devnetNonce.trim()}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  Server Claim Payout
                </button>
                {devnetOutput ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 whitespace-pre-wrap">
                    {devnetOutput}
                  </div>
                ) : null}
                {devnetError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 whitespace-pre-wrap">
                    {devnetError}
                  </div>
                ) : null}
              </div>
            </section>

            {message ? <ActionResult kind="success">{message}</ActionResult> : null}
            {error ? <ActionResult kind="error">{error}</ActionResult> : null}
            {lastTx ? (
              <ActionResult kind="info">
                Last tx ({lastTx.label}): <span className="break-all">{lastTx.sig}</span>
              </ActionResult>
            ) : null}
          </>
        )}
      </div>
    </PageShell>
  );
}
