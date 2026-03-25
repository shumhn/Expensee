import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionResult from '../components/ActionResult';
import ExpenseeShell from '../components/ExpenseeShell';
import AdvancedDetails from '../components/AdvancedDetails';
import StepCard, { StepState } from '../components/StepCard';
import {
  ensureTeeAuthToken,
  isMagicblockTeeModeEnabled,
  isStoredTeeTokenValid,
  setMagicblockTeeModeEnabled,
} from '../lib/magicblock/index';
import {
  commitAndUndelegateStreamV4,
  createIncoTokenAccount,
  findEmploymentRecordV4,
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
  initUserTokenAccountV4,
  linkUserTokenAccountV4,
  PAYUSD_MINT,
  requestWithdrawV4,
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

function toDateTimeLocalValue(unixSec: number): string {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return '';
  const date = new Date(unixSec * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function estimateEarnedLamports(
  accruedCheckpoint: bigint,
  salaryPerSecond: bigint,
  remainingBudgetCheckpoint: bigint,
  checkpointTime: number,
  nowSec: number
): bigint {
  const dt = Math.max(0, nowSec - checkpointTime);
  const uncapped = accruedCheckpoint + salaryPerSecond * BigInt(dt);
  const ceiling = accruedCheckpoint + remainingBudgetCheckpoint;
  return uncapped > ceiling ? ceiling : uncapped;
}

function isPermissionError(message: string): boolean {
  const msg = message.toLowerCase();
  return msg.includes('not allowed') || msg.includes('permission') || msg.includes('view access');
}

function isCiphertextMissingError(message: string): boolean {
  return message.toLowerCase().includes('no ciphertext found');
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
  const [, setPayoutTokenAccount] = useState('');
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showOverview, setShowOverview] = useState(true);
  const [employeeStep, setEmployeeStep] = useState(1);

  const [revealLoading, setRevealLoading] = useState(false);
  const [revealed, setRevealed] = useState<{
    salaryLamportsPerSec: bigint;
    accruedLamportsCheckpoint: bigint;
    remainingBudgetCheckpoint: bigint;
    checkpointTime: number;
    revealedAt: number;
  } | null>(null);
  const [liveEarningsNote, setLiveEarningsNote] = useState('');
  const [earnedLamportsNow, setEarnedLamportsNow] = useState<bigint>(0n);
  const earnedTimerRef = useRef<number | null>(null);
  const [payslipStart, setPayslipStart] = useState('');
  const [payslipEnd, setPayslipEnd] = useState('');
  const [payslipJson, setPayslipJson] = useState('');
  const [payslipLoading, setPayslipLoading] = useState(false);
  const [registryBalanceRevealed, setRegistryBalanceRevealed] = useState<bigint | null>(null);
  const [registryBalanceLoading, setRegistryBalanceLoading] = useState(false);
  const [latestPayoutAmountRevealed, setLatestPayoutAmountRevealed] = useState<bigint | null>(null);
  const [latestPayoutAmountLoading, setLatestPayoutAmountLoading] = useState(false);
  const [settledWithdrawalAmount, setSettledWithdrawalAmount] = useState<bigint | null>(null);
  const [triggerReveal, setTriggerReveal] = useState(false);


  const walletScope = wallet.publicKey?.toBase58() ?? null;
  const businessIndex = useMemo(() => parseIndex(businessIndexInput), [businessIndexInput]);
  const employeeIndex = useMemo(() => parseIndex(employeeIndexInput), [employeeIndexInput]);
  const businessIndexStorageKey = useMemo(
    () => (walletScope ? `expensee.employee.businessIndex.${walletScope}` : null),
    [walletScope]
  );
  const employeeIndexStorageKey = useMemo(
    () => (walletScope ? `expensee.employee.employeeIndex.${walletScope}` : null),
    [walletScope]
  );
  const nonce = useMemo(() => {
    // Auto-generate nonce if not manually set
    if (!nonceInput) return null;
    return parseIndex(nonceInput);
  }, [nonceInput]);
  const latestPayout = useMemo(() => (payouts.length ? payouts[0] : null), [payouts]);

  // ── URL query param auto-fill + localStorage persistence ──
  useEffect(() => {
    if (!router.isReady) return;
    const qBi = router.query.bi;
    const qEi = router.query.ei;
    if (!walletScope) {
      setBusinessIndexInput('');
      setEmployeeIndexInput('');
      return;
    }
    if (typeof qBi === 'string' && qBi.trim().length > 0) {
      setBusinessIndexInput(qBi.trim());
    } else {
      const stored = typeof window !== 'undefined' && businessIndexStorageKey
        ? window.localStorage.getItem(businessIndexStorageKey)
        : null;
      if (stored) setBusinessIndexInput(stored);
      else setBusinessIndexInput('');
    }
    if (typeof qEi === 'string' && qEi.trim().length > 0) {
      setEmployeeIndexInput(qEi.trim());
    } else {
      const stored = typeof window !== 'undefined' && employeeIndexStorageKey
        ? window.localStorage.getItem(employeeIndexStorageKey)
        : null;
      if (stored) setEmployeeIndexInput(stored);
      else setEmployeeIndexInput('');
    }
  }, [router.isReady, router.query.bi, router.query.ei, walletScope, businessIndexStorageKey, employeeIndexStorageKey]);

  useEffect(() => {
    setEmployee(null);
    setPayout(null);
    setWithdrawRequestExists(false);
    setWithdrawRequestLoading(false);
    setPayouts([]);
    setPayoutsLoading(false);
    setRegistryBalanceRevealed(null);
    setRegistryBalanceLoading(false);
    setLatestPayoutAmountRevealed(null);
    setLatestPayoutAmountLoading(false);
    setSettledWithdrawalAmount(null);
    setTriggerReveal(false);
    setRevealLoading(false);
    setRevealed(null);
    setLiveEarningsNote('');
    setEarnedLamportsNow(0n);
    setMessage('');
    setError('');
  }, [walletScope]);

  // Save indexes to localStorage whenever they change
  useEffect(() => {
    if (typeof window === 'undefined' || !businessIndexStorageKey) return;
    if (businessIndexInput) window.localStorage.setItem(businessIndexStorageKey, businessIndexInput);
  }, [businessIndexInput, businessIndexStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !employeeIndexStorageKey) return;
    if (employeeIndexInput) window.localStorage.setItem(employeeIndexStorageKey, employeeIndexInput);
  }, [employeeIndexInput, employeeIndexStorageKey]);



  const [masterVaultPda] = useMemo(() => getMasterVaultV4PDA(), []);
  const businessPda = useMemo(() => {
    if (businessIndex === null) return null;
    return getBusinessV4PDA(masterVaultPda, businessIndex)[0];
  }, [businessIndex, masterVaultPda]);
  const canonicalBusinessPda = useMemo(() => employee?.business ?? businessPda, [employee, businessPda]);
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
    if (!wallet.publicKey || !canonicalBusinessPda || employeeIndex === null) {
      setError('Connect wallet and load your employee record first.');
      return;
    }
    setWithdrawPhase('idle');
    setWithdrawProgress('');
    setError('');
    setMessage('');
    setSettledWithdrawalAmount(null);
    setLatestPayoutAmountRevealed(null);
    setRegistryBalanceRevealed(null);

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

      // Step 2: Ensure stream is on base layer
      setWithdrawPhase('requesting');
      if (businessIndex !== null && employee?.isDelegated) {
        setWithdrawProgress('Committing stream back to Solana...');
        await commitAndUndelegateStreamV4(connection, wallet, businessIndex, employeeIndex);
      }

      // Step 3: Wait for stream to return to base layer
      setWithdrawPhase('waiting_sync');
      setWithdrawProgress('Waiting for MagicBlock commit to finalize on Solana...');
      const employeePdaLocal = employee?.address || getEmployeeV4PDA(canonicalBusinessPda, employeeIndex)[0];
      let syncReady = false;
      let committedEmployee: Awaited<ReturnType<typeof getEmployeeV4Account>> = null;
      for (let i = 0; i < 45; i++) {
        let delegatedOnRouter: boolean | null = null;
        try {
          const res = await fetch(`/api/magicblock/delegation-status?pubkey=${employeePdaLocal.toBase58()}`);
          if (res.ok) {
            const json = await res.json();
            delegatedOnRouter =
              json?.result?.isDelegated ?? json?.result?.delegated ?? json?.sdk?.delegated ?? null;
          }
        } catch {
          // Best effort only; we'll still rely on account state below.
        }

        const latestEmployee = await getEmployeeV4Account(connection, canonicalBusinessPda, employeeIndex);
        if (latestEmployee) {
          setEmployee(latestEmployee);
          const delegatedOnAccount = latestEmployee.isDelegated;
          const baseReady =
            delegatedOnAccount === false &&
            (delegatedOnRouter === false || delegatedOnRouter === null);
          if (baseReady) {
            committedEmployee = latestEmployee;
            syncReady = true;
            break;
          }
        }

        setWithdrawProgress(
          `Waiting for MagicBlock commit to finalize on Solana... (${i + 1}/45)`
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!syncReady) {
        throw new Error('MagicBlock commit did not finalize on base layer in time. Please retry once the stream shows Base Layer status.');
      }

      const computedSettledAmount =
        revealed && committedEmployee
          ? estimateEarnedLamports(
              revealed.accruedLamportsCheckpoint,
              revealed.salaryLamportsPerSec,
              revealed.remainingBudgetCheckpoint,
              revealed.checkpointTime,
              committedEmployee.lastAccrualTime,
            )
          : revealed
            ? earnedLamportsNow
            : null;

      setWithdrawPhase('requesting');
      setWithdrawProgress('Requesting withdrawal from Solana...');
      await requestWithdrawV4(connection, wallet, canonicalBusinessPda, employeeIndex, true);

      // Step 4: Execute full withdrawal (process + claim + redelegate)
      setWithdrawPhase('executing');
      setWithdrawProgress('Processing withdrawal...');

      const autoNonce = Number(Date.now() % 1_000_000);
      setNonceInput(String(autoNonce));

      const master = await getMasterVaultV4Account(connection);
      if (!master) {
        throw new Error('Master vault not found. Please contact the administrator.');
      }
      const vaultTokenAccount = master.vaultTokenAccount;

      const { executeFullWithdrawalV4 } = await import('../lib/payroll-client');
      await executeFullWithdrawalV4(
        connection,
        wallet,
        canonicalBusinessPda,
        employeeIndex,
        autoNonce,
        vaultTokenAccount,
        destToken
      );

      const refreshedRegistry = await getUserTokenAccountV4(connection, wallet.publicKey, PAYUSD_MINT);
      setUserTokenRegistry(refreshedRegistry);
      if (
        refreshedRegistry &&
        !refreshedRegistry.incoTokenAccount.equals(PublicKey.default)
      ) {
        setDestinationTokenAccount(refreshedRegistry.incoTokenAccount.toBase58());
      }
      const refreshedEmployee = await getEmployeeV4Account(connection, canonicalBusinessPda, employeeIndex);
      setEmployee(refreshedEmployee);
      const refreshedPayouts = await getPayoutsForEmployeeV4(connection, canonicalBusinessPda, employeeIndex, { limit: 5 });
      setPayouts(refreshedPayouts);
      setRegistryBalanceRevealed(null);
      setSettledWithdrawalAmount(computedSettledAmount);
      setMessage('✅ Withdrawal complete! PayUSD deposited to your private wallet.');

      setWithdrawPhase('done');
      setWithdrawProgress('');
    } catch (e: any) {
      setWithdrawPhase('error');
      setWithdrawProgress('');
      setError(e?.message || 'Withdrawal failed');
    } finally {
      setBusy(false);
    }
  }, [wallet, connection, canonicalBusinessPda, businessIndex, employeeIndex, employee, revealed, earnedLamportsNow]);



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

  const refreshEmployee = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setError('Business and employee index are required.');
      return;
    }
    await runAction('Refresh employee', async () => {
      const account = await getEmployeeV4Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      setScanError('');
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
        const [scannedBusinessPda] = getBusinessV4PDA(masterVaultPda, result.businessIndex);
        setBusinessIndexInput(result.businessIndex.toString());
        setEmployeeIndexInput(result.employeeIndex.toString());
        setScanError('');
        setScanSuccess(true);
        setMessage(`Success! Found Business ${result.businessIndex}, Employee ${result.employeeIndex}`);
        try {
          const account = await getEmployeeV4Account(connection, scannedBusinessPda, result.employeeIndex);
          setEmployee(account);
          await refreshWithdrawRequest();
          await refreshPayouts();
        } catch {
          // Let the normal state-driven refresh path populate the account on the next render.
        }
      } else {
        setScanError('No employment record found for this wallet.');
      }
    } catch (err: any) {
      const msg = err?.message || 'Scan failed.';
      setScanError(
        isCiphertextMissingError(msg)
          ? 'Magic Scan found a matching record, but one older encrypted handle is not currently readable from the covalidator. Your record is still safe. Try Find Record or continue to Step 3.'
          : msg
      );
    } finally {
      setScanBusy(false);
    }
  }, [connection, masterVaultPda, refreshPayouts, refreshWithdrawRequest, wallet]);

  const loadEmployeeSilent = useCallback(async () => {
    if (!businessPda || employeeIndex === null) return;
    try {
      const account = await getEmployeeV4Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      setScanError('');
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
    setRegistryBalanceRevealed(null);
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
    if (!autoRefresh) return;
    if (!businessPda || employeeIndex === null) return;
    const interval = window.setInterval(() => {
      void loadEmployeeSilent();
      void refreshWithdrawRequest();
      void refreshPayouts();
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
            revealed.remainingBudgetCheckpoint,
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

  useEffect(() => {
    if (!employee) return;
    if (payslipStart && payslipEnd) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const checkpointSec = Math.max(employee.lastAccrualTime || 0, employee.lastSettleTime || 0, 0);
    const defaultEndSec = nowSec;
    const defaultStartSec =
      employee.lastSettleTime > 0 && employee.lastSettleTime < defaultEndSec
        ? employee.lastSettleTime
        : checkpointSec > 0 && checkpointSec < defaultEndSec
          ? checkpointSec
          : Math.max(defaultEndSec - 3600, 1);

    if (!payslipStart) {
      setPayslipStart(toDateTimeLocalValue(defaultStartSec));
    }
    if (!payslipEnd) {
      setPayslipEnd(toDateTimeLocalValue(defaultEndSec));
    }
  }, [employee, payslipEnd, payslipStart]);



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
      
      const { ensureTeeAuthToken } = await import('../lib/payroll-client');
      const token = await ensureTeeAuthToken(wallet);
      
      const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
      return decrypt(handles, {
        address: wallet.publicKey,
        signMessage: wallet.signMessage,
        token, // Pass the TEE JWT token for authentication
      } as any);
    },
    [wallet]
  );

  const revealRegistryBalance = useCallback(async (optimisticBalance?: bigint | any) => {
    if (!wallet.publicKey || !userTokenRegistry) return;
    setRegistryBalanceLoading(true);
    if (typeof optimisticBalance === 'bigint') {
      setRegistryBalanceRevealed(optimisticBalance);
      setMessage('Verifying your new balance with the Inco FHE Coprocessor...');
    } else {
      setRegistryBalanceRevealed(null);
      setMessage('');
    }
    setError('');
    try {
      const {
        readU128LEFrom32,
        checkAllowanceStale,
        grantIncoDecryptAccessForHandle,
      } = await import('../lib/payroll-client');

      const readCurrentHandle = async (): Promise<bigint> => {
        const liveRegistry = await getUserTokenAccountV4(connection, wallet.publicKey!, PAYUSD_MINT);
        if (liveRegistry) {
          setUserTokenRegistry(liveRegistry);
          if (!liveRegistry.incoTokenAccount.equals(PublicKey.default)) {
            setDestinationTokenAccount(liveRegistry.incoTokenAccount.toBase58());
          }
          return readU128LEFrom32(Buffer.from(liveRegistry.encryptedBalance));
        }
        return 0n;
      };

      let handleValue = await readCurrentHandle();

      if (handleValue === 0n) {
        setRegistryBalanceRevealed(0n);
        setMessage('Private balance is zero.');
        return;
      }

      const decryptHandle = async (value: bigint): Promise<bigint> => {
        const result = await decryptHandlesLocal([value.toString()]);
        if (result?.plaintexts?.[0] === undefined) {
          throw new Error('Failed to decrypt balance');
        }
        return BigInt(result.plaintexts[0]);
      };

      const tryReveal = async (value: bigint): Promise<bigint | null> => {
        const isStale = await checkAllowanceStale(connection, value, wallet.publicKey!);
        if (isStale) {
          setMessage('Proof of ownership required. Please sign to grant TEE view access...');
          await grantIncoDecryptAccessForHandle(connection, wallet, value);
        }

        try {
          return await decryptHandle(value);
        } catch (decryptErr: any) {
          const msg = decryptErr?.message || 'Failed to reveal private balance';
          if (isPermissionError(msg)) {
            setMessage('Refreshing TEE view access and retrying private balance...');
            await grantIncoDecryptAccessForHandle(connection, wallet, value);
            return decryptHandle(value);
          }
          if (isCiphertextMissingError(msg)) {
            return null;
          }
          throw decryptErr;
        }
      };

      // First attempt
      const revealed = await tryReveal(handleValue);
      if (revealed !== null) {
        setRegistryBalanceRevealed(revealed);
        setMessage('Private balance revealed!');
        return;
      }

      // Poll the covalidator: retry up to 25 times with 3-second delays (≈75s total)
      const MAX_POLL_ATTEMPTS = 25;
      const POLL_DELAY_MS = 3_000;

      for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        setMessage(
          `Inco FHE Coprocessor is computing your new private balance... (${attempt}/${MAX_POLL_ATTEMPTS})`
        );
        await new Promise((r) => setTimeout(r, POLL_DELAY_MS));

        // Re-read handle — it may change between polls
        handleValue = await readCurrentHandle();
        if (handleValue === 0n) {
          setRegistryBalanceRevealed(0n);
          setMessage('Private balance is zero.');
          return;
        }

        const retried = await tryReveal(handleValue);
        if (retried !== null) {
          setRegistryBalanceRevealed(retried);
          setMessage('Private balance revealed!');
          return;
        }
      }

      // All retries exhausted — surface a clearer message
      throw new Error(
        'The Inco FHE network is taking longer than expected to process your encrypted balance. ' +
        'Your funds have been successfully transferred, but the ciphertext is not ready for decryption yet. Please check back in a minute.'
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to reveal private balance');
    } finally {
      setRegistryBalanceLoading(false);
    }
  }, [connection, decryptHandlesLocal, userTokenRegistry, wallet]);

  useEffect(() => {
    if (triggerReveal) {
      setTriggerReveal(false);
      // We pass the current optimistic balance down to keep the UI stable while it polls
      const optimistic = typeof registryBalanceRevealed === 'bigint' ? registryBalanceRevealed : undefined;
      revealRegistryBalance(optimistic);
    }
  }, [triggerReveal, revealRegistryBalance, registryBalanceRevealed]);

  const revealLatestPayoutAmount = useCallback(async () => {
    if (!wallet.publicKey) {
      setError('Connect wallet first.');
      return;
    }
    if (!latestPayout) {
      setError('No recent payout found yet.');
      return;
    }

    setLatestPayoutAmountLoading(true);
    setLatestPayoutAmountRevealed(null);
    setError('');
    try {
      const { readU128LEFrom32, checkAllowanceStale, grantIncoDecryptAccessForHandle } = await import('../lib/payroll-client');
      const handleValue = readU128LEFrom32(Buffer.from(latestPayout.encryptedAmount));
      if (handleValue === 0n) {
        setLatestPayoutAmountRevealed(0n);
        setMessage('Latest payout amount is zero.');
        return;
      }

      const stale = await checkAllowanceStale(connection, handleValue, wallet.publicKey);
      if (stale) {
        setMessage('Proof of ownership required. Please sign to reveal the latest payout amount...');
        await grantIncoDecryptAccessForHandle(connection, wallet, handleValue);
      }

      const decryptOne = async (): Promise<bigint> => {
        const result = await decryptHandlesLocal([handleValue.toString()]);
        if (result?.plaintexts?.[0] === undefined) {
          throw new Error('Failed to decrypt payout amount');
        }
        return BigInt(result.plaintexts[0]);
      };

      const tryDecrypt = async (): Promise<bigint | null> => {
        try {
          return await decryptOne();
        } catch (decryptErr: any) {
          const msg = decryptErr?.message || 'Failed to decrypt payout amount';
          if (isPermissionError(msg)) {
            await grantIncoDecryptAccessForHandle(connection, wallet, handleValue);
            return decryptOne();
          }
          if (isCiphertextMissingError(msg)) {
            return null;
          }
          throw decryptErr;
        }
      };

      // First attempt
      const firstResult = await tryDecrypt();
      if (firstResult !== null) {
        setLatestPayoutAmountRevealed(firstResult);
        setMessage('Latest withdrawal amount revealed.');
        return;
      }

      // Poll the covalidator: retry up to 20 times with 3-second delays
      const MAX_POLL = 20;
      const POLL_DELAY = 3_000;
      for (let attempt = 1; attempt <= MAX_POLL; attempt++) {
        setMessage(
          `Inco FHE Coprocessor is computing the payout amount... (${attempt}/${MAX_POLL})`
        );
        await new Promise((r) => setTimeout(r, POLL_DELAY));

        const retried = await tryDecrypt();
        if (retried !== null) {
          setLatestPayoutAmountRevealed(retried);
          setMessage('Latest withdrawal amount revealed.');
          return;
        }
      }

      throw new Error(
        'The Inco FHE network is taking longer than expected to process your payout amount. ' +
        'Please wait a minute and try again.'
      );
    } catch (e: any) {
      setError(e?.message || 'Failed to reveal latest withdrawal amount');
    } finally {
      setLatestPayoutAmountLoading(false);
    }
  }, [connection, decryptHandlesLocal, latestPayout, wallet]);

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
    if (!businessPda || employeeIndex === null) {
      setError('Business and employee index are required.');
      return;
    }

    setRevealLoading(true);
    setError('');
    setLiveEarningsNote('');
    try {
      const latestEmployee =
        (await getEmployeeV4Account(connection, businessPda, employeeIndex)) || employee;
      if (latestEmployee !== employee) {
        setEmployee(latestEmployee);
      }

      const handles = getEmployeeV4DecryptHandles(latestEmployee);
      const decryptOne = async (handle: string): Promise<bigint> => {
        const result = await decryptHandlesLocal([handle]);
        return BigInt(result?.plaintexts?.[0] || '0');
      };

      let salary: bigint | null = null;
      let accrued: bigint | null = null;
      let remainingBudget: bigint | null = null;
      let usedCiphertextFallback = false;

      try {
        salary = await decryptOne(handles.salaryHandle);
      } catch (salaryErr: any) {
        const salaryMsg = salaryErr?.message || 'Failed to decrypt salary handle';
        if (isPermissionError(salaryMsg)) {
          await refreshEmployeeViewAccess();
          salary = await decryptOne(handles.salaryHandle);
        } else if (isCiphertextMissingError(salaryMsg)) {
          salary = 0n;
          usedCiphertextFallback = true;
        } else {
          throw salaryErr;
        }
      }

      try {
        accrued = await decryptOne(handles.accruedHandle);
      } catch (accruedErr: any) {
        const accruedMsg = accruedErr?.message || 'Failed to decrypt accrued handle';
        if (isPermissionError(accruedMsg)) {
          await refreshEmployeeViewAccess();
          accrued = await decryptOne(handles.accruedHandle);
        } else if (isCiphertextMissingError(accruedMsg)) {
          accrued = 0n;
          usedCiphertextFallback = true;
        } else {
          throw accruedErr;
        }
      }

      try {
        remainingBudget = await decryptOne(handles.remainingBudgetHandle);
      } catch (remainingErr: any) {
        const remainingMsg = remainingErr?.message || 'Failed to decrypt remaining budget handle';
        if (isPermissionError(remainingMsg)) {
          await refreshEmployeeViewAccess();
          remainingBudget = await decryptOne(handles.remainingBudgetHandle);
        } else if (isCiphertextMissingError(remainingMsg)) {
          remainingBudget = 0n;
          usedCiphertextFallback = true;
        } else {
          throw remainingErr;
        }
      }

      if (salary === null || accrued === null || remainingBudget === null) {
        throw new Error('Live earnings are temporarily unavailable for this stream state.');
      }

      const checkpointTime =
        latestEmployee.lastAccrualTime > 0 ? latestEmployee.lastAccrualTime : latestEmployee.lastSettleTime;
      setRevealed({
        salaryLamportsPerSec: salary,
        accruedLamportsCheckpoint: accrued,
        remainingBudgetCheckpoint: remainingBudget,
        checkpointTime,
        revealedAt: Math.floor(Date.now() / 1000),
      });
      setLiveEarningsNote(
        usedCiphertextFallback
          ? 'One or more encrypted checkpoints were not materialized by the covalidator yet, so this snapshot may be partial.'
          : ''
      );
      setMessage(
        usedCiphertextFallback
          ? 'Live earnings opened with a zero fallback for a non-materialized ciphertext handle. The stream is readable, but one encrypted checkpoint is not currently available from the covalidator.'
          : 'Live earnings revealed.'
      );
    } catch (e: any) {
      const msg = e?.message || 'Failed to reveal live earnings';
      if (isPermissionError(msg) || isCiphertextMissingError(msg)) {
        try {
          const refreshedEmployee =
            (await getEmployeeV4Account(connection, businessPda, employeeIndex)) || employee;
          if (refreshedEmployee !== employee) {
            setEmployee(refreshedEmployee);
          }
          await refreshEmployeeViewAccess();
          const handles = getEmployeeV4DecryptHandles(refreshedEmployee);
          const retriedSalary = await decryptHandlesLocal([handles.salaryHandle]).catch(() => ({ plaintexts: ['0'] }));
          const retriedAccrued = await decryptHandlesLocal([handles.accruedHandle]).catch(() => ({ plaintexts: ['0'] }));
          const retriedRemaining = await decryptHandlesLocal([handles.remainingBudgetHandle]).catch(() => ({ plaintexts: ['0'] }));
          const salary = BigInt(retriedSalary?.plaintexts?.[0] || '0');
          const accrued = BigInt(retriedAccrued?.plaintexts?.[0] || '0');
          const remainingBudget = BigInt(retriedRemaining?.plaintexts?.[0] || '0');
          const checkpointTime =
            refreshedEmployee.lastAccrualTime > 0
              ? refreshedEmployee.lastAccrualTime
              : refreshedEmployee.lastSettleTime;
          setRevealed({
            salaryLamportsPerSec: salary,
            accruedLamportsCheckpoint: accrued,
            remainingBudgetCheckpoint: remainingBudget,
            checkpointTime,
            revealedAt: Math.floor(Date.now() / 1000),
          });
          setLiveEarningsNote(
            'One or more encrypted checkpoints were not materialized by the covalidator yet, so this snapshot may be partial.'
          );
          setMessage('Refreshed the employee stream state and retried the live reveal.');
        } catch (retryErr: any) {
          setError(
            isCiphertextMissingError(msg)
              ? 'The current stream uses an encrypted handle that the covalidator cannot reveal yet. Try again after the next sync/settle, or use the withdraw flow to bring the stream back to base before revealing.'
              : retryErr?.message || msg
          );
        }
      } else {
        setError(msg);
      }
    } finally {
      setRevealLoading(false);
    }
  }, [
    businessPda,
    connection,
    decryptHandlesLocal,
    employee,
    employeeIndex,
    refreshEmployeeViewAccess,
    wallet.publicKey,
    wallet.signMessage,
    setLiveEarningsNote,
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
    if (!payslipStart || !payslipEnd) {
      setError('Choose both the start and end time for the signed statement.');
      return;
    }
    const startSec = Math.floor(new Date(payslipStart).getTime() / 1000);
    const endSec = Math.floor(new Date(payslipEnd).getTime() / 1000);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec <= 0 || endSec <= 0) {
      setError('Choose a valid statement time window.');
      return;
    }
    if (endSec <= startSec) {
      setError('End time must be after start time.');
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
      let usedCiphertextFallback = false;
      let refreshedAccess = false;

      const decryptRateHandle = async (handle: string): Promise<bigint> => {
        try {
          const result = await decryptHandlesLocal([handle]);
          return BigInt(result?.plaintexts?.[0] || '0');
        } catch (e: any) {
          const msg = e?.message || 'Failed to decrypt salary handle';
          if (isPermissionError(msg)) {
            if (!refreshedAccess) {
              await refreshEmployeeViewAccess();
              refreshedAccess = true;
            }
            const retried = await decryptHandlesLocal([handle]);
            return BigInt(retried?.plaintexts?.[0] || '0');
          }
          if (isCiphertextMissingError(msg)) {
            usedCiphertextFallback = true;
            return 0n;
          }
          throw e;
        }
      };

      for (const handle of uniqueHandles) {
        plaintextByHandle.set(handle, await decryptRateHandle(handle));
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
        note: usedCiphertextFallback
          ? `${note} One or more encrypted rate handles were not materialized by the covalidator, so those segments were treated as zero in this statement.`
          : note,
      };

      const messageBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = await wallet.signMessage(messageBytes);
      const { default: bs58 } = await import('bs58');
      const signed = { ...payload, signer: wallet.publicKey.toBase58(), signature: bs58.encode(sigBytes) };
      setPayslipJson(JSON.stringify(signed, null, 2));
      setMessage(
        usedCiphertextFallback
          ? 'Signed earnings statement generated with a zero fallback for a non-materialized encrypted rate handle.'
          : 'Signed earnings statement generated.'
      );
    } catch (e: any) {
      const msg = e?.message || 'Failed to generate statement';
      setError(
        isCiphertextMissingError(msg)
          ? 'One of the encrypted salary checkpoints is not currently available from the covalidator. Try again after the next sync, or generate the statement after bringing the stream back to base.'
          : msg
      );
    } finally {
      setPayslipLoading(false);
    }
  }, [
    businessPda,
    connection,
    decryptHandlesLocal,
    employee,
    employeeIndex,
    payslipEnd,
    payslipStart,
    refreshEmployeeViewAccess,
    wallet,
  ]);

  const handleDownloadPayslip = useCallback(() => {
    if (!payslipJson) {
      setError('Generate the signed statement first.');
      return;
    }
    if (typeof window === 'undefined') return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `expensee-signed-statement-b${businessIndex ?? 'x'}-e${employeeIndex ?? 'x'}-${timestamp}.json`;
    const blob = new Blob([payslipJson], { type: 'application/json;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
    setMessage(`Downloaded ${filename}`);
  }, [businessIndex, employeeIndex, payslipJson]);

  const handleCopyPayslip = useCallback(async () => {
    if (!payslipJson) {
      setError('Generate the signed statement first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(payslipJson);
      setMessage('Signed statement copied to clipboard.');
    } catch (e: any) {
      setError(e?.message || 'Failed to copy signed statement.');
    }
  }, [payslipJson]);

  const registryLinked = Boolean(
    userTokenRegistry && !userTokenRegistry.incoTokenAccount.equals(PublicKey.default)
  );
  const walletConnected = Boolean(wallet.publicKey);

  const stepPrereqState: StepState = teeStatus === 'ready' ? 'done' : 'active';
  const stepRecordState: StepState = employee ? 'done' : 'active';
  const stepWithdrawState: StepState = employee ? 'active' : 'locked';
  const stepEarningsState: StepState = employee ? 'active' : 'locked';

  const showStep1 = employeeStep === 1;
  const showStep2 = employeeStep === 2;
  const showStep3 = employeeStep === 4;
  const showStep4 = employeeStep === 3;
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
                Employers fund payroll using USDC. First find your payroll record, then review your live earnings, and finally withdraw when you are ready.
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
            title="Find payroll record"
            description="Load your employee record using the business and employee index, or let Magic Scan find it for you."
            state={stepRecordState}
          >
            {employee ? (
              <div className="mb-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                Record found. You can now continue to Step 3 to review live earnings before requesting a withdrawal.
              </div>
            ) : null}

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
                      Find Record
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
                  </div>
                  {scanError ? (
                    <div className="text-xs text-amber-600">{scanError}</div>
                  ) : null}
                </div>
              </div>

              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Record status</h2>
                <p className="mt-1 text-sm text-gray-600">Verification and stream status before you move to live earnings.</p>
                <div className="mt-4 grid gap-2 text-xs text-gray-600">
                  <div>Wallet: {walletConnected ? 'connected' : 'not connected'}</div>
                  <div>TEE: {teeStatus === 'ready' ? 'ready' : 'missing'}</div>
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
                      <div>Next step: review live earnings</div>
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
            number={4}
            title="Withdraw & claim"
            description="Request a withdrawal, sync from MagicBlock if needed, and claim to your destination token account."
            state={stepWithdrawState}
          >
            {employee ? (
              <div className="mb-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm text-cyan-100">
                {employee.isDelegated
                  ? 'Your stream is currently running on MagicBlock. Before payout, Expensee will first sync it back to Solana, then continue the withdrawal flow.'
                  : 'Your stream is already on the base layer, so you can request a withdrawal directly.'}
              </div>
            ) : (
              <div className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                Find your payroll record first in Step 2 before requesting a withdrawal.
              </div>
            )}

            {employee && (
              <div className="mb-4 rounded-2xl border-2 border-emerald-400/40 bg-gradient-to-r from-emerald-50 to-teal-50 p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-bold text-emerald-800">One-Click Withdraw (Recommended)</div>
                    <p className="mt-1 text-sm text-emerald-700/80">
                      One click to withdraw all earned PayUSD. Expensee handles MagicBlock sync, payout processing, and claim preparation automatically.
                    </p>
                  </div>
                  <button
                    onClick={() => void handleOneClickWithdraw()}
                    disabled={busy || withdrawPhase !== 'idle' && withdrawPhase !== 'done' && withdrawPhase !== 'error'}
                    className="premium-btn premium-btn-primary text-lg px-8 py-3 disabled:opacity-50"
                  >
                    {withdrawPhase === 'done' ? 'Done' : withdrawPhase !== 'idle' && withdrawPhase !== 'error' ? 'Working...' : 'One-Click Withdraw'}
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
                      {withdrawPhase === 'done' && 'Withdrawal complete!'}
                      {withdrawPhase === 'error' && 'Error — see details below'}
                    </div>
                    {withdrawProgress && <div className="text-xs text-emerald-600 mt-1">{withdrawProgress}</div>}
                  </div>
                )}
              </div>
            )}

            <div className="mb-4 rounded-2xl border border-white/10 bg-black/20 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-[#F5F5F5]">Private wallet summary</h2>
                  <p className="mt-1 text-sm text-gray-400">
                    Your withdrawn PayUSD lands in this linked private token account first.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void revealRegistryBalance()}
                    disabled={registryBalanceLoading || !registryLinked}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    {registryBalanceLoading ? 'Revealing...' : 'Reveal Private Balance'}
                  </button>
                  <button
                    onClick={() => void refreshUserTokenRegistry()}
                    disabled={busy || userTokenRegistryLoading}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    {userTokenRegistryLoading ? 'Refreshing...' : 'Refresh Wallet'}
                  </button>
                  {(registryBalanceRevealed !== null || settledWithdrawalAmount !== null) && registryLinked ? (
                    <button
                      onClick={() => {
                        const params = new URLSearchParams();
                        params.set('confidentialTokenAccount', userTokenRegistry!.incoTokenAccount.toBase58());
                        params.set(
                          'amountUi',
                          formatTokenAmount(
                            registryBalanceRevealed !== null ? registryBalanceRevealed : settledWithdrawalAmount || 0n
                          )
                        );
                        router.push(`/bridge?${params.toString()}`);
                      }}
                      className="premium-btn premium-btn-primary"
                    >
                      Unwrap To Public
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Private balance</div>
                  <div className="mt-2 text-2xl font-semibold text-emerald-400">
                    {registryBalanceRevealed !== null ? `${formatTokenAmount(registryBalanceRevealed)} PayUSD` : 'Hidden'}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {registryBalanceRevealed !== null
                      ? 'This is your current confidential wallet balance.'
                      : 'Click Reveal Private Balance to confirm how much PayUSD is now in your private wallet.'}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Linked private account</div>
                  <div className="mt-2 break-all font-mono text-sm text-gray-200">
                    {registryLinked && userTokenRegistry
                      ? userTokenRegistry.incoTokenAccount.toBase58()
                      : destinationTokenAccount || 'Not linked yet'}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    This is where One-Click Withdraw deposits PayUSD before any public unwrap.
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">Latest withdrawal</div>
                  <div className="mt-2 text-sm text-gray-200">
                    {latestPayout ? `Nonce ${latestPayout.nonce}` : 'No payout recorded yet'}
                  </div>
                  {latestPayout ? (
                    <div className="mt-2">
                      <div className="text-lg font-semibold text-emerald-400">
                        {latestPayoutAmountRevealed !== null
                          ? `${formatTokenAmount(latestPayoutAmountRevealed)} PayUSD`
                          : settledWithdrawalAmount !== null
                            ? `${formatTokenAmount(settledWithdrawalAmount)} PayUSD`
                            : 'Amount hidden'}
                      </div>
                      {settledWithdrawalAmount !== null && latestPayoutAmountRevealed === null ? (
                        <div className="mt-1 text-[11px] text-cyan-300">
                          Settled using the Step 3 reveal and the final base-layer commit timestamp.
                        </div>
                      ) : null}
                      <button
                        onClick={() => void revealLatestPayoutAmount()}
                        disabled={latestPayoutAmountLoading}
                        className="mt-2 text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300 transition hover:text-cyan-200 disabled:opacity-50"
                      >
                        {latestPayoutAmountLoading ? 'Revealing amount...' : 'Reveal latest withdrawal amount'}
                      </button>
                    </div>
                  ) : null}
                  <div className="mt-2 text-xs text-gray-400">
                    {latestPayout
                      ? `${latestPayout.claimed ? 'Claimed to your private wallet' : latestPayout.cancelled ? 'Cancelled' : 'Pending'} · ${latestPayout.createdAt ? new Date(latestPayout.createdAt * 1000).toLocaleString() : 'time unavailable'}`
                      : 'After a successful withdraw, your latest payout will show up here.'}
                  </div>
                </div>
              </div>

              {revealed ? (
                <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm text-cyan-100">
                  Pre-withdraw snapshot: {formatTokenAmount(earnedLamportsNow)} PayUSD.
                  If the post-claim private balance is still waiting on covalidator materialization, use this Step 3 reveal or the signed statement as your amount proof for the demo.
                </div>
              ) : null}
            </div>

            <AdvancedDetails title="Manual withdrawal controls">
              <div className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="panel-card">
                    <h2 className="text-lg font-semibold text-[#2D2D2A]">Withdraw request</h2>
                    <p className="mt-1 text-sm text-gray-600">
                      Request payout from your loaded payroll record. If the stream is active on MagicBlock, Expensee commits it back first.
                    </p>
                    <div className="mt-4 space-y-3">
                      <div className="grid gap-2 text-xs text-gray-600">
                        <div>Record: {employee ? 'loaded' : 'missing'}</div>
                        <div>Streaming: {employee?.isDelegated ? 'MagicBlock (real-time)' : 'Base layer (paused)'}</div>
                        <div>
                          Withdraw request:{' '}
                          {withdrawRequestLoading ? 'checking...' : withdrawRequestExists ? 'pending' : 'none'}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            if (!canonicalBusinessPda) {
                              setError('Load your employee record first.');
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
                              return requestWithdrawV4(connection, wallet, canonicalBusinessPda, employeeIndex, true);
                            });
                            await refreshWithdrawRequest();
                            await refreshPayout();
                            await refreshPayouts();
                          }}
                          disabled={busy || !canonicalBusinessPda || employeeIndex === null}
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Request Withdraw
                        </button>
                        <button
                          onClick={() => {
                            void refreshWithdrawRequest();
                            void refreshPayout();
                            void refreshPayouts();
                          }}
                          disabled={busy || !businessPda || employeeIndex === null}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Refresh Status
                        </button>
                      </div>
                    </div>
                  </div>

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
                  </div>
                </div>

                <div className="panel-card">
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
                    <h2 className="text-lg font-semibold text-[#2D2D2A]">Withdrawal destination</h2>
                    <p className="mt-1 text-sm text-gray-600">Link your destination token account before claiming.</p>
                    <div className="mt-4 space-y-3">
                      {wallet.publicKey ? (
                        <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-gray-300">
                          <div className="grid gap-3">
                            <div className="flex flex-col gap-1 border-b border-white/10 pb-3 sm:flex-row sm:items-start sm:justify-between">
                              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                                Registry status
                              </span>
                              <span className="max-w-full break-all font-mono text-xs text-gray-200 sm:text-right">
                                {registryLinked
                                  ? userTokenRegistry!.incoTokenAccount.toBase58()
                                  : 'Not linked yet'}
                              </span>
                            </div>

                            <div className="flex flex-col gap-2 border-b border-white/10 pb-3 sm:flex-row sm:items-center sm:justify-between">
                              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                                Private balance
                              </span>
                              <div className="flex flex-wrap items-center gap-3">
                                <span className="font-semibold text-emerald-400">
                                  {registryBalanceRevealed !== null ? formatTokenAmount(registryBalanceRevealed) : '—'} PayUSD
                                </span>
                                <button
                                  onClick={() => void revealRegistryBalance()}
                                  disabled={registryBalanceLoading || !registryLinked}
                                  className="text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300 transition hover:text-cyan-200 disabled:opacity-50"
                                >
                                  {registryBalanceLoading ? 'Loading' : 'Reveal'}
                                </button>
                                {registryBalanceRevealed !== null && (
                                  <button
                                    onClick={() => {
                                      const params = new URLSearchParams();
                                      params.set('confidentialTokenAccount', userTokenRegistry!.incoTokenAccount.toBase58());
                                      params.set('amountUi', formatTokenAmount(registryBalanceRevealed));
                                      router.push(`/bridge?${params.toString()}`);
                                    }}
                                    className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-300 transition hover:text-emerald-200"
                                  >
                                    Unwrap
                                  </button>
                                )}
                              </div>
                            </div>

                            <div>
                              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                                Registry actions
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
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
                                  Link Destination
                                </button>
                                <button
                                  onClick={() => void refreshUserTokenRegistry()}
                                  disabled={busy || userTokenRegistryLoading}
                                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                                >
                                  Refresh
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500">Connect a wallet to manage registry links.</div>
                      )}
                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500">
                          Destination token account
                        </label>
                        <input
                          value={destinationTokenAccount}
                          onChange={(e) => setDestinationTokenAccount(e.target.value)}
                          placeholder="Paste or create a destination token account"
                          className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm font-mono text-gray-100"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
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
                        {destinationTokenAccount ? (
                          <div className="flex items-center text-xs text-gray-500">
                            Ready to use this account for payout claims.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="panel-card">
                    <h2 className="text-lg font-semibold text-[#2D2D2A]">Claim payout</h2>
                    <p className="mt-1 text-sm text-gray-600">Complete the payout after a withdrawal request has been buffered.</p>
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
                            if (!canonicalBusinessPda) {
                              setError('Load your employee record first.');
                              return;
                            }
                            if (employeeIndex === null || nonce === null) {
                              setError('Employee index and nonce required.');
                              return;
                            }
                            await runAction('Execute withdrawal', async () => {
                              const destinationToken = mustPubkey('destination token account', destinationTokenAccount);
                              const master = await import('../lib/payroll-client').then(m => m.getMasterVaultV4Account(connection));
                              if (!master) throw new Error("Master vault not found");

                              const { executeFullWithdrawalV4 } = await import('../lib/payroll-client');

                              return executeFullWithdrawalV4(
                                connection,
                                wallet,
                                canonicalBusinessPda,
                                employeeIndex,
                                nonce,
                                master.vaultTokenAccount,
                                destinationToken
                              );
                            });
                            await refreshPayout();
                            await refreshPayouts();
                            await refreshEmployee();
                          }}
                          disabled={
                            busy ||
                            !canonicalBusinessPda ||
                            employeeIndex === null ||
                            nonce === null ||
                            !destinationTokenAccount ||
                            (employee?.isDelegated !== false)
                          }
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Claim Payout
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
              </div>
            </AdvancedDetails>
          </StepCard>
        ) : null}

        {showStep4 ? (
          <StepCard
            number={3}
            title="Live earnings"
            description="Review your confidential live earnings before requesting a withdrawal."
            state={stepEarningsState}
          >
            {employee ? (
              <div className="mb-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-4 text-sm text-cyan-100">
                MagicBlock keeps this stream updating in real time. Review your current earnings here before you move to Step 4 and withdraw.
              </div>
            ) : (
              <div className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                Find your payroll record first in Step 2 before reviewing live earnings.
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="panel-card">
                <h2 className="text-lg font-semibold text-[#2D2D2A]">Live earnings</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Reveal your encrypted salary rate and funded budget to see real-time earnings capped by the employer&apos;s funded balance.
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
                      Live estimate · updates every second from the last on-chain snapshot, but never above the remaining funded budget.
                    </div>
                    {liveEarningsNote ? (
                      <div className="mt-2 text-[11px] text-amber-500">
                        {liveEarningsNote}
                      </div>
                    ) : null}
                    {revealed && !liveEarningsNote && revealed.salaryLamportsPerSec === 0n ? (
                      <div className="mt-2 text-[11px] text-amber-500">
                        Salary rate is 0 — stream is paused or unfunded. Live estimate will not
                        increase until the employer tops up and updates your rate.
                      </div>
                    ) : null}
                    {revealed &&
                    !liveEarningsNote &&
                    revealed.salaryLamportsPerSec > 0n &&
                    revealed.remainingBudgetCheckpoint === 0n ? (
                      <div className="mt-2 text-[11px] text-amber-500">
                        The stream is active, but the remaining funded budget is 0. The employer needs to top up the pooled vault and update your salary to resume growth.
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
                        Remaining funded budget:{' '}
                        {revealed ? formatTokenAmount(revealed.remainingBudgetCheckpoint) : '—'}
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
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={handleDownloadPayslip}
                        className="premium-btn premium-btn-primary"
                      >
                        Download JSON
                      </button>
                      <button
                        onClick={() => void handleCopyPayslip()}
                        className="premium-btn premium-btn-secondary"
                      >
                        Copy JSON
                      </button>
                    </div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-[#0B1320] p-4 text-xs text-[#E6EDF3]">
                      {payslipJson}
                    </pre>
                  </div>
                ) : null}
                <div className="mt-3 text-xs text-gray-500">
                  Defaults to your last settled checkpoint through now. Uses the current encrypted salary rate when
                  full v4 rate history is unavailable in the UI.
                </div>
              </div>
            </div>
          </StepCard>
        ) : null}
      </div>
    </ExpenseeShell>
  );
}
