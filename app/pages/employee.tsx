import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getBusinessAccount,
  getEmployeeStreamV2Account,
  getEmployeeStreamV2DecryptHandles,
  getIncoAllowancePda,
  getRateHistoryV2Account,
  getWithdrawRequestV2Account,
  requestWithdrawV2,
} from '../lib/payroll-client';
import PageShell from '../components/PageShell';
import ActionResult from '../components/ActionResult';
import AdvancedDetails from '../components/AdvancedDetails';
import { COPY } from '../lib/copy';

const TOKEN_DECIMALS = 9n;
const TOKEN_SCALE = 10n ** TOKEN_DECIMALS;
const FETCH_TIMEOUT_MS = 12_000;

function formatTokenAmount(lamports: bigint): string {
  const negative = lamports < 0n;
  const v = negative ? -lamports : lamports;
  const whole = v / TOKEN_SCALE;
  const frac = v % TOKEN_SCALE;
  const fracStr = frac.toString().padStart(Number(TOKEN_DECIMALS), '0').replace(/0+$/, '');
  const out = fracStr.length > 0 ? `${whole.toString()}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function isDecryptNotAllowed(msg: string): boolean {
  return msg.includes('Address is not allowed to decrypt this handle');
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init || {}), signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export default function EmployeePage() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const DELEGATION_PROGRAM_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh';

  const [employerWallet, setEmployerWallet] = useState('');
  const [streamIndexInput, setStreamIndexInput] = useState('0');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Separate loading flags so auto-refresh / unrelated actions don't make Withdraw look "stuck".
  const [statusLoading, setStatusLoading] = useState(false);
  const [revealLoading, setRevealLoading] = useState(false);
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [payslipLoading, setPayslipLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [revealMessage, setRevealMessage] = useState('');
  const [serverRevealHint, setServerRevealHint] = useState<string | null>(null);
  const [decryptAllowed, setDecryptAllowed] = useState<{ salary: boolean; accrued: boolean } | null>(null);
  const [delegationRoute, setDelegationRoute] = useState<{
    delegated: boolean | null;
    endpoint: string | null;
    fqdn: string | null;
    error: string | null;
  } | null>(null);

  const [revealed, setRevealed] = useState<{
    salaryLamportsPerSec: bigint;
    accruedLamportsCheckpoint: bigint;
    checkpointTime: number; // unix seconds
    revealedAt: number; // unix seconds
  } | null>(null);

  const [earnedLamportsNow, setEarnedLamportsNow] = useState<bigint>(0n);
  const earnedTimerRef = useRef<number | null>(null);
  const [payslipStart, setPayslipStart] = useState(''); // datetime-local
  const [payslipEnd, setPayslipEnd] = useState(''); // datetime-local
  const [payslipJson, setPayslipJson] = useState('');
  const [status, setStatus] = useState<{
    streamIndex: number;
    owner: string;
    employeeTokenAccount: string;
    isActive: boolean;
    isDelegated: boolean;
    lastAccrualTime: number;
    lastSettleTime: number;
    accruedHandle: string;
    salaryHandle: string;
    accruedHandleValue: string;
    salaryHandleValue: string;
    withdrawPending: boolean;
    withdrawRequester: string | null;
    withdrawRequestedAt: number | null;
  } | null>(null);
  const [destinationBalance, setDestinationBalance] = useState<{
    uiAmount: string | null;
    rawAmount: string | null;
    error: string | null;
  } | null>(null);

  const [withdrawFlow, setWithdrawFlow] = useState<{
    requestTx: string;
    requestedAt: number; // unix seconds
    wasDelegated: boolean;
  } | null>(null);

  const streamIndex = useMemo(() => {
    const n = Number(streamIndexInput);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }, [streamIndexInput]);

  // Persist lookup inputs for convenience (avoids re-pasting every refresh).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('expensee_employee_lookup_v1');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.employerWallet === 'string') setEmployerWallet(parsed.employerWallet);
      if (typeof parsed?.streamIndexInput === 'string') setStreamIndexInput(parsed.streamIndexInput);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        'expensee_employee_lookup_v1',
        JSON.stringify({ employerWallet, streamIndexInput })
      );
    } catch {
      // ignore
    }
  }, [employerWallet, streamIndexInput]);

  const loadStatus = useCallback(async () => {
    if (!employerWallet || streamIndex === null) return;

    setStatusLoading(true);
    setError('');
    try {
      const employer = new PublicKey(employerWallet);
      const business = await getBusinessAccount(connection, employer);
      if (!business) {
        throw new Error('Business not found for this employer');
      }

      const stream = await getEmployeeStreamV2Account(connection, business.address, streamIndex);
      if (!stream) {
        throw new Error(`No v2 stream found for index ${streamIndex}`);
      }
      let destinationBalanceUi: string | null = null;
      let destinationBalanceRaw: string | null = null;
      let destinationBalanceError: string | null = null;
      try {
        const bal = await connection.getTokenAccountBalance(stream.employeeTokenAccount, 'confirmed');
        destinationBalanceUi = bal?.value?.uiAmountString ?? null;
        destinationBalanceRaw = bal?.value?.amount ?? null;
      } catch (e: any) {
        const msg = e?.message || 'Destination token balance unavailable';
        if (String(msg).toLowerCase().includes('not a token account')) {
          destinationBalanceError =
            'Confidential token balance is private in this view (standard SPL balance API is not applicable).';
        } else {
          destinationBalanceError = msg;
        }
      }

      // Best-effort: ask MagicBlock router where this stream is delegated.
      // This makes MagicBlock usage visible in the UI even when the base-layer owner is stale.
      try {
        const resp = await fetchWithTimeout(
          `/api/magicblock/delegation-status?pubkey=${encodeURIComponent(stream.address.toBase58())}`
        );
        const json = await resp.json();
        if (resp.ok && json?.ok) {
          const r = json.result || {};
          const delegatedRaw =
            r?.delegated ?? r?.isDelegated ?? r?.delegation?.delegated ?? false;
          const delegated = typeof delegatedRaw === 'number' ? delegatedRaw !== 0 : Boolean(delegatedRaw);
          setDelegationRoute({
            delegated,
            endpoint: r?.endpoint || r?.delegation?.endpoint || null,
            fqdn: r?.fqdn || r?.delegation?.fqdn || null,
            error: null,
          });
        } else {
          setDelegationRoute({
            delegated: null,
            endpoint: null,
            fqdn: null,
            error: json?.error || 'Router request failed',
          });
        }
      } catch (e: any) {
        setDelegationRoute({
          delegated: null,
          endpoint: null,
          fqdn: null,
          error: e?.message || 'Router request failed',
        });
      }

      const withdrawReq = await getWithdrawRequestV2Account(connection, business.address, streamIndex);
      const handles = getEmployeeStreamV2DecryptHandles(stream);
      const owner = stream.owner.toBase58();
      const isDelegated = owner === DELEGATION_PROGRAM_ID;
      if (revealed && stream.lastSettleTime > revealed.checkpointTime) {
        // Keep the decrypted salary rate (so the UI stays Zebec-like) but reset the baseline
        // after a settle so the ticker restarts from 0.
        setRevealed({
          salaryLamportsPerSec: revealed.salaryLamportsPerSec,
          accruedLamportsCheckpoint: 0n,
          checkpointTime: stream.lastSettleTime,
          revealedAt: revealed.revealedAt,
        });
        setEarnedLamportsNow(0n);
      }
      setStatus({
        streamIndex: stream.streamIndex,
        owner,
        employeeTokenAccount: stream.employeeTokenAccount.toBase58(),
        isActive: stream.isActive,
        isDelegated,
        lastAccrualTime: stream.lastAccrualTime,
        lastSettleTime: stream.lastSettleTime,
        accruedHandle: handles.accruedHandle,
        salaryHandle: handles.salaryHandle,
        accruedHandleValue: handles.accruedHandleValue.toString(),
        salaryHandleValue: handles.salaryHandleValue.toString(),
        withdrawPending: Boolean(withdrawReq?.isPending),
        withdrawRequester: withdrawReq ? withdrawReq.requester.toBase58() : null,
        withdrawRequestedAt: withdrawReq ? withdrawReq.requestedAt : null,
      });
      setDestinationBalance({
        uiAmount: destinationBalanceUi,
        rawAmount: destinationBalanceRaw,
        error: destinationBalanceError,
      });
    } catch (e: any) {
      setStatus(null);
      setDestinationBalance(null);
      setDelegationRoute(null);
      setError(e?.message || 'Failed to load stream status');
    } finally {
      setStatusLoading(false);
    }
  }, [connection, employerWallet, revealed, streamIndex]);

  // Best-effort proof: check if this wallet is allowed to decrypt the Inco handles (allowance PDAs exist).
  useEffect(() => {
    if (!wallet.publicKey || !status) {
      setDecryptAllowed(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const salaryHandleValue = BigInt(status.salaryHandleValue || '0');
      const accruedHandleValue = BigInt(status.accruedHandleValue || '0');
      const salaryAllowance = getIncoAllowancePda(salaryHandleValue, wallet.publicKey!);
      const accruedAllowance = getIncoAllowancePda(accruedHandleValue, wallet.publicKey!);
      const [salaryInfo, accruedInfo] = await Promise.all([
        connection.getAccountInfo(salaryAllowance),
        connection.getAccountInfo(accruedAllowance),
      ]);
      if (cancelled) return;
      setDecryptAllowed({ salary: Boolean(salaryInfo), accrued: Boolean(accruedInfo) });
    })().catch(() => {
      if (cancelled) return;
      setDecryptAllowed(null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    connection,
    wallet.publicKey?.toBase58(),
    status?.salaryHandleValue,
    status?.accruedHandleValue,
  ]);

  useEffect(() => {
    if (!status) return;
    // Initialize payslip window defaults once per loaded stream.
    if (!payslipStart) {
      const base = status.lastSettleTime > 0 ? status.lastSettleTime : status.lastAccrualTime;
      if (base > 0) {
        const d = new Date(base * 1000);
        setPayslipStart(d.toISOString().slice(0, 16));
      }
    }
    if (!payslipEnd) {
      const d = new Date();
      setPayslipEnd(d.toISOString().slice(0, 16));
    }
  }, [payslipEnd, payslipStart, status]);

  // Faster polling when a withdraw request is in progress.
  useEffect(() => {
    if (!withdrawFlow) return;
    const settled =
      Boolean(status) &&
      !status!.withdrawPending &&
      status!.lastSettleTime > 0 &&
      status!.lastSettleTime >= withdrawFlow.requestedAt;
    if (settled) return;
    const timer = setInterval(() => {
      void loadStatus();
    }, 2_000);
    return () => clearInterval(timer);
  }, [loadStatus, status?.lastSettleTime, status?.withdrawPending, withdrawFlow]);

  const withdrawProgress = useMemo(() => {
    if (!withdrawFlow || !status) return null;

    const now = Math.floor(Date.now() / 1000);
    const pendingOnChain = status.withdrawPending;
    const settled =
      !status.withdrawPending &&
      status.lastSettleTime > 0 &&
      status.lastSettleTime >= withdrawFlow.requestedAt;
    const delegationUsed =
      withdrawFlow.wasDelegated || status.isDelegated || delegationRoute?.delegated === true;
    // If already settled and currently delegated, undelegation likely happened transiently and has completed.
    const undelegatedObserved = !status.isDelegated || (delegationUsed && settled);

    const routerDelegated =
      delegationRoute?.delegated === null ? null : Boolean(delegationRoute?.delegated);
    const redelegated = delegationUsed && (routerDelegated === true || status.isDelegated);

    return {
      now,
      pendingOnChain,
      delegationUsed,
      undelegatedObserved,
      settled,
      routerDelegated,
      redelegated,
    };
  }, [delegationRoute?.delegated, status, withdrawFlow]);

  useEffect(() => {
    if (!autoRefresh || !employerWallet || streamIndex === null) return;
    const timer = setInterval(() => {
      void loadStatus();
    }, 10_000);
    return () => clearInterval(timer);
  }, [autoRefresh, employerWallet, loadStatus, streamIndex]);

  // Local 1s ticker for Zebec-like "earned so far" UX.
  useEffect(() => {
    if (earnedTimerRef.current) {
      window.clearInterval(earnedTimerRef.current);
      earnedTimerRef.current = null;
    }
    if (!revealed) return;

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const dt = Math.max(0, now - revealed.checkpointTime);
      setEarnedLamportsNow(
        revealed.accruedLamportsCheckpoint + revealed.salaryLamportsPerSec * BigInt(dt)
      );
    };

    tick();
    earnedTimerRef.current = window.setInterval(tick, 1000);
    return () => {
      if (earnedTimerRef.current) {
        window.clearInterval(earnedTimerRef.current);
        earnedTimerRef.current = null;
      }
    };
  }, [revealed]);

  return (
    <PageShell
      icon="◉"
      title="Expensee"
      subtitle={COPY.employee.subtitle}
      navItems={[
        { href: '/', label: COPY.nav.home },
        { href: '/employer', label: COPY.nav.company },
        { href: '/employee', label: COPY.nav.worker },
        { href: '/bridge', label: COPY.nav.bridge, advanced: true },
      ]}
    >
      <Head>
        <title>Worker Portal | Expensee</title>
      </Head>

      <section className="hero-card">
        <p className="hero-eyebrow">Worker view</p>
        <h1 className="hero-title">{COPY.employee.title}</h1>
        <p className="hero-subtitle">
          Track earnings live, request payout when needed, and share a signed earnings statement.
        </p>
      </section>

      {!wallet.connected ? (
        <section className="panel-card">
          <p className="text-sm text-gray-700">Connect a wallet to continue.</p>
        </section>
      ) : (
        <>
          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">{COPY.employee.sectionA}</h2>
            <p className="mt-1 text-sm text-gray-600">
              Enter your company wallet and payroll record number, then load your payroll status.
            </p>
            <div className="mt-4 space-y-3">
              <input
                value={employerWallet}
                onChange={(e) => setEmployerWallet(e.target.value)}
                placeholder="Company wallet"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={streamIndexInput}
                onChange={(e) => setStreamIndexInput(e.target.value)}
                placeholder="Payroll record number"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-refresh every 10s
              </label>
              <button
                onClick={() => void loadStatus()}
                disabled={statusLoading || !employerWallet || streamIndex === null}
                className="w-full rounded-lg bg-[#1D3557] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {statusLoading ? 'Loading...' : 'Load Payroll Status'}
              </button>
              <button
                onClick={() => {
                  if (typeof window === 'undefined') return;
                  try {
                    window.localStorage.removeItem('expensee_employee_lookup_v1');
                  } catch {
                    // ignore
                  }
                  setEmployerWallet('');
                  setStreamIndexInput('0');
                  setActionMessage('Cleared saved lookup fields.');
                }}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                Clear Saved Lookup
              </button>
            </div>
            {error ? <ActionResult kind="error">{error}</ActionResult> : null}
            {actionMessage ? <ActionResult kind="success">{actionMessage}</ActionResult> : null}
          </section>

          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">{COPY.employee.sectionB}</h2>
            <p className="mt-1 text-sm text-gray-600">
              Approve with your wallet to reveal your live earnings ticker.
            </p>
            <div className="mt-4 space-y-3">
              <button
                onClick={async () => {
                  if (!wallet.publicKey) return;
                  if (!wallet.signMessage) {
                    setError('Wallet does not support signMessage (required for secure reveal).');
                    return;
                  }
                  if (!status) {
                    setError('Load payroll status first.');
                    return;
                  }
                  setError('');
                  setRevealMessage('');
                  setServerRevealHint(null);
                  setRevealLoading(true);
                  try {
                    const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
                    const result = await decrypt([status.salaryHandle, status.accruedHandle], {
                      address: wallet.publicKey,
                      signMessage: wallet.signMessage,
                    });

                    const salaryLamportsPerSec = BigInt(result.plaintexts[0] || '0');
                    const accruedLamportsCheckpoint = BigInt(result.plaintexts[1] || '0');
                    const checkpointTime =
                      status.lastAccrualTime > 0 ? status.lastAccrualTime : status.lastSettleTime;
                    const now = Math.floor(Date.now() / 1000);
                    setRevealed({
                      salaryLamportsPerSec,
                      accruedLamportsCheckpoint,
                      checkpointTime,
                      revealedAt: now,
                    });
                    setRevealMessage('Live earnings enabled.');
                  } catch (e: any) {
                    const msg = e?.message || 'Secure reveal failed';
                    setError(msg);
                    if (isDecryptNotAllowed(msg)) {
                      setServerRevealHint(
                        'This wallet does not have view permission yet. Ask your company admin to click "Grant Worker View Access" for your payroll record, then try again.'
                      );
                    }
                  } finally {
                    setRevealLoading(false);
                  }
                }}
                disabled={revealLoading || !status}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                {revealLoading ? 'Revealing...' : 'Reveal Live Earnings'}
              </button>
              {serverRevealHint ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <div className="font-medium">View permission missing</div>
                  <div className="mt-1">{serverRevealHint}</div>
                  <AdvancedDetails title="Advanced fallback (demo only)">
                    <p className="mb-2 text-xs text-amber-900">
                      Server-assisted reveal works for demos if admin permission cannot be updated right now.
                    </p>
                    <button
                      onClick={async () => {
                        if (!wallet.publicKey || !wallet.signMessage) {
                          setError('Connect a wallet that supports signMessage.');
                          return;
                        }
                        if (!status) {
                          setError('Load payroll status first.');
                          return;
                        }
                        if (!employerWallet || streamIndex === null) {
                          setError('Company wallet + payroll record number are required.');
                          return;
                        }

                        setError('');
                        setRevealMessage('');
                        setRevealLoading(true);
                        try {
                          const ts = Math.floor(Date.now() / 1000);
                          const msg =
                            `Expensee Reveal Earnings\n` +
                            `employer=${new PublicKey(employerWallet).toBase58()}\n` +
                            `stream_index=${streamIndex}\n` +
                            `employee=${wallet.publicKey.toBase58()}\n` +
                            `ts=${ts}\n`;

                          const sigBytes = await wallet.signMessage(new TextEncoder().encode(msg));
                          const sigBase58 = bs58.encode(sigBytes);

                          const resp = await fetchWithTimeout('/api/inco/reveal', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              employerWallet,
                              streamIndex,
                              employeeWallet: wallet.publicKey.toBase58(),
                              ts,
                              signatureBase58: sigBase58,
                            }),
                          });
                          const json = await resp.json();
                          if (!resp.ok || !json?.ok) {
                            throw new Error(json?.error || 'Server reveal failed');
                          }

                          const salaryLamportsPerSec = BigInt(json.salaryLamportsPerSec || '0');
                          const accruedLamportsCheckpoint = BigInt(json.accruedLamportsCheckpoint || '0');
                          const checkpointTime =
                            status.lastAccrualTime > 0 ? status.lastAccrualTime : status.lastSettleTime;
                          const now = Math.floor(Date.now() / 1000);
                          setRevealed({
                            salaryLamportsPerSec,
                            accruedLamportsCheckpoint,
                            checkpointTime,
                            revealedAt: now,
                          });
                          setRevealMessage(`Live earnings enabled (server signer: ${json.signer}).`);
                        } catch (e: any) {
                          setError(e?.message || 'Server reveal failed');
                        } finally {
                          setRevealLoading(false);
                        }
                      }}
                      className="w-full rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm"
                    >
                      Reveal via Admin/Keeper (Demo)
                    </button>
                  </AdvancedDetails>
                </div>
              ) : null}
              {revealMessage ? <ActionResult kind="success">{revealMessage}</ActionResult> : null}
            </div>

            <div className="mt-4 grid gap-2 text-sm text-gray-700">
              <div className="text-3xl font-semibold text-[#0B6E4F]">
                {revealed ? `${formatTokenAmount(earnedLamportsNow)}` : '-'}{' '}
                <span className="text-sm text-gray-600">cUSDC-like (confidential)</span>
              </div>
              <div>
                View permission:{' '}
                {decryptAllowed === null
                  ? 'Unknown'
                  : decryptAllowed.salary && decryptAllowed.accrued
                    ? 'Allowed'
                    : 'Not allowed'}
              </div>
              <div>Earning rate: {revealed ? `${formatTokenAmount(revealed.salaryLamportsPerSec)}/sec` : '-'}</div>
              <div>Starting balance: {revealed ? formatTokenAmount(revealed.accruedLamportsCheckpoint) : '-'}</div>
              <div>Starting time: {revealed ? revealed.checkpointTime : '-'}</div>
            </div>
          </section>

          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">{COPY.employee.sectionC}</h2>
            <p className="mt-1 text-sm text-gray-600">
              Request payout to your registered destination account.
            </p>
            <p className="mt-1 text-xs text-gray-500">
              If payout says complete but Phantom balance does not update, verify destination account below or use Bridge.
            </p>
            <div className="mt-4">
              <button
                onClick={async () => {
                  if (!wallet.publicKey || !employerWallet || streamIndex === null) return;
                  setError('');
                  setActionMessage('');
                  setWithdrawLoading(true);
                  try {
                    if (!status) {
                      throw new Error('Load payroll status first.');
                    }
                    const txid = await requestWithdrawV2(
                      connection,
                      wallet,
                      new PublicKey(employerWallet),
                      streamIndex
                    );
                    setActionMessage(`Payout request submitted. tx=${txid}`);
                    const wasDelegated =
                      status?.owner === DELEGATION_PROGRAM_ID || delegationRoute?.delegated === true;
                    setWithdrawFlow({
                      requestTx: txid,
                      requestedAt: Math.floor(Date.now() / 1000),
                      wasDelegated,
                    });
                    void loadStatus();
                  } catch (e: any) {
                    setError(e?.message || 'Failed to request payout');
                  } finally {
                    setWithdrawLoading(false);
                  }
                }}
                disabled={withdrawLoading || !employerWallet || streamIndex === null || !status}
                className="w-full rounded-lg bg-[#0B6E4F] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {withdrawLoading ? 'Submitting...' : 'Request Payout'}
              </button>
            </div>

            {withdrawFlow && status ? (
              <div className="mt-4 rounded-lg border border-gray-200 bg-[#F8FAFC] px-4 py-3 text-sm text-gray-800">
                <div className="font-medium text-[#2D2D2A]">Payout progress</div>
                <div className="mt-2 grid gap-1">
                  <div>
                    1. Request submitted:{' '}
                    <a
                      href={explorerTxUrl(withdrawFlow.requestTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[#005B96] underline"
                    >
                      {withdrawFlow.requestTx}
                    </a>
                  </div>
                  <div>2. Processing: {status.withdrawPending ? 'In progress' : 'Completed'}</div>
                  <div>3. Payout sent: {withdrawProgress?.settled ? 'Yes' : 'Not yet'}</div>
                  <div>
                    4. Destination balance:{' '}
                    {destinationBalance?.error
                      ? `Unavailable (${destinationBalance.error})`
                      : destinationBalance?.uiAmount ?? destinationBalance?.rawAmount ?? 'Unknown'}
                  </div>
                </div>

                <AdvancedDetails title="Advanced details">
                  <div className="mt-2 grid gap-1 text-sm text-gray-700">
                    <div>Request pending on-chain: {status.withdrawPending ? 'yes' : 'no'}</div>
                    <div>Used high-speed mode: {withdrawProgress?.delegationUsed ? 'yes' : 'no'}</div>
                    {withdrawProgress?.delegationUsed ? (
                      <>
                        <div>
                          Undelegated back to base:{' '}
                          {withdrawProgress?.undelegatedObserved
                            ? status.isDelegated
                              ? 'yes (transient; now re-delegated)'
                              : 'yes'
                            : 'no'}
                        </div>
                        <div>
                          Router delegation status:{' '}
                          {delegationRoute?.delegated === null
                            ? 'unknown'
                            : delegationRoute?.delegated
                              ? 'delegated'
                              : 'not delegated'}
                          {delegationRoute?.endpoint ? ` (${delegationRoute.endpoint})` : ''}
                        </div>
                        <div>Re-delegated: {withdrawProgress?.redelegated ? 'yes' : 'no/unknown'}</div>
                      </>
                    ) : null}
                    <div>
                      Destination token account:{' '}
                      <a
                        href={`https://explorer.solana.com/address/${status.employeeTokenAccount}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[#005B96] underline"
                      >
                        {status.employeeTokenAccount}
                      </a>
                    </div>
                  </div>
                </AdvancedDetails>

                {(process.env.NEXT_PUBLIC_BRIDGE_ENABLED ?? 'false') === 'true' ? (
                  <div className="mt-3">
                    <Link
                      href={`/bridge?confidentialTokenAccount=${encodeURIComponent(status.employeeTokenAccount)}`}
                      className="text-[#005B96] underline"
                    >
                      Open Bridge (confidential -&gt; public demo USDC)
                    </Link>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">{COPY.employee.sectionD}</h2>
            <p className="mt-1 text-sm text-gray-600">
              Generate a signed earnings statement for a selected time window.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-700">Start</div>
                <input
                  type="datetime-local"
                  value={payslipStart}
                  onChange={(e) => setPayslipStart(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-700">End</div>
                <input
                  type="datetime-local"
                  value={payslipEnd}
                  onChange={(e) => setPayslipEnd(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-4">
              <button
                onClick={async () => {
                  if (!wallet.publicKey || !wallet.signMessage) {
                    setError('Connect a wallet that supports signMessage.');
                    return;
                  }
                  if (!status) {
                    setError('Load payroll status first.');
                    return;
                  }
                  if (!employerWallet || streamIndex === null) {
                    setError('Company wallet + payroll record number are required.');
                    return;
                  }
                  setError('');
                  setActionMessage('');
                  setPayslipJson('');
                  setPayslipLoading(true);
                  try {
                    const employer = new PublicKey(employerWallet);
                    const business = await getBusinessAccount(connection, employer);
                    if (!business) throw new Error('Business not found for this company wallet');

                    const startSec = Math.floor(new Date(payslipStart).getTime() / 1000);
                    const endSec = Math.floor(new Date(payslipEnd).getTime() / 1000);
                    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0) {
                      throw new Error('Invalid statement time window');
                    }
                    if (endSec <= startSec) throw new Error('End must be after start');

                    const history = await getRateHistoryV2Account(connection, business.address, streamIndex);
                    const entries = (history?.entries || [])
                      .filter((e) => e.effectiveAt > 0)
                      .sort((a, b) => a.effectiveAt - b.effectiveAt);

                    const effectiveRates: { t: number; handle: string }[] = [];
                    if (entries.length === 0) {
                      effectiveRates.push({ t: startSec, handle: status.salaryHandle });
                    } else {
                      let chosen = entries[0]!;
                      for (const e of entries) {
                        if (e.effectiveAt <= startSec) chosen = e;
                      }
                      effectiveRates.push({ t: startSec, handle: chosen.salaryHandle });
                      for (const e of entries) {
                        if (e.effectiveAt > startSec && e.effectiveAt < endSec) {
                          effectiveRates.push({ t: e.effectiveAt, handle: e.salaryHandle });
                        }
                      }
                    }

                    const uniqueHandles = Array.from(new Set(effectiveRates.map((r) => r.handle)));
                    const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
                    const result = await decrypt(uniqueHandles, {
                      address: wallet.publicKey,
                      signMessage: wallet.signMessage,
                    });
                    const plaintextByHandle = new Map<string, bigint>();
                    for (let i = 0; i < uniqueHandles.length; i += 1) {
                      plaintextByHandle.set(uniqueHandles[i]!, BigInt(result.plaintexts[i] || '0'));
                    }

                    let total = 0n;
                    for (let i = 0; i < effectiveRates.length; i += 1) {
                      const segStart = effectiveRates[i]!.t;
                      const segEnd = i + 1 < effectiveRates.length ? effectiveRates[i + 1]!.t : endSec;
                      const dt = Math.max(0, segEnd - segStart);
                      const rate = plaintextByHandle.get(effectiveRates[i]!.handle) || 0n;
                      total += rate * BigInt(dt);
                    }

                    const payload = {
                      version: 'expensee_payslip_v1',
                      generatedAt: new Date().toISOString(),
                      employer: employer.toBase58(),
                      business: business.address.toBase58(),
                      streamIndex,
                      destinationTokenAccount: status.employeeTokenAccount,
                      periodStart: startSec,
                      periodEnd: endSec,
                      earnedLamports: total.toString(),
                      earnedUi: formatTokenAmount(total),
                      note:
                        'Computed locally from encrypted payroll data and signed by the worker wallet for selective disclosure.',
                    };

                    const messageBytes = new TextEncoder().encode(JSON.stringify(payload));
                    const sigBytes = await wallet.signMessage(messageBytes);
                    const { default: bs58 } = await import('bs58');
                    const signed = { ...payload, signer: wallet.publicKey.toBase58(), signature: bs58.encode(sigBytes) };
                    setPayslipJson(JSON.stringify(signed, null, 2));
                    setActionMessage('Signed earnings statement generated.');
                  } catch (e: any) {
                    setError(e?.message || 'Failed to generate statement');
                  } finally {
                    setPayslipLoading(false);
                  }
                }}
                disabled={payslipLoading || !status}
                className="w-full rounded-lg bg-[#E85D04] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {payslipLoading ? 'Generating...' : 'Generate Signed Earnings Statement'}
              </button>
            </div>
            {payslipJson ? (
              <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-[#0B1320] p-4 text-xs text-[#E6EDF3]">
                {payslipJson}
              </pre>
            ) : null}
          </section>

          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">Where payout was sent</h2>
            {status ? (
              <div className="mt-3 grid gap-2 text-sm text-gray-700">
                <div>
                  Destination token account:{' '}
                  <a
                    href={`https://explorer.solana.com/address/${status.employeeTokenAccount}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[#005B96] underline"
                  >
                    {status.employeeTokenAccount}
                  </a>
                </div>
                <div>
                  Current balance:{' '}
                  {destinationBalance?.error
                    ? `Unavailable (${destinationBalance.error})`
                    : destinationBalance?.uiAmount ?? destinationBalance?.rawAmount ?? '-'}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-gray-600">Load payroll status to see payout destination details.</p>
            )}

            <AdvancedDetails title="Advanced details">
              {status ? (
                <div className="mt-2 grid gap-1 text-sm text-gray-700">
                  <div>Payroll record number: {status.streamIndex}</div>
                  <div>Base owner: {status.owner}</div>
                  <div>Active: {status.isActive ? 'yes' : 'no'}</div>
                  <div>Delegated to ER (base read): {status.isDelegated ? 'yes' : 'no'}</div>
                  {delegationRoute ? (
                    <div>
                      Delegated (router):{' '}
                      {delegationRoute.delegated === null
                        ? 'unknown'
                        : delegationRoute.delegated
                          ? 'yes'
                          : 'no'}
                      {delegationRoute.endpoint ? ` (${delegationRoute.endpoint})` : ''}
                      {delegationRoute.error ? ` (err: ${delegationRoute.error})` : ''}
                    </div>
                  ) : null}
                  <div>Withdrawal pending: {status.withdrawPending ? 'yes' : 'no'}</div>
                  <div>Withdrawal requester: {status.withdrawRequester ?? '-'}</div>
                  <div>Withdrawal requested at: {status.withdrawRequestedAt ?? '-'}</div>
                  <div>Last accrual time: {status.lastAccrualTime}</div>
                  <div>Last settle time: {status.lastSettleTime}</div>
                  <div>Encrypted salary handle: {status.salaryHandle}</div>
                  <div>Encrypted accrued handle: {status.accruedHandle}</div>
                  <div>Salary handle (u128): {status.salaryHandleValue}</div>
                  <div>Accrued handle (u128): {status.accruedHandleValue}</div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-600">No payroll record loaded.</p>
              )}
            </AdvancedDetails>
          </section>
        </>
      )}
    </PageShell>
  );
}
