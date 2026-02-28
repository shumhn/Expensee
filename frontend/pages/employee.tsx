import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createIncoTokenAccount,
  getBusinessAccount,
  getBusinessPDA,
  getEmployeeStreamV2Account,
  getEmployeeStreamV2DecryptHandles,
  getIncoAllowancePda,
  getRateHistoryV2Account,
  getWithdrawRequestV2Account,
  getPendingPayoutsForWorker,
  ShieldedPayoutV2Account,
  PAYUSD_MINT,
  signClaimAuthorization,
  signWithdrawAuthorization,
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

function estimateEarnedLamports(
  accruedCheckpoint: bigint,
  salaryPerSecond: bigint,
  checkpointTime: number,
  nowSec: number
): bigint {
  const dt = Math.max(0, nowSec - checkpointTime);
  return accruedCheckpoint + salaryPerSecond * BigInt(dt);
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
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
  const [claimLoading, setClaimLoading] = useState(false);
  const [pendingPayouts, setPendingPayouts] = useState<ShieldedPayoutV2Account[]>([]);
  const [payoutsScanning, setPayoutsScanning] = useState(false);
  const [claimingNonce, setClaimingNonce] = useState<number | null>(null);
  const [claimSuccessTx, setClaimSuccessTx] = useState<string | null>(null);
  const [bufferProofTxByNonce, setBufferProofTxByNonce] = useState<Record<number, string>>({});
  const [lastClaimProof, setLastClaimProof] = useState<{
    nonce: number;
    payoutPda: string;
    bufferTx: string | null;
    claimTx: string;
  } | null>(null);
  const [payslipLoading, setPayslipLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [claimDestinationTokenAccount, setClaimDestinationTokenAccount] = useState('');
  const [revealMessage, setRevealMessage] = useState('');
  const [serverRevealHint, setServerRevealHint] = useState<string | null>(null);
  const [decryptAllowed, setDecryptAllowed] = useState<{ salary: boolean; accrued: boolean } | null>(null);
  const [delegationRoute, setDelegationRoute] = useState<{
    delegated: boolean | null;
    endpoint: string | null;
    fqdn: string | null;
    error: string | null;
  } | null>(null);
  const [delegationRouteLoading, setDelegationRouteLoading] = useState(false);
  const [delegationRouteCheckedAt, setDelegationRouteCheckedAt] = useState<number | null>(null);

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
    streamAddress: string;
    owner: string;
    hasFixedDestination: boolean;
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
  const [estimatedFrozenAt, setEstimatedFrozenAt] = useState<number | null>(null);

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

  // Auto-scan for payouts whenever employer or wallet changes
  const scanPayouts = useCallback(async () => {
    if (wallet.publicKey && employerWallet) {
      try {
        const [biz] = getBusinessPDA(new PublicKey(employerWallet));
        const found = await getPendingPayoutsForWorker(connection, biz, wallet.publicKey!);
        setPendingPayouts(found);
      } catch { /* ignore auto-scan errors */ }
    }
  }, [connection, employerWallet, wallet.publicKey]);

  useEffect(() => {
    void scanPayouts();
  }, [scanPayouts]);

  // Best-effort: resolve hop-1 proof tx for each buffered payout token account.
  useEffect(() => {
    if (pendingPayouts.length === 0) return;
    const loadProofs = async () => {
      const updates: Record<number, string> = {};
      await Promise.all(
        pendingPayouts.map(async (p) => {
          try {
            const sigs = await connection.getSignaturesForAddress(
              p.payoutTokenAccount,
              { limit: 5 },
              'confirmed'
            );
            const firstOk = sigs.find((s) => !s.err)?.signature || null;
            if (firstOk) updates[p.nonce] = firstOk;
          } catch {
            // ignore proof lookup errors
          }
        })
      );
      if (Object.keys(updates).length > 0) {
        setBufferProofTxByNonce((prev) => ({ ...prev, ...updates }));
      }
    };
    void loadProofs();
  }, [connection, pendingPayouts]);

  const loadDelegationRoute = useCallback(async (streamAddress: string) => {
    setDelegationRouteLoading(true);
    try {
      const resp = await fetchWithTimeout(
        `/api/magicblock/delegation-status?pubkey=${encodeURIComponent(streamAddress)}`
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
    } finally {
      setDelegationRouteCheckedAt(Date.now());
      setDelegationRouteLoading(false);
    }
  }, []);

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
      const hasFixedDestination = stream.hasFixedDestination;
      let destinationBalanceUi: string | null = null;
      let destinationBalanceRaw: string | null = null;
      let destinationBalanceError: string | null = null;
      if (hasFixedDestination) {
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
      }

      await loadDelegationRoute(stream.address.toBase58());

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
        streamAddress: stream.address.toBase58(),
        owner,
        hasFixedDestination,
        employeeTokenAccount: hasFixedDestination
          ? stream.employeeTokenAccount.toBase58()
          : "",
        isActive: stream.isActive,
        isDelegated,
        lastAccrualTime: stream.lastAccrualTime,
        lastSettleTime: stream.lastSettleTime,
        accruedHandle: handles.accruedHandle,
        salaryHandle: handles.salaryHandle,
        accruedHandleValue: handles.accruedHandleValue.toString(),
        salaryHandleValue: handles.salaryHandleValue.toString(),
        withdrawPending: Boolean(withdrawReq?.isPending),
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
  }, [connection, employerWallet, loadDelegationRoute, revealed, streamIndex]);

  const revealViaKeeperRelay = useCallback(
    async (streamIndexValue: number) => {
      if (!wallet.publicKey || !wallet.signMessage) {
        throw new Error('Wallet signature is required for keeper relay reveal.');
      }
      if (!employerWallet) {
        throw new Error('Enter company wallet first.');
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const msg = new TextEncoder().encode(
        `reveal:${employerWallet}:${streamIndexValue}:${timestamp}`
      );
      const signature = await wallet.signMessage(msg);
      const keeperUrl = process.env.NEXT_PUBLIC_KEEPER_API_URL || 'http://localhost:9090';
      const resp = await fetchWithTimeout(`${keeperUrl}/api/reveal-live`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerPubkey: wallet.publicKey.toBase58(),
          businessOwner: employerWallet,
          streamIndex: streamIndexValue,
          timestamp,
          signature: Array.from(signature),
          message: Array.from(msg),
        }),
      });
      const result = await resp.json().catch(() => ({} as any));
      if (!resp.ok) {
        throw new Error(result?.error || 'Keeper relay reveal failed');
      }
      const salaryLamportsPerSec = BigInt(result?.salaryLamportsPerSec || '0');
      const accruedLamportsCheckpoint = BigInt(result?.accruedLamportsCheckpoint || '0');
      const checkpointTime =
        Number(result?.checkpointTime) > 0
          ? Number(result?.checkpointTime)
          : Math.floor(Date.now() / 1000);
      setRevealed({
        salaryLamportsPerSec,
        accruedLamportsCheckpoint,
        checkpointTime,
        revealedAt: Math.floor(Date.now() / 1000),
      });
      setRevealMessage('Live earnings enabled via keeper confidential relay.');
      setServerRevealHint(null);
    },
    [employerWallet, wallet.publicKey, wallet.signMessage]
  );

  // Fallback destination for claims: use stream destination unless worker picks another account.
  useEffect(() => {
    if (!status?.hasFixedDestination || !status?.employeeTokenAccount) return;
    setClaimDestinationTokenAccount((prev) =>
      prev && prev.trim().length > 0 ? prev : status.employeeTokenAccount
    );
  }, [status?.employeeTokenAccount, status?.hasFixedDestination]);

  // Polling for live updates when a payout is in flight
  useEffect(() => {
    const isPending = status?.withdrawPending || pendingPayouts.length > 0;
    if (!isPending) return;

    const interval = setInterval(() => {
      // Refresh both the stream status (for withdrawPending) and pending payouts (for buffering)
      void loadStatus();
      void scanPayouts();
    }, 5000);

    return () => clearInterval(interval);
  }, [loadStatus, scanPayouts, status?.withdrawPending, pendingPayouts.length]);

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

  // Freeze local estimate once a withdraw enters pending to avoid showing an amount that keeps
  // increasing while on-chain settlement is finalizing.
  useEffect(() => {
    if (!status || !revealed) {
      setEstimatedFrozenAt(null);
      return;
    }
    const pending = Boolean(status.withdrawPending);
    if (!pending) {
      setEstimatedFrozenAt(null);
      return;
    }
    const freezeAt =
      status.withdrawRequestedAt ||
      withdrawFlow?.requestedAt ||
      Math.floor(Date.now() / 1000);
    setEstimatedFrozenAt((prev) => prev ?? freezeAt);
  }, [revealed, status, status?.withdrawPending, status?.withdrawRequestedAt, withdrawFlow?.requestedAt]);

  const executionMode = useMemo(() => {
    if (!status) {
      return {
        label: 'Unknown',
        detail: 'Load payroll status to detect Boost Execution route.',
        badgeClass: 'bg-gray-100 text-gray-700',
      };
    }
    const routerDelegated = delegationRoute?.delegated;
    const boosted = routerDelegated === true || status.isDelegated;
    if (boosted) {
      return {
        label: 'Boost Execution',
        detail: 'MagicBlock delegated route is active for this payroll stream.',
        badgeClass: 'bg-emerald-100 text-emerald-800',
      };
    }
    if (routerDelegated === false && !status.isDelegated) {
      return {
        label: 'Base Layer',
        detail: 'No delegation detected; actions settle directly on Solana base layer.',
        badgeClass: 'bg-slate-100 text-slate-700',
      };
    }
    return {
      label: 'Checking',
      detail: 'Router and base ownership are still syncing. Refresh route in a few seconds.',
      badgeClass: 'bg-amber-100 text-amber-800',
    };
  }, [delegationRoute?.delegated, status]);

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
      const now = estimatedFrozenAt ?? Math.floor(Date.now() / 1000);
      setEarnedLamportsNow(
        estimateEarnedLamports(
          revealed.accruedLamportsCheckpoint,
          revealed.salaryLamportsPerSec,
          revealed.checkpointTime,
          now
        )
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
  }, [estimatedFrozenAt, revealed]);

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
              {status ? (
                <div className="rounded-lg border border-gray-200 bg-[#FAFBFF] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        Execution mode
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${executionMode.badgeClass}`}>
                          {executionMode.label}
                        </span>
                        {delegationRouteCheckedAt ? (
                          <span className="text-[11px] text-gray-500">
                            Updated {new Date(delegationRouteCheckedAt).toLocaleTimeString()}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-xs text-gray-600">{executionMode.detail}</p>
                      {delegationRoute?.endpoint ? (
                        <p className="mt-1 truncate text-[11px] text-gray-500">
                          Router: {delegationRoute.endpoint}
                        </p>
                      ) : null}
                      {delegationRoute?.error ? (
                        <p className="mt-1 text-[11px] text-amber-700">
                          Router status unavailable: {delegationRoute.error}
                        </p>
                      ) : null}
                    </div>
                    <button
                      onClick={() => void loadDelegationRoute(status.streamAddress)}
                      disabled={delegationRouteLoading}
                      className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                    >
                      {delegationRouteLoading ? 'Refreshing...' : 'Refresh Route'}
                    </button>
                  </div>
                </div>
              ) : null}
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

          {/* ─── Payout & Withdraw Flow (Unified Timeline) ─── */}
          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">Payout Journey</h2>
            <p className="mt-1 text-sm text-gray-600">
              Request salary and claim it securely once buffered.
            </p>

            {/* ── Status Timeline ── */}
            {(() => {
              const hasRequest = status?.withdrawPending ?? false;
              const hasBuffered = pendingPayouts.length > 0;
              const hasClaimed = !!claimSuccessTx;

              // Find the proof signature for the "latest" buffered or claimed item
              const bufferProof = pendingPayouts.length > 0 ? bufferProofTxByNonce[pendingPayouts[0].nonce] : null;
              const claimProof = claimSuccessTx;

              const steps = [
                { label: 'Requested', active: hasRequest || hasBuffered || hasClaimed },
                {
                  label: 'Buffered',
                  active: hasBuffered || hasClaimed,
                  proof: bufferProof
                },
                { label: 'Claim', active: hasBuffered && !hasClaimed },
                {
                  label: 'Claimed',
                  active: hasClaimed,
                  proof: claimProof
                },
              ];
              return (
                <div className="mt-4 flex items-center justify-between border-b pb-8 mb-6">
                  {steps.map((s, i) => (
                    <div key={s.label} className="flex items-center">
                      <div className="flex flex-col items-center">
                        <div className={`h-4 w-4 rounded-full border-2 transition-all ${s.active ? 'bg-[#005B96] border-[#005B96] shadow-[0_0_8px_rgba(0,91,150,0.4)]' : 'bg-white border-gray-300'
                          }`} />
                        <span className={`mt-1 text-[10px] font-bold uppercase tracking-tighter ${s.active ? 'text-[#005B96]' : 'text-gray-400'
                          }`}>{s.label}</span>
                        {s.proof && (
                          <a
                            href={explorerTxUrl(s.proof)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 text-[9px] font-bold text-indigo-500 hover:underline"
                            title="View On-chain Proof"
                          >
                            Proof 🔗
                          </a>
                        )}
                      </div>
                      {i < steps.length - 1 && (
                        <div className={`mx-2 h-0.5 w-10 mb-4 ${steps[i + 1].active ? 'bg-[#005B96]' : 'bg-gray-200'
                          }`} />
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* ── Action Area ── */}
            <div className="space-y-4">
              {/* Step 1: Request Withdraw if nothing is in flight */}
              {!(status?.withdrawPending) && !claimSuccessTx && (
                <div>
                  <div className="mb-2 text-xs font-semibold text-gray-500 uppercase">Step 1: Request Payout</div>
                  <button
                    onClick={async () => {
                      if (!wallet.publicKey || !employerWallet || streamIndex === null) return;
                      setError('');
                      setActionMessage('');
                      setWithdrawLoading(true);
                      try {
                        const timestamp = Math.floor(Date.now() / 1000);
                        const { signature, message } = await signWithdrawAuthorization(
                          wallet,
                          new PublicKey(employerWallet),
                          streamIndex,
                          timestamp
                        );

                        const keeperUrl = process.env.NEXT_PUBLIC_KEEPER_API_URL || 'http://localhost:9090';
                        const res = await fetch(`${keeperUrl}/api/withdraw-auth`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            workerPubkey: wallet.publicKey.toBase58(),
                            streamIndex,
                            signature: Array.from(signature),
                            message: Array.from(message),
                            businessOwner: employerWallet,
                            timestamp,
                          }),
                        });

                        if (!res.ok) {
                          const errBody = await res.json().catch(() => ({}));
                          throw new Error(errBody.error || `Failed to submit withdraw auth: ${res.statusText}`);
                        }

                        setWithdrawFlow({
                          requestTx: 'off_chain_signature',
                          requestedAt: timestamp,
                          wasDelegated: status?.isDelegated ?? false,
                        });
                        setActionMessage(`Off-chain request sent securely to Keeper!`);
                        void loadStatus();
                      } catch (e: any) {
                        setError(e?.message || 'Withdraw request failed');
                      } finally {
                        setWithdrawLoading(false);
                      }
                    }}
                    disabled={withdrawLoading || !status}
                    className="w-full rounded-lg bg-[#2D2D2A] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-black/10 disabled:opacity-50"
                  >
                    {withdrawLoading ? 'Processing Request...' : 'Trigger Payout Request'}
                  </button>
                </div>
              )}

              {/* Status Message for Pending Request */}
              {status?.withdrawPending && pendingPayouts.length === 0 && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                    <span className="text-sm font-medium text-blue-800">Request Pending</span>
                  </div>
                  <p className="mt-1 text-xs text-blue-600">
                    The automation service is processing your payout. This usually takes 5-15 seconds.
                  </p>
                </div>
              )}
              {withdrawProgress ? (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
                    MagicBlock Processing
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-indigo-900">
                    <div>
                      Route: {withdrawProgress.delegationUsed ? 'Boost Execution (MagicBlock)' : 'Base Layer'}
                    </div>
                    <div>
                      Undelegation checkpoint:{' '}
                      {withdrawProgress.undelegatedObserved ? 'observed' : 'waiting'}
                    </div>
                    <div>
                      Settlement:{' '}
                      {withdrawProgress.settled
                        ? 'complete'
                        : withdrawProgress.pendingOnChain
                          ? 'pending on-chain'
                          : 'queued'}
                    </div>
                    <div>
                      Re-delegation:{' '}
                      {withdrawProgress.redelegated
                        ? 'active'
                        : withdrawProgress.settled
                          ? 'pending confirmation'
                          : 'in progress'}
                    </div>
                  </div>
                  {withdrawProgress.settled &&
                  !status?.withdrawPending &&
                  pendingPayouts.length === 0 &&
                  !claimSuccessTx ? (
                    <div className="mt-3 rounded-md border border-indigo-200 bg-white px-3 py-2 text-xs text-indigo-900">
                      Settlement finished. If no claim card appears, connect the same Employee Auth wallet used during onboarding, then refresh status.
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Step 2: Worker Claim */}
              {pendingPayouts.length > 0 && !claimSuccessTx && (
                <div className="space-y-3">
                  <div className="mb-2 text-xs font-semibold uppercase font-bold text-[#005B96]">Step 2: Claim Buffered Payout</div>
                  <div className="rounded-lg border border-[#005B96]/20 bg-[#005B96]/5 p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-[#005B96]">
                      Claim Destination Token Account
                    </div>
                    <input
                      value={claimDestinationTokenAccount}
                      onChange={(e) => setClaimDestinationTokenAccount(e.target.value)}
                      placeholder="Destination confidential token account..."
                      className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={async () => {
                          if (!wallet.publicKey) return;
                          setError('');
                          setActionMessage('');
                          try {
                            const { tokenAccount } = await createIncoTokenAccount(
                              connection,
                              wallet,
                              wallet.publicKey,
                              PAYUSD_MINT
                            );
                            setClaimDestinationTokenAccount(tokenAccount.toBase58());
                            setActionMessage('New private destination account created for claim.');
                          } catch (e: any) {
                            setError(e?.message || 'Failed to create destination account');
                          }
                        }}
                        disabled={claimLoading || !wallet.publicKey}
                        className="rounded-md border border-[#005B96]/30 bg-white px-3 py-1.5 text-xs font-semibold text-[#005B96] disabled:opacity-50"
                      >
                        Create Private Destination
                      </button>
                      <div className="text-[11px] text-gray-500">
                        Recommended: use a fresh destination per claim to reduce address linkability.
                      </div>
                    </div>
                  </div>
                  {pendingPayouts.map((p) => {
                    const proof = bufferProofTxByNonce[p.nonce];
                    return (
                      <div key={p.nonce} className="rounded-xl border-2 border-[#005B96] bg-[#005B96]/5 p-5">
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="text-sm font-bold text-[#2D2D2A] flex items-center gap-2">
                              <span>Funded &amp; Secure</span>
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-black uppercase tracking-tighter shadow-sm">Buffered</span>
                            </div>
                            <div className="mt-1 text-xs text-gray-600">
                              Settled on-chain {new Date(p.createdAt * 1000).toLocaleTimeString()}
                            </div>
                          </div>
                          <button
                            onClick={async () => {
                              if (!wallet.publicKey || !employerWallet) return;
                              if (!claimDestinationTokenAccount.trim()) {
                                setError('Enter a claim destination token account first.');
                                return;
                              }
                              setError('');
                              setActionMessage('');
                              setClaimLoading(true);
                              setClaimingNonce(p.nonce);
                              try {
                                const destination = new PublicKey(claimDestinationTokenAccount.trim());
                                const { signature, message } = await signClaimAuthorization(
                                  wallet,
                                  new PublicKey(employerWallet),
                                  p.streamIndex,
                                  p.nonce,
                                  destination,
                                  0,
                                );

                                const keeperUrl =
                                  process.env.NEXT_PUBLIC_KEEPER_API_URL || 'http://localhost:9090';
                                const res = await fetch(`${keeperUrl}/api/claim-auth`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    workerPubkey: wallet.publicKey.toBase58(),
                                    streamIndex: p.streamIndex,
                                    nonce: p.nonce,
                                    signature: Array.from(signature),
                                    message: Array.from(message),
                                    businessOwner: employerWallet,
                                    destinationTokenAccount: destination.toBase58(),
                                    expiry: 0,
                                  }),
                                });

                                if (!res.ok) {
                                  const errBody = await res.json().catch(() => ({}));
                                  throw new Error(
                                    errBody.error || `Failed to submit claim auth: ${res.statusText}`,
                                  );
                                }

                                setLastClaimProof({
                                  nonce: p.nonce,
                                  payoutPda: p.address.toBase58(),
                                  bufferTx: proof || null,
                                  claimTx: 'relay_pending',
                                });
                                setActionMessage(
                                  'Claim authorization sent. Keeper will relay claim to your selected destination.',
                                );
                                // Keeper relays asynchronously; poll status/payout list.
                                await Promise.all([scanPayouts(), loadStatus()]);
                              } catch (e: any) {
                                setError(e?.message || 'Claim failed');
                              } finally {
                                setClaimLoading(false);
                                setClaimingNonce(null);
                              }
                            }}
                            disabled={claimLoading || claimingNonce === p.nonce || !wallet.publicKey}
                            className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2.5 text-xs font-semibold text-blue-700 disabled:opacity-50"
                          >
                            {claimLoading && claimingNonce === p.nonce ? 'Authorizing...' : 'Authorize Keeper Claim'}
                          </button>
                        </div>
                        <AdvancedDetails title="Audit Trail">
                          <div className="mt-3 grid gap-2 text-[10px] text-gray-500">
                            <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                              <span className="font-bold uppercase tracking-widest text-[#2D2D2A]/40 text-[9px]">Nonce Record</span>
                              <span className="font-mono text-gray-400">#{p.nonce}</span>
                            </div>
                            <div className="flex items-center justify-between border-b border-gray-100 pb-1.5">
                              <span className="font-bold uppercase tracking-widest text-[#2D2D2A]/40 text-[9px]">Settlement Proof</span>
                              {proof ? (
                                <a href={explorerTxUrl(proof)} target="_blank" rel="noopener noreferrer" className="text-indigo-500 hover:underline font-bold">
                                  {proof.slice(0, 8)}...{proof.slice(-4)} 🔗
                                </a>
                              ) : (
                                <span className="italic">Verifying on-chain...</span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <span className="font-bold uppercase tracking-widest text-[#2D2D2A]/40 text-[9px]">Confidential Payout PDA</span>
                              <span className="font-mono text-[9px] break-all bg-gray-50 p-2 rounded border border-gray-100">{p.address.toBase58()}</span>
                            </div>
                          </div>
                        </AdvancedDetails>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Success Card */}
              {claimSuccessTx && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 shadow-xl shadow-emerald-500/10">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 ring-8 ring-emerald-50 text-xl">
                      ✓
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-black text-emerald-900 border-b border-emerald-200 pb-2 mb-3">Verified Settlement Receipt</div>

                      <div className="space-y-3">
                        {lastClaimProof?.bufferTx && (
                          <div className="flex items-center justify-between text-[10px]">
                            <span className="font-bold text-emerald-700/60 uppercase">1. Buffer Proof</span>
                            <a href={explorerTxUrl(lastClaimProof.bufferTx)} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-600 hover:underline">
                              {lastClaimProof.bufferTx.slice(0, 12)}...
                            </a>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-bold text-emerald-700/60 uppercase">2. Claim Proof</span>
                          <a href={explorerTxUrl(claimSuccessTx)} target="_blank" rel="noopener noreferrer" className="font-mono text-emerald-600 hover:underline font-bold">
                            {claimSuccessTx.slice(0, 12)}...
                          </a>
                        </div>
                      </div>

                      <div className="mt-3 rounded-lg border border-emerald-200 bg-white/70 px-3 py-2 text-[11px] text-emerald-800">
                        No direct employer -&gt; worker transfer appears in a single payout transaction.
                      </div>

                      {/* ── What's Next? ── */}
                      <div className="mt-4 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200/50 p-4">
                        <div className="text-[10px] font-black text-emerald-900 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                          <span>✨</span> What&apos;s Next?
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white text-[8px] font-black mt-0.5">1</span>
                            <p className="text-[11px] text-emerald-800 leading-relaxed">
                              <span className="font-bold">Your tokens are safe</span> — they&apos;re now in your confidential wallet, fully encrypted on-chain.
                            </p>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white text-[8px] font-black mt-0.5">2</span>
                            <p className="text-[11px] text-emerald-800 leading-relaxed">
                              <span className="font-bold">To use your tokens</span> — unwrap them to regular SPL tokens via the bridge, then transfer or swap freely.
                            </p>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-400 text-white text-[8px] font-black mt-0.5">💡</span>
                            <p className="text-[11px] text-teal-700 leading-relaxed">
                              <span className="font-bold">Or hold them</span> — your balance stays encrypted and private until you choose to move it.
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-4 border-t border-emerald-200 flex items-center justify-between">
                        <span className="text-[10px] text-emerald-800 font-bold uppercase tracking-widest">Status: Claimed</span>
                        <button
                          onClick={() => setClaimSuccessTx(null)}
                          className="text-[10px] font-black text-emerald-600 hover:text-emerald-800 uppercase tracking-widest transition-colors"
                        >
                          Clear Record
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {!claimSuccessTx && (
              <div className="mt-6 flex justify-center">
                <button
                  onClick={async () => {
                    if (!wallet.publicKey || !employerWallet) return;
                    setPayoutsScanning(true);
                    try {
                      const [biz] = getBusinessPDA(new PublicKey(employerWallet));
                      const found = await getPendingPayoutsForWorker(connection, biz, wallet.publicKey);
                      setPendingPayouts(found);
                    } finally {
                      setPayoutsScanning(false);
                    }
                  }}
                  className="text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600"
                >
                  {payoutsScanning ? 'Checking network...' : '↺ Refresh Status'}
                </button>
              </div>
            )}
          </section>

          <section className="panel-card">
            <h2 className="text-lg font-semibold text-[#2D2D2A]">{COPY.employee.sectionB}</h2>
            <p className="mt-1 text-sm text-gray-600">
              Reveal live earnings via keeper confidential relay (strict mode).
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
                    await revealViaKeeperRelay(status.streamIndex);
                  } catch (e: any) {
                    const msg = e?.message || 'Secure reveal failed';
                    setError(msg);
                    setServerRevealHint(
                      'Keeper relay could not reveal this stream. Confirm automation decrypt access is enabled in Employer setup, then try again.'
                    );
                  } finally {
                    setRevealLoading(false);
                  }
                }}
                disabled={revealLoading || !status}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                {revealLoading ? 'Revealing via Keeper...' : 'Reveal Live Earnings (Keeper)'}
              </button>
              {serverRevealHint ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <div className="font-medium">View permission missing</div>
                  <div className="mt-1">{serverRevealHint}</div>
                  <button
                    onClick={async () => {
                      if (!status) return;
                      setRevealLoading(true);
                      setError('');
                      setRevealMessage('');
                      try {
                        await revealViaKeeperRelay(status.streamIndex);
                      } catch (err: any) {
                        setError(err?.message || 'Keeper relay reveal failed');
                      } finally {
                        setRevealLoading(false);
                      }
                    }}
                    disabled={revealLoading || !status}
                    className="mt-3 rounded-md bg-[#1D3557] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#15304d] disabled:opacity-50"
                  >
                    {revealLoading ? 'Revealing...' : 'Reveal via Keeper Relay'}
                  </button>
                </div>
              ) : null}
              {revealMessage ? <ActionResult kind="success">{revealMessage}</ActionResult> : null}
            </div>

            <div className="mt-4 grid gap-2 text-sm text-gray-700">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Estimated live earnings
              </div>
              <div>
                Reveal mode: Keeper confidential relay
              </div>
              <div className="text-3xl font-semibold text-[#0B6E4F]">
                {revealed ? `${formatTokenAmount(earnedLamportsNow)}` : '-'}{' '}
                <span className="text-sm text-gray-600">cUSDC-like (confidential)</span>
              </div>
              {estimatedFrozenAt ? (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  Finalizing on-chain payout. Live estimate is frozen until settlement confirms.
                </div>
              ) : null}
              <div>
                Worker wallet decrypt grant (legacy):{' '}
                {decryptAllowed === null
                  ? 'Unknown'
                  : decryptAllowed.salary && decryptAllowed.accrued
                    ? 'Granted'
                    : 'Not granted'}
              </div>
              <div className="text-xs text-gray-500">
                Strict mode reveal uses keeper relay and does not require worker wallet decrypt grants.
              </div>
              <div>Earning rate: {revealed ? `${formatTokenAmount(revealed.salaryLamportsPerSec)}/sec` : '-'}</div>
              <div>Starting balance: {revealed ? formatTokenAmount(revealed.accruedLamportsCheckpoint) : '-'}</div>
              <div>Starting time: {revealed ? revealed.checkpointTime : '-'}</div>
              <div>
                Last settled on-chain:{' '}
                {status?.lastSettleTime ? new Date(status.lastSettleTime * 1000).toLocaleString() : '-'}
              </div>
              <div className="text-xs text-gray-500">
                Wallet payout reflects finalized on-chain settlement and may differ briefly from the live estimate.
              </div>
            </div>
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
                      destinationTokenAccount:
                        claimDestinationTokenAccount.trim() || status.employeeTokenAccount || null,
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
                {status.hasFixedDestination ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <div>
                      Destination route: claim-time only (no fixed on-chain destination).
                    </div>
                    <div>
                      Use "Claim Destination Token Account" above when authorizing keeper claim.
                    </div>
                  </>
                )}
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
                      {delegationRoute.fqdn ? ` [${delegationRoute.fqdn}]` : ''}
                      {delegationRoute.endpoint ? ` (${delegationRoute.endpoint})` : ''}
                      {delegationRoute.error ? ` (err: ${delegationRoute.error})` : ''}
                    </div>
                  ) : null}
                  <div>
                    Delegation route checked at:{' '}
                    {delegationRouteCheckedAt ? new Date(delegationRouteCheckedAt).toISOString() : '-'}
                  </div>
                  <div>Withdrawal pending: {status.withdrawPending ? 'yes' : 'no'}</div>
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
