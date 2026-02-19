import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PAYUSD_MINT,
  MAGICBLOCK_DELEGATION_PROGRAM,
  adminWithdrawVaultV2,
  addEmployeeStreamV2,
  grantEmployeeViewAccessV2,
  grantKeeperViewAccessV2,
  createIncoTokenAccount,
  createVaultTokenAccount,
  rotateVaultTokenAccount,
  delegateStreamV2,
  deposit,
  grantBonusV2,
  getBusinessAccount,
  getBusinessStreamConfigV2Account,
  getBusinessPDA,
  getEmployeeStreamV2Account,
  getVaultPDA,
  getVaultAccount,
  initRateHistoryV2,
  initStreamConfigV2,
  updateKeeperV2,
  initVault,
  pauseStreamV2,
  registerBusiness,
  resumeStreamV2,
  updateSalaryRateV2,
} from '../lib/payroll-client';
import PageShell from '../components/PageShell';
import StepCard from '../components/StepCard';
import StatusPill from '../components/StatusPill';
import InlineHelp from '../components/InlineHelp';
import ActionResult from '../components/ActionResult';
import AdvancedDetails from '../components/AdvancedDetails';
import { COPY } from '../lib/copy';
import { getEmployerStepStates } from '../lib/ui-state';

const WalletButton = dynamic(() => import('../components/WalletButton'), {
  ssr: false,
});

const ACTION_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_AUTOMATION_WALLET =
  process.env.NEXT_PUBLIC_DEFAULT_KEEPER_PUBKEY?.trim() ||
  process.env.NEXT_PUBLIC_KEEPER_PUBKEY?.trim() ||
  '';

function mustPubkey(label: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
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

export default function EmployerPage() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastTx, setLastTx] = useState<{ label: string; sig: string } | null>(null);
  const runIdRef = useRef(0);

  const [vaultTokenAccount, setVaultTokenAccount] = useState('');
  const [keeperPubkey, setKeeperPubkey] = useState('');
  const [settleIntervalSecs, setSettleIntervalSecs] = useState('10');
  const [depositAmount, setDepositAmount] = useState('10');
  const [depositorTokenAccount, setDepositorTokenAccount] = useState('');
  const [vaultWithdrawAmount, setVaultWithdrawAmount] = useState('1');
  const [vaultWithdrawTokenAccount, setVaultWithdrawTokenAccount] = useState('');

  const [employeeWallet, setEmployeeWallet] = useState('');
  const [employeeTokenAccount, setEmployeeTokenAccount] = useState('');
  const [salaryPerSecond, setSalaryPerSecond] = useState('0.0001');
  const [payPreset, setPayPreset] = useState<'per_second' | 'hourly' | 'weekly' | 'monthly' | 'fixed_total'>('per_second');
  const [payAmount, setPayAmount] = useState('100'); // amount per hour/week/month or total amount (fixed_total)
  const [fixedTotalDays, setFixedTotalDays] = useState('30'); // used only when payPreset === 'fixed_total'
  const [boundPresetPeriod, setBoundPresetPeriod] = useState(true); // for hourly/weekly/monthly presets
  const [autoGrantDecrypt, setAutoGrantDecrypt] = useState(true);
  const [autoGrantKeeperDecrypt, setAutoGrantKeeperDecrypt] = useState(true);

  const [raiseSalaryPerSecond, setRaiseSalaryPerSecond] = useState('0.0001');
  const [bonusAmount, setBonusAmount] = useState('1');

  const [streamIndexInput, setStreamIndexInput] = useState('0');

  const [businessExists, setBusinessExists] = useState(false);
  const [vaultExists, setVaultExists] = useState(false);
  const [v2ConfigExists, setV2ConfigExists] = useState(false);

  const [v2Config, setV2Config] = useState<{
    keeper: string;
    settleIntervalSecs: number;
    nextStreamIndex: number;
    isPaused: boolean;
    pauseReason: number;
  } | null>(null);

  const [streamStatus, setStreamStatus] = useState<{
    address: string;
    streamIndex: number;
    employeeTokenAccount: string;
    isActive: boolean;
    isDelegated: boolean;
    owner: string;
    lastAccrualTime: number;
    lastSettleTime: number;
    accruedHandle: string;
  } | null>(null);

  const [streamRoute, setStreamRoute] = useState<{
    delegated: boolean | null;
    endpoint: string | null;
    error: string | null;
  } | null>(null);

  const ownerPubkey = wallet.publicKey;
  const effectiveKeeperPubkey = useMemo(
    () => (DEFAULT_AUTOMATION_WALLET || keeperPubkey || wallet.publicKey?.toBase58() || '').trim(),
    [keeperPubkey, wallet.publicKey]
  );
  const derived = useMemo(() => {
    if (!ownerPubkey) return null;
    const [businessPDA] = getBusinessPDA(ownerPubkey);
    const [vaultPDA] = getVaultPDA(businessPDA);
    return { businessPDA, vaultPDA };
  }, [ownerPubkey]);

  const explorerTxUrl = useCallback((sig: string) => {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }, []);

  const explorerAddressUrl = useCallback((addr: string) => {
    return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
  }, []);

  const streamIndex = useMemo(() => {
    const n = Number(streamIndexInput);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }, [streamIndexInput]);

  const hasWorkerRecord = Boolean(streamStatus);
  const highSpeedOn = Boolean(streamStatus?.isDelegated || streamRoute?.delegated);
  const stepStates = getEmployerStepStates({
    businessReady: businessExists,
    vaultReady: vaultExists,
    configReady: v2ConfigExists,
    hasWorkerRecord,
    highSpeedOn,
  });

  function parsePositiveNumber(label: string, value: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
    return n;
  }

  function secondsPerPreset(preset: typeof payPreset): number {
    if (preset === 'hourly') return 60 * 60;
    if (preset === 'weekly') return 7 * 24 * 60 * 60;
    if (preset === 'monthly') return 30 * 24 * 60 * 60;
    return 1;
  }

  function computePerSecondRate(): number {
    if (payPreset === 'per_second') {
      return parsePositiveNumber('Salary per second', salaryPerSecond);
    }
    if (payPreset === 'fixed_total') {
      const total = parsePositiveNumber('Total amount', payAmount);
      const days = parsePositiveNumber('Days', fixedTotalDays);
      return total / (days * 24 * 60 * 60);
    }
    const perPeriod = parsePositiveNumber('Amount per period', payAmount);
    return perPeriod / secondsPerPreset(payPreset);
  }

  function computePeriodBounds(): { periodStart: number; periodEnd: number } {
    if (payPreset === 'fixed_total') {
      const now = Math.floor(Date.now() / 1000);
      const days = parsePositiveNumber('Days', fixedTotalDays);
      const periodStart = now;
      const periodEnd = now + Math.floor(days * 24 * 60 * 60);
      return { periodStart, periodEnd };
    }

    if (!boundPresetPeriod) return { periodStart: 0, periodEnd: 0 };
    if (payPreset !== 'hourly' && payPreset !== 'weekly' && payPreset !== 'monthly') {
      return { periodStart: 0, periodEnd: 0 };
    }

    const now = Math.floor(Date.now() / 1000);
    const periodStart = now;
    const periodEnd = now + secondsPerPreset(payPreset);
    return { periodStart, periodEnd };
  }

  const computedRatePreview = useMemo(() => {
    try {
      return computePerSecondRate();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payPreset, payAmount, fixedTotalDays, salaryPerSecond]);

  // Persist the "operator" inputs per wallet pubkey so the page is less annoying to use.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!ownerPubkey) return;
    const key = `expensee_employer_state_v1:${ownerPubkey.toBase58()}`;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.vaultTokenAccount === 'string') setVaultTokenAccount(parsed.vaultTokenAccount);
      if (typeof parsed?.depositorTokenAccount === 'string') setDepositorTokenAccount(parsed.depositorTokenAccount);
      if (typeof parsed?.vaultWithdrawAmount === 'string') setVaultWithdrawAmount(parsed.vaultWithdrawAmount);
      if (typeof parsed?.vaultWithdrawTokenAccount === 'string') setVaultWithdrawTokenAccount(parsed.vaultWithdrawTokenAccount);
      if (typeof parsed?.keeperPubkey === 'string') setKeeperPubkey(parsed.keeperPubkey);
      if (typeof parsed?.settleIntervalSecs === 'string') setSettleIntervalSecs(parsed.settleIntervalSecs);
      if (typeof parsed?.employeeWallet === 'string') setEmployeeWallet(parsed.employeeWallet);
      if (typeof parsed?.employeeTokenAccount === 'string') setEmployeeTokenAccount(parsed.employeeTokenAccount);
      if (typeof parsed?.salaryPerSecond === 'string') setSalaryPerSecond(parsed.salaryPerSecond);
      if (typeof parsed?.payPreset === 'string') setPayPreset(parsed.payPreset);
      if (typeof parsed?.payAmount === 'string') setPayAmount(parsed.payAmount);
      if (typeof parsed?.fixedTotalDays === 'string') setFixedTotalDays(parsed.fixedTotalDays);
      if (typeof parsed?.boundPresetPeriod === 'boolean') setBoundPresetPeriod(parsed.boundPresetPeriod);
      if (typeof parsed?.autoGrantDecrypt === 'boolean') setAutoGrantDecrypt(parsed.autoGrantDecrypt);
      if (typeof parsed?.streamIndexInput === 'string') setStreamIndexInput(parsed.streamIndexInput);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerPubkey?.toBase58()]);

  useEffect(() => {
    if (DEFAULT_AUTOMATION_WALLET && !keeperPubkey) {
      setKeeperPubkey(DEFAULT_AUTOMATION_WALLET);
    }
  }, [keeperPubkey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!ownerPubkey) return;
    const key = `expensee_employer_state_v1:${ownerPubkey.toBase58()}`;
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          vaultTokenAccount,
          depositorTokenAccount,
          vaultWithdrawAmount,
          vaultWithdrawTokenAccount,
          keeperPubkey,
          settleIntervalSecs,
          employeeWallet,
          employeeTokenAccount,
          salaryPerSecond,
          payPreset,
          payAmount,
          fixedTotalDays,
          boundPresetPeriod,
          autoGrantDecrypt,
          streamIndexInput,
        })
      );
    } catch {
      // ignore
    }
  }, [
    depositorTokenAccount,
    vaultWithdrawAmount,
    vaultWithdrawTokenAccount,
    employeeTokenAccount,
    employeeWallet,
    keeperPubkey,
    ownerPubkey,
    salaryPerSecond,
    payPreset,
    payAmount,
    fixedTotalDays,
    boundPresetPeriod,
    autoGrantDecrypt,
    settleIntervalSecs,
    streamIndexInput,
    vaultTokenAccount,
  ]);

  const loadState = useCallback(async () => {
    if (!ownerPubkey) {
      setBusinessExists(false);
      setVaultExists(false);
      setV2ConfigExists(false);
      setV2Config(null);
      setStreamStatus(null);
      return;
    }
    try {
      const business = await getBusinessAccount(connection, ownerPubkey);
      const exists = business !== null;
      setBusinessExists(exists);

      if (!business) {
        setVaultExists(false);
        setV2ConfigExists(false);
        setV2Config(null);
        setStreamStatus(null);
        return;
      }

      const vault = await getVaultAccount(connection, business.address);
      setVaultExists(vault !== null);
      if (vault) {
        setVaultTokenAccount((prev) => prev || vault.tokenAccount.toBase58());
      }

      const cfg = await getBusinessStreamConfigV2Account(connection, business.address);
      setV2ConfigExists(cfg !== null);
      if (cfg) {
        setV2Config({
          keeper: cfg.keeperPubkey.toBase58(),
          settleIntervalSecs: cfg.settleIntervalSecs,
          nextStreamIndex: cfg.nextStreamIndex,
          isPaused: cfg.isPaused,
          pauseReason: cfg.pauseReason,
        });
        setKeeperPubkey(cfg.keeperPubkey.toBase58());
        setSettleIntervalSecs(String(cfg.settleIntervalSecs));
      } else {
        setV2Config(null);
      }

      if (streamIndex !== null) {
        const stream = await getEmployeeStreamV2Account(connection, business.address, streamIndex);
        if (stream) {
          const accruedBytes = stream.encryptedAccrued.slice(0, 16);
          let accrued = BigInt(0);
          for (let i = 15; i >= 0; i--) {
            accrued = accrued * BigInt(256) + BigInt(accruedBytes[i]);
          }
          // Best-effort: ask MagicBlock router where this stream is delegated (more reliable than base owner).
          try {
            const resp = await fetchWithTimeout(
              `/api/magicblock/delegation-status?pubkey=${encodeURIComponent(stream.address.toBase58())}`
            );
            const json = await resp.json();
            if (resp.ok && json?.ok) {
              const r = json.result || {};
              const delegatedRaw =
                r?.delegated ?? r?.isDelegated ?? r?.delegation?.delegated ?? false;
              const delegated =
                typeof delegatedRaw === 'number' ? delegatedRaw !== 0 : Boolean(delegatedRaw);
              setStreamRoute({
                delegated,
                endpoint: r?.endpoint || r?.delegation?.endpoint || null,
                error: null,
              });
            } else {
              setStreamRoute({ delegated: null, endpoint: null, error: json?.error || 'Router request failed' });
            }
          } catch (e: any) {
            setStreamRoute({ delegated: null, endpoint: null, error: e?.message || 'Router request failed' });
          }
          setStreamStatus({
            address: stream.address.toBase58(),
            streamIndex: stream.streamIndex,
            employeeTokenAccount: stream.employeeTokenAccount.toBase58(),
            isActive: stream.isActive,
            isDelegated: stream.isDelegated,
            owner: stream.owner.toBase58(),
            lastAccrualTime: stream.lastAccrualTime,
            lastSettleTime: stream.lastSettleTime,
            accruedHandle: accrued.toString(),
          });
        } else {
          setStreamStatus(null);
          setStreamRoute(null);
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load employer state');
      setBusinessExists(false);
      setVaultExists(false);
      setV2ConfigExists(false);
      setV2Config(null);
      setStreamStatus(null);
      setStreamRoute(null);
    }
  }, [connection, ownerPubkey, streamIndex]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!busy) return;
    const activeRunId = runIdRef.current;
    const timer = setTimeout(() => {
      if (runIdRef.current !== activeRunId) return;
      runIdRef.current += 1;
      setBusy(false);
      setBusyAction('');
      setError('Action timed out in UI. It may still complete on-chain. Check Phantom, then refresh stream status.');
    }, ACTION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const run = useCallback(
    async (
      label: string,
      task: () => Promise<
        | string
        | {
          txid?: string;
          message?: string;
        }
        | unknown
      >
    ) => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setBusy(true);
      setBusyAction(label);
      setError('');
      setMessage('');
      setLastTx(null);
      try {
        const result = await task();
        if (runIdRef.current !== runId) return;
        const txid =
          typeof result === 'string'
            ? result
            : result && typeof result === 'object' && typeof (result as any).txid === 'string'
              ? (result as any).txid
              : '';
        const successMessage =
          result && typeof result === 'object' && typeof (result as any).message === 'string'
            ? (result as any).message
            : `${label} succeeded`;
        setMessage(successMessage);
        if (txid) setLastTx({ label, sig: txid });
        // Do not block the action UI on post-success reads; a slow RPC should not look like a frozen button.
        setBusy(false);
        setBusyAction('');
        void loadState().catch(() => {
          // Keep success state even if refresh fails; user can manually refresh.
        });
      } catch (e: any) {
        if (runIdRef.current !== runId) return;
        setError(e?.message || `${label} failed`);
      } finally {
        if (runIdRef.current !== runId) return;
        setBusy(false);
        setBusyAction('');
      }
    },
    [loadState]
  );

  return (
    <PageShell
      icon="◈"
      title="Expensee"
      subtitle={COPY.employer.subtitle}
      navItems={[
        { href: '/', label: COPY.nav.home },
        { href: '/employer', label: COPY.nav.company },
        { href: '/employee', label: COPY.nav.worker },
        { href: '/bridge', label: COPY.nav.bridge, advanced: true },
      ]}
    >
      <Head>
        <title>Company Payroll | Expensee</title>
      </Head>

      <section className="hero-card">
        <p className="hero-eyebrow">Employer-first setup</p>
        <h1 className="hero-title">{COPY.employer.title}</h1>
        <p className="hero-subtitle">
          Launch payroll in five guided steps: company setup, funds, worker plan, optional high-speed mode, and go-live monitoring.
        </p>

        <div className="mt-4 readiness-grid">
          <div className="readiness-item">
            <span className="readiness-label">Wallet connected</span>
            <span className="readiness-value">{wallet.connected ? 'Ready' : 'Not connected'}</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-label">Company setup</span>
            <span className="readiness-value">{businessExists ? 'Complete' : 'Pending'}</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-label">Payroll wallet funded</span>
            <span className="readiness-value">{vaultExists ? 'Ready' : 'Pending'}</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-label">Worker record</span>
            <span className="readiness-value">{hasWorkerRecord ? 'Ready' : 'Pending'}</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-label">High-speed mode</span>
            <span className="readiness-value">{highSpeedOn ? 'On' : 'Off'}</span>
          </div>
          <div className="readiness-item">
            <span className="readiness-label">Automation service</span>
            <span className="readiness-value">{v2ConfigExists ? 'Configured' : 'Pending'}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            disabled={!ownerPubkey}
            onClick={() => {
              if (typeof window === 'undefined' || !ownerPubkey) return;
              const key = `expensee_employer_state_v1:${ownerPubkey.toBase58()}`;
              try {
                window.localStorage.removeItem(key);
              } catch {
                // ignore
              }
              setVaultTokenAccount('');
              setDepositorTokenAccount('');
              setVaultWithdrawAmount('1');
              setVaultWithdrawTokenAccount('');
              setEmployeeWallet('');
              setEmployeeTokenAccount('');
              setSalaryPerSecond('0.0001');
              setStreamIndexInput('0');
              setMessage('Cleared saved form values.');
            }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
          >
            Clear saved form
          </button>
          <button
            disabled={!ownerPubkey}
            onClick={() => {
              if (!ownerPubkey) return;
              const next = DEFAULT_AUTOMATION_WALLET || ownerPubkey.toBase58();
              setKeeperPubkey(next);
              setMessage(
                DEFAULT_AUTOMATION_WALLET
                  ? 'Automation service wallet reset to default keeper.'
                  : 'Automation service wallet set to your current wallet for demo.'
              );
            }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
          >
            {DEFAULT_AUTOMATION_WALLET ? 'Use default automation wallet' : 'Use this wallet for automation (demo)'}
          </button>
        </div>

        {busy ? <ActionResult kind="info">In progress: {busyAction || 'Waiting for wallet approval...'}</ActionResult> : null}
        {message ? <ActionResult kind="success">{message}</ActionResult> : null}
        {error ? <ActionResult kind="error">{error}</ActionResult> : null}
        {lastTx ? (
          <p className="mt-3 text-sm text-gray-700">
            Last action ({lastTx.label}):{' '}
            <a href={explorerTxUrl(lastTx.sig)} target="_blank" rel="noreferrer" className="font-mono text-[#005B96] underline">
              {lastTx.sig}
            </a>
          </p>
        ) : null}

        <AdvancedDetails title="Advanced details">
          <div className="grid gap-1 text-sm">
            <div>payUSD mint: {PAYUSD_MINT.toBase58()}</div>
            {derived ? (
              <>
                <div>Company account ID: {derived.businessPDA.toBase58()}</div>
                <div>Payroll vault ID: {derived.vaultPDA.toBase58()}</div>
              </>
            ) : null}
            {vaultTokenAccount ? <div>Payroll vault token account: {vaultTokenAccount}</div> : null}
            {v2Config ? (
              <>
                <div>Automation service wallet: {v2Config.keeper}</div>
                <div>Settlement interval: {v2Config.settleIntervalSecs}s</div>
                <div>Paused: {v2Config.isPaused ? `yes (reason ${v2Config.pauseReason})` : 'no'}</div>
                <div>Next payroll record: {v2Config.nextStreamIndex}</div>
              </>
            ) : null}
          </div>
        </AdvancedDetails>
      </section>

      {!wallet.connected ? (
        <section className="panel-card">
          <p className="text-sm text-gray-700">Connect a wallet to continue.</p>
        </section>
      ) : (
        <div className="space-y-5">
          <StepCard
            number={1}
            title={COPY.employer.step1.title}
            description={COPY.employer.step1.description}
            state={stepStates[1]}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <button
                disabled={busy || businessExists}
                onClick={() => run('Create company profile', async () => {
                  await registerBusiness(connection, wallet);
                })}
                className="w-full rounded-lg bg-[#2D2D2A] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Create Company Profile
              </button>
              <button
                disabled={busy || !ownerPubkey}
                onClick={() => run('Create payroll wallet', async () => {
                  if (!ownerPubkey) throw new Error('Wallet not connected');
                  const [businessPDA] = getBusinessPDA(ownerPubkey);
                  const [vaultPDA] = getVaultPDA(businessPDA);
                  const { txid, tokenAccount } = await createVaultTokenAccount(
                    connection,
                    wallet,
                    vaultPDA,
                    PAYUSD_MINT
                  );
                  setVaultTokenAccount(tokenAccount.toBase58());
                  return txid;
                })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                Create Payroll Wallet
              </button>
            </div>

            <input
              value={vaultTokenAccount}
              onChange={(e) => setVaultTokenAccount(e.target.value)}
              placeholder="Payroll wallet token account"
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />

            <button
              disabled={busy || !businessExists || !vaultTokenAccount}
              onClick={() => run('Initialize payroll wallet', async () => {
                const token = mustPubkey('payroll wallet token account', vaultTokenAccount);
                await initVault(connection, wallet, token, PAYUSD_MINT);
              })}
              className="mt-3 w-full rounded-lg bg-[#3E6B48] px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Initialize Payroll Wallet
            </button>

            <InlineHelp>
              If you already used an older mint, click “Fix payroll wallet mint” in Advanced details below.
            </InlineHelp>

            <AdvancedDetails title="Advanced details">
              <button
                disabled={busy || !businessExists || !vaultExists || !vaultTokenAccount}
                onClick={() => run('Fix payroll wallet mint', async () => {
                  const token = mustPubkey('payroll wallet token account', vaultTokenAccount);
                  return rotateVaultTokenAccount(connection, wallet, token, PAYUSD_MINT);
                })}
                className="w-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 disabled:opacity-50"
              >
                Fix Payroll Wallet Mint
              </button>
            </AdvancedDetails>
          </StepCard>

          <StepCard
            number={2}
            title={COPY.employer.step2.title}
            description={COPY.employer.step2.description}
            state={stepStates[2]}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="Amount"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={depositorTokenAccount}
                onChange={(e) => setDepositorTokenAccount(e.target.value)}
                placeholder="Company source token account"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <button
                disabled={busy || !wallet.publicKey}
                onClick={() => run('Create company source account', async () => {
                  if (!wallet.publicKey) throw new Error('Wallet not connected');
                  const { txid, tokenAccount } = await createIncoTokenAccount(
                    connection,
                    wallet,
                    wallet.publicKey,
                    PAYUSD_MINT
                  );
                  setDepositorTokenAccount(tokenAccount.toBase58());
                  setVaultWithdrawTokenAccount((prev) => prev || tokenAccount.toBase58());
                  return txid;
                })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                Create Company Source Account
              </button>
              <button
                disabled={busy || !businessExists || !vaultExists || !depositorTokenAccount}
                onClick={() => run('Add payroll funds', async () => {
                  if (!ownerPubkey) throw new Error('Wallet not connected');
                  const business = await getBusinessAccount(connection, ownerPubkey);
                  if (!business) throw new Error('Business not found');
                  const vault = await getVaultAccount(connection, business.address);
                  if (!vault) throw new Error('Vault not found');
                  const depositorToken = mustPubkey('source token account', depositorTokenAccount);
                  await deposit(connection, wallet, depositorToken, vault.tokenAccount, Number(depositAmount));
                })}
                className="w-full rounded-lg bg-[#005B96] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Add Funds to Payroll Wallet
              </button>
            </div>

            <InlineHelp>
              Fund the company source token account first, then add funds to payroll wallet.
            </InlineHelp>

            <AdvancedDetails title="Advanced details">
              <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs font-medium text-gray-700">Recover unused payroll funds (owner)</div>
                <input
                  value={vaultWithdrawAmount}
                  onChange={(e) => setVaultWithdrawAmount(e.target.value)}
                  placeholder="Amount to recover"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <input
                  value={vaultWithdrawTokenAccount}
                  onChange={(e) => setVaultWithdrawTokenAccount(e.target.value)}
                  placeholder="Destination token account"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  disabled={busy || !businessExists || !vaultExists || !vaultWithdrawTokenAccount}
                  onClick={() =>
                    run('Recover unused payroll funds', async () => {
                      const destination = mustPubkey('destination token account', vaultWithdrawTokenAccount);
                      const amount = parsePositiveNumber('Withdraw amount', vaultWithdrawAmount);
                      return adminWithdrawVaultV2(connection, wallet, destination, amount);
                    })
                  }
                  className="w-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 disabled:opacity-50"
                >
                  Recover Unused Funds
                </button>
                <button
                  disabled={busy || !depositorTokenAccount}
                  onClick={() => setVaultWithdrawTokenAccount(depositorTokenAccount)}
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-xs disabled:opacity-50"
                >
                  Use Source Account as Destination
                </button>
              </div>
            </AdvancedDetails>
          </StepCard>

          <StepCard
            number={3}
            title={COPY.employer.step3.title}
            description={COPY.employer.step3.description}
            state={stepStates[3]}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <input
                value={keeperPubkey}
                onChange={(e) => setKeeperPubkey(e.target.value)}
                placeholder="Automation service wallet"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                value={settleIntervalSecs}
                onChange={(e) => setSettleIntervalSecs(e.target.value)}
                placeholder="Automation interval (seconds)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <button
                disabled={busy || !businessExists || v2ConfigExists}
                onClick={() => run('Initialize automation service', async () => {
                  const keeper = mustPubkey('automation service wallet', effectiveKeeperPubkey);
                  await initStreamConfigV2(connection, wallet, keeper, Number(settleIntervalSecs));
                })}
                className="w-full rounded-lg bg-[#E85D04] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Initialize Automation Service
              </button>
              <button
                disabled={busy || !businessExists || !v2ConfigExists}
                onClick={() => run('Rotate automation service wallet', async () => {
                  const keeper = mustPubkey('automation service wallet', effectiveKeeperPubkey);
                  const txid = await updateKeeperV2(connection, wallet, keeper);
                  return {
                    txid,
                    message: `Automation service wallet updated to ${keeper.toBase58()}`,
                  };
                })}
                className="w-full rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm text-orange-900 disabled:opacity-50"
              >
                Rotate Automation Wallet
              </button>
            </div>
            {DEFAULT_AUTOMATION_WALLET ? (
              <p className="mt-2 text-xs text-gray-500">
                Default automation wallet is active for all new company setups: {DEFAULT_AUTOMATION_WALLET}
              </p>
            ) : null}

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <input
                value={employeeWallet}
                onChange={(e) => setEmployeeWallet(e.target.value)}
                placeholder="Worker wallet"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                disabled={busy || !wallet.publicKey}
                onClick={() => {
                  if (!wallet.publicKey) return;
                  setEmployeeWallet(wallet.publicKey.toBase58());
                }}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                Use This Wallet as Worker (Demo)
              </button>
              <input
                value={employeeTokenAccount}
                onChange={(e) => setEmployeeTokenAccount(e.target.value)}
                placeholder="Worker destination token account"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                disabled={busy || !employeeWallet}
                onClick={() => run('Create worker destination account', async () => {
                  const employee = mustPubkey('worker wallet', employeeWallet);
                  const { txid, tokenAccount } = await createIncoTokenAccount(connection, wallet, employee, PAYUSD_MINT);
                  setEmployeeTokenAccount(tokenAccount.toBase58());
                  return txid;
                })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
              >
                Create Worker Destination Account
              </button>
            </div>

            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 text-xs font-medium text-gray-700">Pay plan</div>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-xs text-gray-700">
                  Plan type
                  <select
                    value={payPreset}
                    onChange={(e) => setPayPreset(e.target.value as any)}
                    disabled={busy}
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="per_second">Per-second (custom)</option>
                    <option value="hourly">Hourly</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly (30d)</option>
                    <option value="fixed_total">Fixed total over N days</option>
                  </select>
                </label>
                <label className="text-xs text-gray-700">
                  {payPreset === 'fixed_total' ? 'Total amount' : 'Amount per period'}
                  <input
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    disabled={busy || payPreset === 'per_second'}
                    placeholder={payPreset === 'fixed_total' ? 'e.g. 5000' : 'e.g. 30'}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                  />
                </label>
              </div>
              {payPreset === 'fixed_total' && (
                <label className="mt-2 block text-xs text-gray-700">
                  Days
                  <input
                    value={fixedTotalDays}
                    onChange={(e) => setFixedTotalDays(e.target.value)}
                    disabled={busy}
                    placeholder="e.g. 30"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              )}
              {payPreset !== 'per_second' && payPreset !== 'fixed_total' && (
                <label className="mt-2 flex items-center gap-2 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    checked={boundPresetPeriod}
                    onChange={(e) => setBoundPresetPeriod(e.target.checked)}
                    disabled={busy}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Stop automatically at end of this period
                </label>
              )}
              <div className="mt-2 text-xs text-gray-700">
                Computed per-second rate:{' '}
                <span className="font-mono">{computedRatePreview === null ? '-' : computedRatePreview.toFixed(9)}</span>
              </div>
            </div>

            <input
              value={salaryPerSecond}
              onChange={(e) => setSalaryPerSecond(e.target.value)}
              placeholder="Salary per second"
              disabled={busy || payPreset !== 'per_second'}
              className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
            />

            <label className="mt-3 flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={autoGrantDecrypt}
                onChange={(e) => setAutoGrantDecrypt(e.target.checked)}
                disabled={busy}
                className="h-4 w-4 rounded border-gray-300"
              />
              Allow worker to view earnings automatically
            </label>
            <label className="mt-1 flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={autoGrantKeeperDecrypt}
                onChange={(e) => setAutoGrantKeeperDecrypt(e.target.checked)}
                disabled={busy}
                className="h-4 w-4 rounded border-gray-300"
              />
              Allow automation service to process confidential payout automatically
            </label>

            <button
              disabled={busy || !v2ConfigExists}
              onClick={() => run('Create worker payroll record', async () => {
                if (!ownerPubkey) throw new Error('Wallet not connected');
                const employee = mustPubkey('worker wallet', employeeWallet);
                const employeeToken = mustPubkey('worker token account', employeeTokenAccount);
                const ratePerSecond = computePerSecondRate();
                const { periodStart, periodEnd } = computePeriodBounds();
                const result = await addEmployeeStreamV2(
                  connection,
                  wallet,
                  employee,
                  employeeToken,
                  ratePerSecond,
                  periodStart,
                  periodEnd
                );
                setStreamIndexInput(String(result.streamIndex));
                let historyMessage = 'rate history initialized';
                try {
                  await initRateHistoryV2(connection, wallet, result.streamIndex);
                } catch (historyError: any) {
                  const reason = historyError?.message || 'unknown error';
                  historyMessage = `rate history init failed (${reason})`;
                }

                let decryptMessage = 'worker view access skipped';
                if (autoGrantDecrypt) {
                  try {
                    await grantEmployeeViewAccessV2(connection, wallet, ownerPubkey, result.streamIndex, employee);
                    decryptMessage = 'worker view access granted';
                  } catch (grantError: any) {
                    const reason = grantError?.message || 'unknown error';
                    decryptMessage = `worker view grant failed (${reason})`;
                  }
                }

                let keeperMessage = 'automation decrypt skipped';
                if (autoGrantKeeperDecrypt) {
                  try {
                    const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
                    if (!keeperKey) throw new Error('automation wallet missing');
                    const keeper = mustPubkey('automation wallet', keeperKey);
                    await grantKeeperViewAccessV2(connection, wallet, ownerPubkey, result.streamIndex, keeper);
                    keeperMessage = 'automation decrypt granted';
                  } catch (keeperError: any) {
                    const reason = keeperError?.message || 'unknown error';
                    keeperMessage = `automation decrypt grant failed (${reason})`;
                  }
                }

                return {
                  txid: result.txid,
                  message: `Worker payroll record #${result.streamIndex} created: ${historyMessage}; ${decryptMessage}; ${keeperMessage}.`,
                };
              })}
              className="mt-3 w-full rounded-lg bg-[#1D3557] px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Create Worker Payroll Record
            </button>

            <InlineHelp>
              Success means the worker can now open Worker Portal and load this payroll record number.
            </InlineHelp>
          </StepCard>

          <StepCard
            number={4}
            title={COPY.employer.step4.title}
            description={COPY.employer.step4.description}
            state={stepStates[4]}
          >
            <input
              value={streamIndexInput}
              onChange={(e) => setStreamIndexInput(e.target.value)}
              placeholder="Payroll record number"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <button
                disabled={busy || !v2ConfigExists || streamIndex === null}
                onClick={() => run('Enable high-speed mode', async () => {
                  if (!ownerPubkey || streamIndex === null) throw new Error('Invalid payroll record number');
                  return delegateStreamV2(connection, wallet, ownerPubkey, streamIndex);
                })}
                className="w-full rounded-lg bg-[#6A4C93] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Enable High-Speed Mode
              </button>
              <button
                disabled={busy}
                onClick={() => run('Refresh payroll status', async () => {
                  await loadState();
                })}
                className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"
              >
                Refresh Payroll Status
              </button>
            </div>
            <InlineHelp>
              High-speed mode is optional. It improves delegated lifecycle behavior for live demos.
            </InlineHelp>
          </StepCard>

          <StepCard
            number={5}
            title={COPY.employer.step5.title}
            description={COPY.employer.step5.description}
            state={stepStates[5]}
          >
            <div className="grid gap-2 text-sm text-gray-700">
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <span>Payroll status</span>
                <StatusPill tone={v2Config?.isPaused ? 'warning' : 'success'}>
                  {v2Config?.isPaused ? 'Paused' : 'Live'}
                </StatusPill>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <span>Worker payroll record</span>
                <StatusPill tone={streamStatus ? 'success' : 'neutral'}>
                  {streamStatus ? `#${streamStatus.streamIndex}` : 'Not created'}
                </StatusPill>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <span>High-speed mode</span>
                <StatusPill tone={highSpeedOn ? 'success' : 'warning'}>
                  {highSpeedOn ? 'On' : 'Off'}
                </StatusPill>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <button
                disabled={busy || !v2ConfigExists}
                onClick={() => run('Pause payroll', async () => {
                  if (!ownerPubkey) throw new Error('Wallet not connected');
                  await pauseStreamV2(connection, wallet, ownerPubkey, 1);
                })}
                className="w-full rounded-lg bg-[#8C2F39] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Pause Payroll
              </button>
              <button
                disabled={busy || !v2ConfigExists}
                onClick={() => run('Resume payroll', async () => {
                  await resumeStreamV2(connection, wallet);
                })}
                className="w-full rounded-lg bg-[#2A9D8F] px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Resume Payroll
              </button>
            </div>

            <AdvancedDetails title="Advanced details and diagnostics">
              <div className="grid gap-2 text-sm text-gray-700">
                {streamStatus ? (
                  <>
                    <div>
                      Stream address:{' '}
                      <a href={explorerAddressUrl(streamStatus.address)} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                        {streamStatus.address}
                      </a>
                    </div>
                    <div>Destination token account: {streamStatus.employeeTokenAccount}</div>
                    <div>Active: {streamStatus.isActive ? 'yes' : 'no'}</div>
                    <div>Delegated (base read): {streamStatus.isDelegated ? 'yes' : 'no'}</div>
                    <div>Delegated (router): {streamRoute?.delegated === null ? 'unknown' : streamRoute?.delegated ? 'yes' : 'no'}</div>
                    <div>Account owner: {streamStatus.owner}</div>
                    <div>Expected delegation owner: {MAGICBLOCK_DELEGATION_PROGRAM.toBase58()}</div>
                    <div>Last accrual time: {streamStatus.lastAccrualTime}</div>
                    <div>Last settle time: {streamStatus.lastSettleTime}</div>
                    <div>Encrypted accrued handle: {streamStatus.accruedHandle}</div>
                  </>
                ) : (
                  <p>No payroll record found for the selected number.</p>
                )}
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <button
                  disabled={busy || !v2ConfigExists || streamIndex === null || !employeeWallet}
                  onClick={() => run('Grant worker view access', async () => {
                    if (!ownerPubkey || streamIndex === null) throw new Error('Invalid payroll record number');
                    const employee = mustPubkey('worker wallet', employeeWallet);
                    return grantEmployeeViewAccessV2(connection, wallet, ownerPubkey, streamIndex, employee);
                  })}
                  className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  Grant Worker View Access
                </button>
                <button
                  disabled={busy || !v2ConfigExists || streamIndex === null}
                  onClick={() => run('Grant automation decrypt access', async () => {
                    if (!ownerPubkey || streamIndex === null) throw new Error('Invalid payroll record number');
                    const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
                    if (!keeperKey) throw new Error('Automation wallet missing');
                    const keeper = mustPubkey('automation wallet', keeperKey);
                    return grantKeeperViewAccessV2(connection, wallet, ownerPubkey, streamIndex, keeper);
                  })}
                  className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
                >
                  Grant Automation Decrypt Access
                </button>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-700">Private raise (advanced)</div>
                  <input
                    value={raiseSalaryPerSecond}
                    onChange={(e) => setRaiseSalaryPerSecond(e.target.value)}
                    placeholder="New salary per second"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    disabled={busy || !v2ConfigExists || streamIndex === null}
                    onClick={() =>
                      run('Apply private raise', async () => {
                        if (streamIndex === null) throw new Error('Invalid payroll record number');
                        const txid = await updateSalaryRateV2(
                          connection,
                          wallet,
                          streamIndex,
                          Number(raiseSalaryPerSecond)
                        );
                        try {
                          if (ownerPubkey && employeeWallet) {
                            const employee = mustPubkey('worker wallet', employeeWallet);
                            await grantEmployeeViewAccessV2(connection, wallet, ownerPubkey, streamIndex, employee);
                          }
                        } catch {
                          // best-effort
                        }
                        return txid;
                      })
                    }
                    className="w-full rounded-lg bg-[#0B6E4F] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Apply Private Raise
                  </button>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-700">Private bonus (advanced)</div>
                  <input
                    value={bonusAmount}
                    onChange={(e) => setBonusAmount(e.target.value)}
                    placeholder="Bonus amount"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    disabled={busy || !v2ConfigExists || streamIndex === null}
                    onClick={() =>
                      run('Apply private bonus', async () => {
                        if (streamIndex === null) throw new Error('Invalid payroll record number');
                        const txid = await grantBonusV2(connection, wallet, streamIndex, Number(bonusAmount));
                        try {
                          if (ownerPubkey && employeeWallet) {
                            const employee = mustPubkey('worker wallet', employeeWallet);
                            await grantEmployeeViewAccessV2(connection, wallet, ownerPubkey, streamIndex, employee);
                          }
                        } catch {
                          // best-effort
                        }
                        return txid;
                      })
                    }
                    className="w-full rounded-lg bg-[#1D3557] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Apply Private Bonus
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <button
                  disabled={busy || !v2ConfigExists || streamIndex === null}
                  onClick={() =>
                    run('Initialize rate history', async () => {
                      if (streamIndex === null) throw new Error('Invalid payroll record number');
                      const { txid } = await initRateHistoryV2(connection, wallet, streamIndex);
                      return txid;
                    })
                  }
                  className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
                >
                  Initialize Rate History
                </button>
                <button
                  disabled={busy || !v2ConfigExists || !v2Config}
                  onClick={() => run('Backfill automation decrypt access', async () => {
                    if (!ownerPubkey || !v2Config) throw new Error('Missing config');
                    const keeperKey = v2Config.keeper || effectiveKeeperPubkey;
                    if (!keeperKey) throw new Error('Automation wallet missing');
                    const keeper = mustPubkey('automation wallet', keeperKey);
                    const total = v2Config.nextStreamIndex;
                    let granted = 0;
                    let failed = 0;
                    for (let i = 0; i < total; i++) {
                      try {
                        await grantKeeperViewAccessV2(connection, wallet, ownerPubkey, i, keeper);
                        granted++;
                      } catch (e: any) {
                        const msg = e?.message || '';
                        if (msg.includes('not found') || msg.includes('Account does not exist')) continue;
                        failed++;
                      }
                    }
                    return `Backfill complete: ${granted} granted, ${failed} failed out of ${total}`;
                  })}
                  className="w-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm disabled:opacity-50"
                >
                  Backfill Automation Decrypt Access
                </button>
              </div>
            </AdvancedDetails>
          </StepCard>
        </div>
      )}
    </PageShell>
  );
}
