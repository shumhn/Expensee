import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Connection } from '@solana/web3.js';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionResult from '../components/ActionResult';
import ExpenseeShell from '../components/ExpenseeShell';
import AdvancedDetails from '../components/AdvancedDetails';
import StepCard, { StepState } from '../components/StepCard';
import {
  claimPayoutV4,
  commitAndUndelegateStreamV4,
  createIncoTokenAccount,
  ensureTeeAuthToken,
  findEmploymentRecordV4,
  getBusinessStreamConfigV4Account,
  getBusinessV4PDA,
  getEmployeeV4Account,
  getEmployeeV4DecryptHandles,
  getEmployeeV4PDA,
  getMasterVaultV4Account,
  getMasterVaultV4PDA,
  getRateHistoryV4Account,
  getPayoutsForEmployeeV4,
  getShieldedPayoutV4Account,
  getShieldedPayoutV4PDA,
  getUserTokenAccountV4,
  getWithdrawRequestV4PDA,
  grantEmployeeViewAccessV4,
  isMagicblockTeeModeEnabled,
  isStoredTeeTokenValid,
  initUserTokenAccountV4,
  linkUserTokenAccountV4,
  PAYUSD_MINT,
  requestWithdrawV4,
  setMagicblockTeeModeEnabled,
} from '../lib/payroll-client';

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

const TOKEN_DECIMALS = 9n;
const TOKEN_SCALE = 10n ** TOKEN_DECIMALS;

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

const FETCH_TIMEOUT_MS = 12_000;

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

function isPermissionError(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes('not allowed') || msg.includes('permission') || msg.includes('view access');
}

type WithdrawPhase = 'idle' | 'creating_token' | 'requesting' | 'waiting_sync' | 'executing' | 'done' | 'error';

export default function EmployeeV4Page() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastTx, setLastTx] = useState<{ label: string; sig: string } | null>(null);
  const [teeStatus, setTeeStatus] = useState<'missing' | 'ready'>('missing');

  const [businessIndexInput, setBusinessIndexInput] = useState('0');
  const [employeeIndexInput, setEmployeeIndexInput] = useState('0');
  const [nonceInput, setNonceInput] = useState('');
  const [withdrawPhase, setWithdrawPhase] = useState<WithdrawPhase>('idle');
  const [withdrawProgress, setWithdrawProgress] = useState('');
  const [indexesAutoFilled, setIndexesAutoFilled] = useState(false);
  const [payoutTokenAccount, setPayoutTokenAccount] = useState('');
  const [destinationTokenAccount, setDestinationTokenAccount] = useState('');
  const [userTokenRegistry, setUserTokenRegistry] = useState<Awaited<ReturnType<typeof getUserTokenAccountV4>>>(null);
  const [userTokenRegistryLoading, setUserTokenRegistryLoading] = useState(false);

  const [employee, setEmployee] = useState<Awaited<ReturnType<typeof getEmployeeV4Account>>>(null);
  const [payout, setPayout] = useState<Awaited<ReturnType<typeof getShieldedPayoutV4Account>>>(null);
  const [withdrawRequestExists, setWithdrawRequestExists] = useState(false);
  const [withdrawRequestLoading, setWithdrawRequestLoading] = useState(false);
  const [payouts, setPayouts] = useState<Awaited<ReturnType<typeof getPayoutsForEmployeeV4>>>([]);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanSuccess, setScanSuccess] = useState(false);
  const autoRefresh = true;
  const [streamConfig, setStreamConfig] = useState<Awaited<ReturnType<typeof getBusinessStreamConfigV4Account>>>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showOverview, setShowOverview] = useState(true);
  const [employeeStep, setEmployeeStep] = useState(1);

  const [revealLoading, setRevealLoading] = useState(false);
  const [revealed, setRevealed] = useState<{
    salaryLamportsPerSec: bigint;
    accruedLamportsCheckpoint: bigint;
    checkpointTime: number;
    revealedAt: number;
  } | null>(null);
  const [earnedLamportsNow, setEarnedLamportsNow] = useState<bigint>(0n);
  const earnedTimerRef = useRef<number | null>(null);
  const [payslipStart, setPayslipStart] = useState('');
  const [payslipEnd, setPayslipEnd] = useState('');
  const [payslipJson, setPayslipJson] = useState('');
  const [payslipLoading, setPayslipLoading] = useState(false);

  const businessIndex = useMemo(() => parseIndex(businessIndexInput), [businessIndexInput]);
  const employeeIndex = useMemo(() => parseIndex(employeeIndexInput), [employeeIndexInput]);
  const nonce = useMemo(() => {
    // Auto-generate nonce if not manually set
    if (!nonceInput) return null;
    return parseIndex(nonceInput);
  }, [nonceInput]);

  // ── URL query param auto-fill + localStorage persistence ──
  useEffect(() => {
    if (!router.isReady) return;
    const qBi = router.query.bi;
    const qEi = router.query.ei;
    let filled = false;
    if (typeof qBi === 'string' && qBi.trim().length > 0) {
      setBusinessIndexInput(qBi.trim());
      filled = true;
    } else {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem('expensee.emp.bi') : null;
      if (stored) setBusinessIndexInput(stored);
    }
    if (typeof qEi === 'string' && qEi.trim().length > 0) {
      setEmployeeIndexInput(qEi.trim());
      filled = true;
    } else {
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem('expensee.emp.ei') : null;
      if (stored) setEmployeeIndexInput(stored);
    }
    if (filled) setIndexesAutoFilled(true);
  }, [router.isReady, router.query.bi, router.query.ei]);

  // Save indexes to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (businessIndexInput) window.localStorage.setItem('expensee.emp.bi', businessIndexInput);
    if (employeeIndexInput) window.localStorage.setItem('expensee.emp.ei', employeeIndexInput);
  }, [businessIndexInput, employeeIndexInput]);

  const [masterVaultPda] = useMemo(() => getMasterVaultV4PDA(), []);
  const businessPda = useMemo(() => {
    if (businessIndex === null) return null;
    return getBusinessV4PDA(masterVaultPda, businessIndex)[0];
  }, [businessIndex, masterVaultPda]);
  const employeePda = useMemo(() => {
    if (!businessPda || employeeIndex === null) return null;
    return getEmployeeV4PDA(businessPda, employeeIndex)[0];
  }, [businessPda, employeeIndex]);
  const payoutPda = useMemo(() => {
    if (!businessPda || employeeIndex === null || nonce === null) return null;
    return getShieldedPayoutV4PDA(businessPda, employeeIndex, nonce)[0];
  }, [businessPda, employeeIndex, nonce]);



  const runAction = useCallback(
    async <T,>(label: string, action: () => Promise<T>) => {
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
    },
    []
  );

  // ── One-click withdraw state machine ──
  const handleOneClickWithdraw = useCallback(async () => {
    if (!wallet.publicKey || !businessPda || employeeIndex === null) {
      setError('Connect wallet and load your employee record first.');
      return;
    }
    setWithdrawPhase('idle');
    setWithdrawProgress('');
    setError('');
    setMessage('');

    if (process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED !== 'true') {
      setError('System Error: TEE environment is not explicitly enabled. Cannot safely execute withdrawal.');
      return;
    }

    const { isMagicblockTeeModeEnabled, getStoredTeeToken } = await import('../lib/payroll-client');
    if (!isMagicblockTeeModeEnabled() || !getStoredTeeToken(wallet.publicKey)) {
      setError('High-speed TEE is not authorized. Please enable TEE signing in your wallet settings below.');
      return;
    }

    setBusy(true);

    try {
      // Step 1: Ensure token registry + destination token exist
      setWithdrawPhase('creating_token');
      setWithdrawProgress('Setting up your private wallet...');

      let registry = await getUserTokenAccountV4(connection, wallet.publicKey, PAYUSD_MINT);
      if (!registry) {
        await initUserTokenAccountV4(connection, wallet, PAYUSD_MINT);
        registry = await getUserTokenAccountV4(connection, wallet.publicKey, PAYUSD_MINT);
      }

      let destToken: PublicKey;
      if (registry && !registry.incoTokenAccount.equals(PublicKey.default)) {
        destToken = registry.incoTokenAccount;
      } else {
        const res = await createIncoTokenAccount(connection, wallet, wallet.publicKey, PAYUSD_MINT);
        destToken = (res as any).tokenAccount;
        await linkUserTokenAccountV4(connection, wallet, destToken, PAYUSD_MINT);
      }
      setDestinationTokenAccount(destToken.toBase58());

      // Step 2: Ensure stream is on base layer, then request withdraw
      setWithdrawPhase('requesting');
      if (businessIndex !== null && employee?.isDelegated) {
        setWithdrawProgress('Committing stream back to Solana...');
        await commitAndUndelegateStreamV4(connection, wallet, businessIndex, employeeIndex);
      }
      setWithdrawProgress('Requesting withdrawal from MagicBlock...');
      await requestWithdrawV4(connection, wallet, businessPda, employeeIndex, true);

      // Step 3: Wait for stream to return to base layer
      setWithdrawPhase('waiting_sync');
      setWithdrawProgress('Waiting for stream to reach Solana...');
      const employeePdaLocal = getEmployeeV4PDA(businessPda, employeeIndex)[0];
      const PAYROLL_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
      let syncReady = false;
      for (let i = 0; i < 30; i++) {
        const info = await connection.getAccountInfo(employeePdaLocal, 'confirmed');
        if (info && info.owner.equals(PAYROLL_PROGRAM_ID)) {
          syncReady = true;
          break;
        }
        setWithdrawProgress(`Waiting for stream to reach Solana... (${i + 1}s)`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!syncReady) {
        throw new Error('Stream did not return to base layer in time. Try again in a minute.');
      }

      // Step 4: Execute full withdrawal (process + claim + redelegate)
      setWithdrawPhase('executing');
      setWithdrawProgress('Processing withdrawal...');

      const autoNonce = Number(Date.now() % 1_000_000);
      setNonceInput(String(autoNonce));

      const master = await getMasterVaultV4Account(connection);
      const vaultToken = await getUserTokenAccountV4(connection, master!.authority, PAYUSD_MINT);
      if (!vaultToken || vaultToken.incoTokenAccount.equals(PublicKey.default)) {
        // Fallback: use the pool vault token from state
        throw new Error('Master vault token account not found. Contact your employer.');
      }

      const { executeFullWithdrawalV4 } = await import('../lib/payroll-client');
      await executeFullWithdrawalV4(
        connection,
        wallet,
        businessPda,
        employeeIndex,
        autoNonce,
        vaultToken.incoTokenAccount,
        destToken
      );

      setWithdrawPhase('done');
      setWithdrawProgress('');
      setMessage('✅ Withdrawal complete! PayUSD deposited to your private wallet.');
    } catch (e: any) {
      setWithdrawPhase('error');
      setWithdrawProgress('');
      setError(e?.message || 'Withdrawal failed');
    } finally {
      setBusy(false);
    }
  }, [wallet, connection, businessPda, businessIndex, employeeIndex, employee?.isDelegated]);



  const refreshTeeStatus = useCallback(() => {
    if (!wallet.publicKey) {
      setTeeStatus('missing');
      return;
    }
    setTeeStatus(isStoredTeeTokenValid(wallet.publicKey) ? 'ready' : 'missing');
  }, [wallet.publicKey]);

  useEffect(() => {
    // MagicBlock TEE is required in v4 flows.
    setMagicblockTeeModeEnabled(true);
    refreshTeeStatus();
  }, [refreshTeeStatus]);

  const refreshWithdrawRequest = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setWithdrawRequestExists(false);
      return;
    }
    setWithdrawRequestLoading(true);
    try {
      const [withdrawRequestPda] = getWithdrawRequestV4PDA(businessPda, employeeIndex);
      const info = await connection.getAccountInfo(withdrawRequestPda, 'confirmed');
      setWithdrawRequestExists(Boolean(info));
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh withdraw request');
    } finally {
      setWithdrawRequestLoading(false);
    }
  }, [businessPda, employeeIndex, connection]);

  const refreshPayouts = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setPayouts([]);
      return;
    }
    setPayoutsLoading(true);
    try {
      const data = await getPayoutsForEmployeeV4(connection, businessPda, employeeIndex, { limit: 5 });
      setPayouts(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh payouts');
    } finally {
      setPayoutsLoading(false);
    }
  }, [businessPda, employeeIndex, connection]);

  const refreshStreamConfig = useCallback(async () => {
    if (!businessPda) {
      setStreamConfig(null);
      return;
    }
    try {
      const config = await getBusinessStreamConfigV4Account(connection, businessPda);
      setStreamConfig(config);
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh stream config');
    }
  }, [businessPda, connection]);

  const refreshEmployee = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setError('Business and employee index are required.');
      return;
    }
    await runAction('Refresh employee', async () => {
      const account = await getEmployeeV4Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      return account;
    });
    await refreshWithdrawRequest();
    await refreshPayouts();
  }, [businessPda, employeeIndex, connection, runAction, refreshPayouts, refreshWithdrawRequest]);

  const handleMagicScan = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError('Please connect your wallet first.');
      return;
    }
    setScanBusy(true);
    setScanError('');
    setScanSuccess(false);
    setMessage('Scanning blockchain for your record... (Signature required)');
    try {
      const result = await findEmploymentRecordV4(connection, wallet);
      if (result) {
        setBusinessIndexInput(result.businessIndex.toString());
        setEmployeeIndexInput(result.employeeIndex.toString());
        setScanSuccess(true);
        setMessage(`Success! Found Business ${result.businessIndex}, Employee ${result.employeeIndex}`);
        // Trigger localized refreshes
        setTimeout(() => {
          refreshEmployee();
          refreshStreamConfig();
        }, 100);
      } else {
        setScanError('No employment record found for this wallet.');
      }
    } catch (err: any) {
      setScanError(err.message || 'Scan failed.');
    } finally {
      setScanBusy(false);
    }
  }, [connection, wallet, refreshEmployee, refreshStreamConfig]);

  const loadEmployeeSilent = useCallback(async () => {
    if (!businessPda || employeeIndex === null) return;
    try {
      const account = await getEmployeeV4Account(connection, businessPda, employeeIndex);
      setEmployee(account);
    } catch {
      // silent refresh
    }
  }, [businessPda, employeeIndex, connection]);

  const refreshPayout = useCallback(async () => {
    if (!businessPda || employeeIndex === null || nonce === null) {
      setError('Business, employee index, and nonce are required.');
      return;
    }
    await runAction('Refresh payout', async () => {
      const account = await getShieldedPayoutV4Account(connection, businessPda, employeeIndex, nonce);
      setPayout(account);
      if (account?.payoutTokenAccount) {
        setPayoutTokenAccount((prev) => prev || account.payoutTokenAccount.toBase58());
      }
      return account;
    });
  }, [businessPda, employeeIndex, nonce, connection, runAction]);

  const loadPayoutSilent = useCallback(async () => {
    if (!businessPda || employeeIndex === null || nonce === null) return;
    try {
      const account = await getShieldedPayoutV4Account(connection, businessPda, employeeIndex, nonce);
      setPayout(account);
      if (account?.payoutTokenAccount) {
        setPayoutTokenAccount((prev) => prev || account.payoutTokenAccount.toBase58());
      }
    } catch {
      // silent refresh
    }
  }, [businessPda, employeeIndex, nonce, connection]);

  const refreshUserTokenRegistry = useCallback(async () => {
    if (!wallet.publicKey) {
      setError('Connect wallet first.');
      return;
    }
    setUserTokenRegistryLoading(true);
    try {
      const registry = await getUserTokenAccountV4(connection, wallet.publicKey, PAYUSD_MINT);
      setUserTokenRegistry(registry);
      if (
        registry &&
        !registry.incoTokenAccount.equals(PublicKey.default) &&
        !destinationTokenAccount
      ) {
        setDestinationTokenAccount(registry.incoTokenAccount.toBase58());
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh token registry');
    } finally {
      setUserTokenRegistryLoading(false);
    }
  }, [connection, destinationTokenAccount, wallet.publicKey]);

  useEffect(() => {
    if (!wallet.connected) {
      setUserTokenRegistry(null);
      return;
    }
    void refreshUserTokenRegistry();
  }, [refreshUserTokenRegistry, wallet.connected]);

  // Auto-load employee when indexes are auto-filled from URL or localStorage
  useEffect(() => {
    if (!wallet.connected || !businessPda || employeeIndex === null) return;
    void loadEmployeeSilent();
  }, [wallet.connected, businessPda, employeeIndex, loadEmployeeSilent]);

  useEffect(() => {
    if (businessPda && employeeIndex !== null) {
      void refreshWithdrawRequest();
    } else {
      setWithdrawRequestExists(false);
    }
  }, [businessPda, employeeIndex, refreshWithdrawRequest]);

  useEffect(() => {
    if (businessPda) {
      void refreshStreamConfig();
    } else {
      setStreamConfig(null);
    }
  }, [businessPda, refreshStreamConfig]);

  useEffect(() => {
    if (!autoRefresh) return;
    if (!businessPda || employeeIndex === null) return;
    const interval = window.setInterval(() => {
      void loadEmployeeSilent();
      void refreshWithdrawRequest();
      void refreshPayouts();
      void refreshStreamConfig();
      if (nonce !== null) {
        void loadPayoutSilent();
      }
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [
    autoRefresh,
    businessPda,
    employeeIndex,
    nonce,
    loadEmployeeSilent,
    loadPayoutSilent,
    refreshPayouts,
    refreshStreamConfig,
    refreshWithdrawRequest,
  ]);

  useEffect(() => {
    if (earnedTimerRef.current) {
      window.clearInterval(earnedTimerRef.current);
      earnedTimerRef.current = null;
    }
    if (!revealed) return;

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
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
    if (revealed.salaryLamportsPerSec !== 0n) {
      earnedTimerRef.current = window.setInterval(tick, 1000);
    }
    return () => {
      if (earnedTimerRef.current) {
        window.clearInterval(earnedTimerRef.current);
        earnedTimerRef.current = null;
      }
    };
  }, [revealed]);



  const refreshEmployeeViewAccess = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      throw new Error('Business and employee index are required.');
    }
    return grantEmployeeViewAccessV4(connection, wallet, businessPda, employeeIndex);
  }, [businessPda, connection, employeeIndex, wallet]);

  const decryptHandlesLocal = useCallback(
    async (handles: string[]) => {
      if (!wallet.publicKey) throw new Error('Wallet not connected');
      if (!wallet.signMessage) throw new Error('Wallet does not support message signing');
      const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
      return decrypt(handles, {
        address: wallet.publicKey,
        signMessage: wallet.signMessage,
      });
    },
    [wallet.publicKey, wallet.signMessage]
  );

  const revealLiveEarnings = useCallback(async () => {
    if (!wallet.publicKey) {
      setError('Connect wallet first.');
      return;
    }
    if (!wallet.signMessage) {
      setError('Wallet does not support signMessage (required for secure reveal).');
      return;
    }
    if (!employee) {
      setError('Load employee record first.');
      return;
    }

    setRevealLoading(true);
    setError('');
    try {
      const handles = getEmployeeV4DecryptHandles(employee);
      const result = await decryptHandlesLocal([handles.salaryHandle, handles.accruedHandle]);
      const salary = BigInt(result?.plaintexts?.[0] || '0');
      const accrued = BigInt(result?.plaintexts?.[1] || '0');
      const checkpointTime = employee.lastAccrualTime > 0 ? employee.lastAccrualTime : employee.lastSettleTime;
      setRevealed({
        salaryLamportsPerSec: salary,
        accruedLamportsCheckpoint: accrued,
        checkpointTime,
        revealedAt: Math.floor(Date.now() / 1000),
      });
      setMessage('Live earnings revealed.');
    } catch (e: any) {
      const msg = e?.message || 'Failed to reveal live earnings';
      if (isPermissionError(msg)) {
        try {
          await refreshEmployeeViewAccess();
          const handles = getEmployeeV4DecryptHandles(employee);
          const retried = await decryptHandlesLocal([handles.salaryHandle, handles.accruedHandle]);
          const salary = BigInt(retried?.plaintexts?.[0] || '0');
          const accrued = BigInt(retried?.plaintexts?.[1] || '0');
          const checkpointTime = employee.lastAccrualTime > 0 ? employee.lastAccrualTime : employee.lastSettleTime;
          setRevealed({
            salaryLamportsPerSec: salary,
            accruedLamportsCheckpoint: accrued,
            checkpointTime,
            revealedAt: Math.floor(Date.now() / 1000),
          });
          setMessage('View access refreshed.');
        } catch (retryErr: any) {
          setError(retryErr?.message || msg);
        }
      } else {
        setError(msg);
      }
    } finally {
      setRevealLoading(false);
    }
  }, [
    decryptHandlesLocal,
    employee,
    refreshEmployeeViewAccess,
    wallet.publicKey,
  ]);

  const generatePayslip = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setError('Connect a wallet that supports signMessage.');
      return;
    }
    if (!employee || !businessPda || employeeIndex === null) {
      setError('Load employee record first.');
      return;
    }
    const startSec = Math.floor(new Date(payslipStart).getTime() / 1000);
    const endSec = Math.floor(new Date(payslipEnd).getTime() / 1000);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0) {
      setError('Invalid statement time window');
      return;
    }
    if (endSec <= startSec) {
      setError('End must be after start');
      return;
    }

    setPayslipLoading(true);
    setError('');
    setPayslipJson('');
    try {
      const handles = getEmployeeV4DecryptHandles(employee);
      const history = await getRateHistoryV4Account(connection, businessPda, employeeIndex);
      const entries = (history?.entries || []).filter((e) => e.effectiveAt > 0).sort((a, b) => a.effectiveAt - b.effectiveAt);

      let effectiveRates: { t: number; handle: string }[] = [];
      let note = 'Computed from the current encrypted salary rate (rate history missing).';
      if (entries.length > 0) {
        let chosen = entries[0]!;
        for (const e of entries) {
          if (e.effectiveAt <= startSec) {
            chosen = e;
          }
        }
        effectiveRates.push({ t: startSec, handle: chosen.salaryHandle });
        for (const e of entries) {
          if (e.effectiveAt > startSec && e.effectiveAt < endSec) {
            effectiveRates.push({ t: e.effectiveAt, handle: e.salaryHandle });
          }
        }
        note = 'Computed from v4 rate history entries.';
      } else {
        effectiveRates = [{ t: startSec, handle: handles.salaryHandle }];
      }

      const uniqueHandles = Array.from(new Set(effectiveRates.map((r) => r.handle)));
      const plaintextByHandle = new Map<string, bigint>();

      const decodePlaintexts = (plaintexts: string[]) => {
        for (let i = 0; i < uniqueHandles.length; i += 1) {
          plaintextByHandle.set(uniqueHandles[i]!, BigInt(plaintexts[i] || '0'));
        }
      };

      try {
        const result = await decryptHandlesLocal(uniqueHandles);
        decodePlaintexts(result?.plaintexts || []);
      } catch (e: any) {
        const msg = e?.message || 'Failed to decrypt salary handles';
        if (isPermissionError(msg)) {
          try {
            await refreshEmployeeViewAccess();
            const retried = await decryptHandlesLocal(uniqueHandles);
            decodePlaintexts(retried?.plaintexts || []);
          } catch (retryErr: any) {
            throw retryErr;
          }
        } else {
          throw e;
        }
      }

      let total = 0n;
      for (let i = 0; i < effectiveRates.length; i += 1) {
        const segStart = effectiveRates[i]!.t;
        const segEnd = i + 1 < effectiveRates.length ? effectiveRates[i + 1]!.t : endSec;
        const dt = Math.max(0, segEnd - segStart);
        const rate = plaintextByHandle.get(effectiveRates[i]!.handle) || 0n;
        total += rate * BigInt(dt);
      }

      const rateEntries = effectiveRates.map((r) => ({
        effectiveAt: r.t,
        salaryLamportsPerSec: (plaintextByHandle.get(r.handle) || 0n).toString(),
      }));
      const latestRate = rateEntries.length
        ? BigInt(rateEntries[rateEntries.length - 1]!.salaryLamportsPerSec || '0')
        : 0n;

      const payload = {
        version: 'expensee_payslip_v4',
        generatedAt: new Date().toISOString(),
        business: businessPda.toBase58(),
        employeeIndex,
        periodStart: startSec,
        periodEnd: endSec,
        salaryLamportsPerSec: latestRate.toString(),
        rateEntries,
        earnedLamports: total.toString(),
        earnedUi: formatTokenAmount(total),
        note,
      };

      const messageBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = await wallet.signMessage(messageBytes);
      const { default: bs58 } = await import('bs58');
      const signed = { ...payload, signer: wallet.publicKey.toBase58(), signature: bs58.encode(sigBytes) };
      setPayslipJson(JSON.stringify(signed, null, 2));
      setMessage('Signed earnings statement generated.');
    } catch (e: any) {
      const msg = e?.message || 'Failed to generate statement';
      setError(msg);
    } finally {
      setPayslipLoading(false);
    }
  }, [
    businessPda,
    connection,
    employee,
    employeeIndex,
    payslipEnd,
    payslipStart,
    wallet.publicKey,
    wallet.signMessage,
  ]);

  const registryLinked = Boolean(
    userTokenRegistry && !userTokenRegistry.incoTokenAccount.equals(PublicKey.default)
  );
  const walletConnected = Boolean(wallet.publicKey);

  const stepPrereqState: StepState = teeStatus === 'ready' ? 'done' : 'active';
  const stepRecordState: StepState = employee ? 'done' : 'active';
  const stepPayoutState: StepState = employee ? 'active' : 'locked';
  const stepEarningsState: StepState = employee ? 'active' : 'locked';

  const showStep1 = employeeStep === 1;
  const showStep2 = employeeStep === 2;
  const showStep3 = employeeStep === 3;
  const showStep4 = employeeStep === 4;
  const advancedAllowed =
    process.env.NEXT_PUBLIC_ENABLE_ADVANCED === 'true' ||
    process.env.NEXT_PUBLIC_ADMIN_MODE === 'true';
  const advancedEnabled = advancedAllowed && showAdvanced;

  return (
    <ExpenseeShell
      title="Employee"
      subtitle="Pooled privacy payouts"
    >
      <Head>
        <title>Expensee Employee v4 | Pooled Privacy</title>
      </Head>

      <div className="employee-portal space-y-6">
        {message ? <ActionResult kind="success">{message}</ActionResult> : null}
        {error ? <ActionResult kind="error">{error}</ActionResult> : null}
        {lastTx ? (
          <ActionResult kind="info">
            Last tx ({lastTx.label}): {lastTx.sig}
          </ActionResult>
        ) : null}

        <div className="expensee-setup-nav">
          <div className="expensee-setup-nav-title">
            <h3>Employee Setup</h3>
            <p>Follow the steps in order. Use Next to continue.</p>
          </div>
          <div className="expensee-setup-nav-steps">
            {[1, 2, 3, 4].map((step) => (
              <button
                key={step}
                type="button"
                className={`expensee-step-chip ${employeeStep === step ? 'active' : ''}`}
                onClick={() => setEmployeeStep(step)}
              >
                Step {step}
              </button>
            ))}
          </div>
          <div className="expensee-setup-nav-actions">
            <span className="text-xs text-gray-500">Auto-refresh every 10s (always on)</span>
            {advancedAllowed ? (
              <label className="expensee-toggle">
                <input
                  type="checkbox"
                  checked={showAdvanced}
                  onChange={(e) => setShowAdvanced(e.target.checked)}
                />
                <span>Advanced mode</span>
              </label>
            ) : null}
            <button
              type="button"
              className="expensee-cta-btn"
              onClick={() => setEmployeeStep((s) => Math.max(1, s - 1))}
              disabled={employeeStep === 1}
            >
              Back
            </button>
            <button
              type="button"
              className="expensee-action-btn"
              onClick={() => setEmployeeStep((s) => Math.min(4, s + 1))}
              disabled={employeeStep === 4}
            >
              Next
            </button>
            <button
              type="button"
              className="expensee-cta-btn"
              onClick={() => setShowOverview((prev) => !prev)}
            >
              {showOverview ? 'Collapse overview' : 'Show overview'}
            </button>
          </div>
        </div>

        {showOverview ? (
          <section className="employee-overview-compact">
            <div>
              <p className="employee-overview-title">Employee setup</p>
              <p className="employee-overview-sub">
                Employers fund payroll using USDC. MagicBlock keeps your stream real-time. You only request and claim payouts.
              </p>
            </div>
            <div className="employee-overview-status">
              <span>Wallet: {walletConnected ? 'Connected' : 'Missing'}</span>
              <span>TEE: {teeStatus === 'ready' ? 'Ready' : 'Needs auth'} (required)</span>
              <span>Record: {employee ? 'Loaded' : 'Missing'}</span>
              <span>Registry: {registryLinked ? 'Linked' : 'Not linked'}</span>
            </div>
          </section>
        ) : null}

        {showStep1 ? (
          <StepCard
            number={1}
            title="Secure access"
            description="Confirm TEE access (required) to execute confidential actions."
            state={stepPrereqState}
          >
            <div className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">TEE Access</h2>
              <p className="mt-1 text-sm text-gray-600">
                TEE access is required to execute employee actions inside MagicBlock PER.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-600">
                <span className="text-gray-500">TEE status:</span>
                <span className={teeStatus === 'ready' ? 'text-emerald-600' : 'text-amber-600'}>
                  {teeStatus === 'ready' ? 'ready' : 'missing'}
                </span>
                <button
                  onClick={async () => {
                    await runAction('Refresh TEE auth', () => ensureTeeAuthToken(wallet));
                    refreshTeeStatus();
                  }}
                  disabled={busy || !wallet.publicKey}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  {teeStatus === 'ready' ? 'Refresh TEE Auth' : 'Authorize TEE'}
                </button>
              </div>
            </div>
          </StepCard>
        ) : null}

        {showStep2 ? (
          <StepCard
            number={2}
            title="Locate payroll record"
            description="Load your employee record using the business and employee index."
            state={stepRecordState}
          >
            {/* ── One-Click Withdraw ── */}
            {employee && (
              <div className="mb-4 rounded-2xl border-2 border-emerald-400/40 bg-gradient-to-r from-emerald-50 to-teal-50 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-bold text-emerald-800">💸 Quick Withdraw</div>
                    <p className="mt-1 text-sm text-emerald-700/80">
                      One click to withdraw all your earned PayUSD. Everything is handled automatically.
                    </p>
                  </div>
                  <button
                    onClick={() => void handleOneClickWithdraw()}
                    disabled={busy || withdrawPhase !== 'idle' && withdrawPhase !== 'done' && withdrawPhase !== 'error'}
                    className="premium-btn premium-btn-primary text-lg px-8 py-3 disabled:opacity-50"
                  >
                    {withdrawPhase === 'done' ? '✅ Done' : withdrawPhase !== 'idle' && withdrawPhase !== 'error' ? '⏳ Working...' : 'Withdraw'}
                  </button>
                </div>
                {withdrawPhase !== 'idle' && (
                  <div className="mt-4">
                    <div className="flex gap-1 mb-2">
                      {(['creating_token', 'requesting', 'waiting_sync', 'executing'] as const).map((phase, i) => (
                        <div
                          key={phase}
                          className={`h-2 flex-1 rounded-full transition-colors ${withdrawPhase === phase
                              ? 'bg-emerald-500 animate-pulse'
                              : withdrawPhase === 'done' || (['creating_token', 'requesting', 'waiting_sync', 'executing'].indexOf(withdrawPhase as any) > i)
                                ? 'bg-emerald-400'
                                : withdrawPhase === 'error'
                                  ? 'bg-red-300'
                                  : 'bg-gray-200'
                            }`}
                        />
                      ))}
                    </div>
                    <div className="text-xs text-emerald-700 font-medium">
                      {withdrawPhase === 'creating_token' && '1/4 — Setting up token accounts...'}
                      {withdrawPhase === 'requesting' && '2/4 — Requesting withdrawal from MagicBlock...'}
                      {withdrawPhase === 'waiting_sync' && '3/4 — Waiting for data to sync to Solana...'}
                      {withdrawPhase === 'executing' && '4/4 — Processing payout...'}
                      {withdrawPhase === 'done' && '✅ Withdrawal complete!'}
                      {withdrawPhase === 'error' && '❌ Error — see details below'}
                    </div>
                    {withdrawProgress && <div className="text-xs text-emerald-600 mt-1">{withdrawProgress}</div>}
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Employee Record</h2>
                <p className="mt-1 text-sm text-gray-600">Use the business index and employee index from your employer.</p>
                <div className="mt-4 space-y-3">
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
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void refreshEmployee()}
                      disabled={busy || !businessPda || employeeIndex === null}
                      className="premium-btn premium-btn-secondary disabled:opacity-50"
                    >
                      Refresh
                    </button>
                    <button
                      onClick={() => void handleMagicScan()}
                      disabled={busy || scanBusy || !wallet.publicKey}
                      className={`premium-btn ${scanSuccess ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'premium-btn-secondary'} disabled:opacity-50 flex items-center gap-2`}
                    >
                      {scanBusy ? (
                        <>
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                          Scanning...
                        </>
                      ) : scanSuccess ? (
                        '🪄 Found!'
                      ) : (
                        '🪄 Magic Scan'
                      )}
                    </button>
                    <button
                      onClick={async () => {
                        if (!businessPda) {
                          setError('Business index is required.');
                          return;
                        }
                        if (process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED !== 'true') {
                          setError('System Error: TEE environment is not explicitly enabled. Cannot safely execute withdrawal.');
                          return;
                        }
                        if (!isMagicblockTeeModeEnabled() || !isStoredTeeTokenValid(wallet.publicKey!)) {
                          setError('High-speed TEE is not authorized. Please enable TEE signing in your wallet settings below.');
                          return;
                        }

                        if (businessIndex !== null && employeeIndex !== null && employee?.isDelegated) {
                          await runAction('Commit stream (required)', () =>
                            commitAndUndelegateStreamV4(connection, wallet, businessIndex, employeeIndex)
                          );
                        }
                        await runAction('Request withdraw', () => {
                          if (employeeIndex === null) throw new Error('Employee index is required');
                          return requestWithdrawV4(connection, wallet, businessPda, employeeIndex, true);
                        });
                        await refreshWithdrawRequest();
                        await refreshPayout();
                        await refreshPayouts();
                      }}
                      disabled={busy || !businessPda || employeeIndex === null}
                      className="premium-btn premium-btn-primary disabled:opacity-50"
                    >
                      Request Withdraw
                    </button>
                  </div>
                </div>
              </div>

              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Record status</h2>
                <p className="mt-1 text-sm text-gray-600">Verification and PDA details.</p>
                <div className="mt-4 grid gap-2 text-xs text-gray-600">
                  <div>Wallet: {walletConnected ? 'connected' : 'not connected'}</div>
                  <div>
                    Withdraw request:{' '}
                    {withdrawRequestLoading ? 'checking...' : withdrawRequestExists ? 'pending' : 'none'}
                  </div>
                  {employee ? (
                    <div>
                      Active: {employee.isActive ? 'yes' : 'no'} · Last settle: {employee.lastSettleTime}
                    </div>
                  ) : (
                    <div className="text-gray-500">No employee record loaded yet.</div>
                  )}
                  {employee ? (
                    <>
                      <div>Streaming: {employee.isDelegated ? 'MagicBlock (real-time)' : 'Base layer (paused)'}</div>
                      <div>Last accrual: {employee.lastAccrualTime}</div>
                    </>
                  ) : null}
                  {advancedEnabled ? (
                    <AdvancedDetails title="Technical details">
                      <div className="text-xs text-[var(--app-muted)] break-all">
                        Business PDA: {businessPda ? businessPda.toBase58() : '—'}
                      </div>
                      <div className="text-xs text-[var(--app-muted)] break-all">
                        Employee PDA: {employeePda ? employeePda.toBase58() : '—'}
                      </div>
                    </AdvancedDetails>
                  ) : null}
                </div>
              </div>
            </div>
          </StepCard>
        ) : null}

        {showStep3 ? (
          <StepCard
            number={3}
            title="Claim payout"
            description="Use the payout nonce from the withdrawal flow to claim to your destination token account."
            state={stepPayoutState}
          >
            <div className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Payout timeline</h2>
              <p className="mt-1 text-sm text-gray-600">
                Track your withdraw request as it moves through buffering and claim.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-gray-600">
                {[
                  { label: 'Requested', active: withdrawRequestExists || Boolean(payout) },
                  { label: 'Buffered', active: Boolean(payout) },
                  { label: 'Claimed', active: Boolean(payout?.claimed) },
                ].map((step, idx) => (
                  <div key={step.label} className="flex items-center gap-3">
                    <div
                      className={`h-2.5 w-2.5 rounded-full border ${step.active ? 'bg-emerald-500 border-emerald-400' : 'bg-gray-200 border-gray-300'
                        }`}
                    />
                    <span className={step.active ? 'text-emerald-700 font-semibold' : 'text-gray-500'}>
                      {step.label}
                    </span>
                    {idx < 2 ? <span className="text-gray-300">—</span> : null}
                  </div>
                ))}
                {withdrawRequestLoading ? <span className="text-gray-400">Checking request…</span> : null}
              </div>
              {payout ? (
                <div className="mt-4 grid gap-2 text-xs text-gray-600">
                  <div>Nonce: {payout.nonce}</div>
                  <div>
                    Created:{' '}
                    {payout.createdAt
                      ? new Date(payout.createdAt * 1000).toLocaleString()
                      : payout.createdAt === 0
                        ? '0'
                        : '—'}
                  </div>
                  <div>
                    Expires:{' '}
                    {payout.expiresAt
                      ? new Date(payout.expiresAt * 1000).toLocaleString()
                      : payout.expiresAt === 0
                        ? '0'
                        : '—'}
                  </div>
                </div>
              ) : (
                <div className="mt-4 text-xs text-gray-500">No buffered payout loaded yet.</div>
              )}
              <div className="mt-5 border-t border-[var(--app-border)] pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-600">Recent payouts</span>
                  <button
                    onClick={() => void refreshPayouts()}
                    disabled={payoutsLoading || !businessPda || employeeIndex === null}
                    className="text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600"
                  >
                    {payoutsLoading ? 'Checking...' : 'Refresh'}
                  </button>
                </div>
                {payouts.length ? (
                  <div className="mt-3 grid gap-2 text-xs text-gray-600">
                    {payouts.map((item) => (
                      <div
                        key={`${item.employeeIndex}-${item.nonce}`}
                        className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">Nonce {item.nonce}</span>
                          <span className={item.claimed ? 'text-emerald-600' : item.cancelled ? 'text-rose-600' : 'text-amber-600'}>
                            {item.claimed ? 'claimed' : item.cancelled ? 'cancelled' : 'pending'}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-1">
                          <div>
                            Created:{' '}
                            {item.createdAt
                              ? new Date(item.createdAt * 1000).toLocaleString()
                              : item.createdAt === 0
                                ? '0'
                                : '—'}
                          </div>
                          <div>
                            Expires:{' '}
                            {item.expiresAt
                              ? new Date(item.expiresAt * 1000).toLocaleString()
                              : item.expiresAt === 0
                                ? '0'
                                : '—'}
                          </div>
                          {advancedEnabled ? (
                            <div className="break-all">Payout token: {item.payoutTokenAccount.toBase58()}</div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-gray-500">No payout history found yet.</div>
                )}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Token registry</h2>
                <p className="mt-1 text-sm text-gray-600">Link your destination token account before claiming.</p>
                <div className="mt-4 space-y-3">
                  {wallet.publicKey ? (
                    <div className="rounded-lg border border-gray-200 bg-white/70 p-3 text-xs text-gray-600">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-700">Registry status</span>
                        <span>
                          {registryLinked
                            ? userTokenRegistry!.incoTokenAccount.toBase58()
                            : 'Not linked'}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            await runAction('Init token registry', () =>
                              initUserTokenAccountV4(connection, wallet, PAYUSD_MINT)
                            );
                            await refreshUserTokenRegistry();
                          }}
                          disabled={busy || userTokenRegistryLoading}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Init Registry
                        </button>
                        <button
                          onClick={async () => {
                            const destination = mustPubkey('destination token account', destinationTokenAccount);
                            await runAction('Link destination token', () =>
                              linkUserTokenAccountV4(connection, wallet, destination, PAYUSD_MINT)
                            );
                            await refreshUserTokenRegistry();
                          }}
                          disabled={busy || userTokenRegistryLoading || !destinationTokenAccount}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Link Destination Token
                        </button>
                        <button
                          onClick={() => void refreshUserTokenRegistry()}
                          disabled={busy || userTokenRegistryLoading}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Refresh Registry
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">Connect a wallet to manage registry links.</div>
                  )}
                  <input
                    value={destinationTokenAccount}
                    onChange={(e) => setDestinationTokenAccount(e.target.value)}
                    placeholder="Destination token account"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <button
                    onClick={async () => {
                      const pk = wallet.publicKey;
                      if (!pk) {
                        setError('Connect wallet first.');
                        return;
                      }
                      const result = await runAction('Create destination token', () =>
                        createIncoTokenAccount(connection, wallet, pk)
                      );
                      if (result && typeof result === 'object' && 'tokenAccount' in result) {
                        setDestinationTokenAccount((result as any).tokenAccount.toBase58());
                      }
                    }}
                    disabled={busy}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Create Destination Token
                  </button>
                </div>
              </div>

              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Payout claim</h2>
                <p className="mt-1 text-sm text-gray-600">Enter payout details from the withdrawal flow.</p>
                <div className="mt-4 space-y-3">
                  <input
                    value={nonceInput}
                    onChange={(e) => setNonceInput(e.target.value)}
                    placeholder="Payout nonce"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  {advancedEnabled ? (
                    <div className="text-xs text-gray-500 break-all">
                      Payout PDA: {payoutPda ? payoutPda.toBase58() : '—'}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void refreshPayout()}
                      disabled={busy || !businessPda || employeeIndex === null || nonce === null}
                      className="premium-btn premium-btn-secondary disabled:opacity-50"
                    >
                      Refresh Payout
                    </button>
                    <button
                      onClick={async () => {
                        if (!businessPda) {
                          setError('Business index is required.');
                          return;
                        }
                        if (employeeIndex === null || nonce === null) {
                          setError('Employee index and nonce required.');
                          return;
                        }
                        await runAction('Execute withdrawal', async () => {
                          const destinationToken = mustPubkey('destination token account', destinationTokenAccount);
                          const { executeFullWithdrawalV4 } = await import('../lib/payroll-client');

                          // For vaultTokenAccount, we need the authority token account
                          const master = await import('../lib/payroll-client').then(m => m.getMasterVaultV4Account(connection));
                          const vaultToken = await import('../lib/payroll-client').then(m => m.getUserTokenAccountV4(connection, master!.authority, PAYUSD_MINT));

                          if (!vaultToken || vaultToken.incoTokenAccount.equals(PublicKey.default)) {
                            throw new Error("Master vault token account not found");
                          }

                          return executeFullWithdrawalV4(
                            connection,
                            wallet,
                            businessPda,
                            employeeIndex,
                            nonce,
                            vaultToken.incoTokenAccount, // vaultTokenAccount
                            destinationToken
                          );
                        });
                        await refreshPayout();
                        await refreshPayouts();
                        await refreshEmployee(); // So UI knows stream is redelegated
                      }}
                      disabled={
                        busy ||
                        !businessPda ||
                        employeeIndex === null ||
                        nonce === null ||
                        !destinationTokenAccount ||
                        (employee?.isDelegated !== false) // Employee stream must be on base layer
                      }
                      className="premium-btn premium-btn-primary disabled:opacity-50"
                    >
                      Execute Withdrawal
                    </button>
                  </div>
                  {employee?.isDelegated !== false && (
                    <div className="text-xs text-amber-600 mt-2">
                      Waiting for stream to reach Solana Base Layer... (Auto-refresh on)
                    </div>
                  )}
                  {payout ? (
                    <div className="text-xs text-gray-600">
                      Claimed: {payout.claimed ? 'yes' : 'no'} · Expires: {payout.expiresAt}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">No payout loaded yet.</div>
                  )}
                </div>
              </div>
            </div>
          </StepCard>
        ) : null}

        {showStep4 ? (
          <StepCard
            number={4}
            title="Live earnings & reports"
            description="Decrypt live earnings and generate a signed statement."
            state={stepEarningsState}
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Live earnings</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Reveal your encrypted salary rate to see real-time earnings.
                </p>
                <div className="mt-4 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={async () => {
                        if (!businessPda || employeeIndex === null) {
                          setError('Business and employee index are required.');
                          return;
                        }
                        await runAction('Grant view access', () =>
                          grantEmployeeViewAccessV4(connection, wallet, businessPda, employeeIndex)
                        );
                      }}
                      disabled={busy || !businessPda || employeeIndex === null}
                      className="premium-btn premium-btn-secondary disabled:opacity-50"
                    >
                      Grant View Access
                    </button>
                    <button
                      onClick={() => void revealLiveEarnings()}
                      disabled={revealLoading || !employee}
                      className="premium-btn premium-btn-primary disabled:opacity-50"
                    >
                      {revealLoading ? 'Revealing...' : 'Reveal Live Earnings'}
                    </button>
                  </div>
                  <div className="rounded-lg border border-gray-800 bg-transparent p-3 text-xs text-gray-400">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Live earnings</div>
                    <div className="mt-2 text-3xl font-semibold text-emerald-400">
                      {revealed ? formatTokenAmount(earnedLamportsNow) : '—'}{' '}
                      <span className="text-sm text-gray-500">USDC (confidential)</span>
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      Live estimate · updates every second from last on-chain snapshot
                    </div>
                    {revealed && revealed.salaryLamportsPerSec === 0n ? (
                      <div className="mt-2 text-[11px] text-amber-500">
                        Salary rate is 0 — stream is paused or unfunded. Live estimate will not
                        increase until the employer tops up and updates your rate.
                      </div>
                    ) : null}
                    <div className="mt-2 grid gap-1">
                      <div>
                        Rate:{' '}
                        {revealed ? `${formatTokenAmount(revealed.salaryLamportsPerSec)}/sec` : '—'}
                      </div>
                      <div>
                        Checkpoint:{' '}
                        {revealed
                          ? new Date(revealed.checkpointTime * 1000).toLocaleString()
                          : '—'}
                      </div>
                      <div>
                        On-chain snapshot:{' '}
                        {employee?.lastAccrualTime || employee?.lastSettleTime
                          ? new Date(
                            (employee.lastAccrualTime || employee.lastSettleTime) * 1000
                          ).toLocaleString()
                          : '—'}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-500">
                    If reveal fails, we auto-refresh your access and retry.
                  </div>
                </div>
              </div>

              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Signed earnings statement</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Generate a signed report for a selected time window.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-500">Start</div>
                    <input
                      type="datetime-local"
                      value={payslipStart}
                      onChange={(e) => setPayslipStart(e.target.value)}
                      className="w-full rounded-lg border border-gray-800 bg-transparent px-3 py-2 text-sm text-gray-300"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-500">End</div>
                    <input
                      type="datetime-local"
                      value={payslipEnd}
                      onChange={(e) => setPayslipEnd(e.target.value)}
                      className="w-full rounded-lg border border-gray-800 bg-transparent px-3 py-2 text-sm text-gray-300"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <button
                    onClick={() => void generatePayslip()}
                    disabled={payslipLoading || !employee}
                    className="w-full premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    {payslipLoading ? 'Generating...' : 'Generate Signed Statement'}
                  </button>
                </div>
                {payslipJson ? (
                  <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-[#0B1320] p-4 text-xs text-[#E6EDF3]">
                    {payslipJson}
                  </pre>
                ) : null}
                <div className="mt-3 text-xs text-gray-500">
                  Uses the current encrypted salary rate (v4 rate history is not yet exposed in the UI).
                </div>
              </div>
            </div>
          </StepCard>
        ) : null}
      </div>
    </ExpenseeShell>
  );
}
