import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, Connection } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentChat from '../components/AgentChat';
import ExpenseeShell from '../components/ExpenseeShell';
import AdvancedDetails from '../components/AdvancedDetails';
import StepCard from '../components/StepCard';
import StatusPill from '../components/StatusPill';
import { usePayrollHistory } from '../hooks/usePayrollHistory';
import {
  PAYUSD_MINT,
  MAGICBLOCK_DELEGATION_PROGRAM,
  MAGICBLOCK_TEE_VALIDATOR_IDENTITY,
  addEmployeeV4,
  checkAllowanceStale,
  commitAndUndelegateStreamV4,
  createIncoTokenAccount,
  delegateStreamV4,
  scheduleCrankV4,
  depositV4,
  getDeterministicTaskId,
  getMagicblockValidatorForRegion,
  getMagicblockEndpointForRegion,
  getMagicblockPreferredRegion,
  getBusinessStreamConfigV4Account,
  getBusinessV4AccountByAddress,
  getBusinessV4PDA,
  getEmployeeV4Account,
  getEmployeeV4PDA,
  getMasterVaultV4Account,
  getMasterVaultV4PDA,
  getReturnDataU128,
  getRateHistoryV4Account,
  getStreamConfigV4PDA,
  getTaskContextPDA,
  getUserTokenAccountV4,
  grantIncoDecryptAccessForHandle,
  ensureTeeAuthToken,
  extractHandleFromCiphertext32,
  initRateHistoryV4,
  isMagicblockValidatorRegionAvailable,
  isMagicblockTeeModeEnabled,
  isStoredTeeTokenValid,
  initUserTokenAccountV4,
  initMasterVaultV4,
  initStreamConfigV4,
  linkUserTokenAccountV4,
  MagicblockValidatorRegion,
  registerBusinessV4,
  redelegateStreamV4,
  setMagicblockTeeModeEnabled,
  setPoolVaultV4,
  updateSalaryRateV4,
} from '../lib/payroll-client';


type TxResult = { label: string; sig: string } | null;

type StepState = 'done' | 'active' | 'locked' | 'optional';

type PayPreset = 'per_second' | 'hourly' | 'weekly' | 'biweekly' | 'monthly' | 'fixed_total';
type AgentPlanDraft = {
  source: 'heuristic' | 'llm' | 'toolkit';
  intent: string;
  summary: string;
  confidence: number;
  missing: string[];
  employeeWallet?: string;
  payPreset?: PayPreset;
  payAmount?: string;
  fixedTotalDays?: string;
  salaryPerSecond?: string;
  boundPresetPeriod?: boolean;
  streamIndex?: number;
  depositAmount?: string;
};
type AgentExecutionStatus = 'pending' | 'running' | 'done' | 'failed';
type AgentExecutionRisk = 'safe' | 'review' | 'high_risk';
type AgentApprovalMode = 'high_risk_only' | 'every_tx';
type AgentExecutionStep = {
  key: string;
  label: string;
  status: AgentExecutionStatus;
  required: boolean;
  risk: AgentExecutionRisk;
  requiresSignature: boolean;
  detail?: string;
  txid?: string;
};

const EMPTY_PUBKEY = '11111111111111111111111111111111';

function parseIndex(value: string): number | null {
  if (!value || value.trim().length === 0) return null;
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

function parseUiAmount(label: string, value: string): bigint {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label} amount`);
  return BigInt(Math.floor(n * 1_000_000_000));
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

function extractIncoTokenHandle(data: Buffer): bigint {
  const bytes = data.slice(72, 88);
  let result = 0n;
  for (let i = 15; i >= 0; i -= 1) {
    result = result * 256n + BigInt(bytes[i]);
  }
  return result;
}



function formatAddress(value: string, chars = 4): string {
  if (!value) return '—';
  if (value.length <= chars * 2) return value;
  return `${value.slice(0, chars)}…${value.slice(-chars)}`;
}

function presetToPerSecond(preset: PayPreset, amount: number, days?: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (preset === 'per_second') return amount;
  if (preset === 'hourly') return amount / 3600;
  if (preset === 'weekly') return amount / (7 * 24 * 3600);
  if (preset === 'biweekly') return amount / (14 * 24 * 3600);
  if (preset === 'monthly') return amount / (30 * 24 * 3600);
  if (preset === 'fixed_total') {
    const totalDays = days && Number.isFinite(days) && days > 0 ? days : 1;
    return amount / (totalDays * 24 * 3600);
  }
  return null;
}

function toDateTimeLocal(seconds: string): string {
  const ts = Number(seconds);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function fromDateTimeLocal(value: string): string {
  if (!value) return '0';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '0';
  return String(Math.floor(ts / 1000));
}

const CRANK_REGION_STORAGE_KEY = 'expensee.crank_region_v1';

function normalizeMagicblockRegion(value: string | null): MagicblockValidatorRegion | null {
  if (value === 'eu' || value === 'us' || value === 'asia') return value;
  return null;
}

type EmployerV4Mode =
  | 'dashboard'
  | 'setup'
  | 'agent'
  | 'employees'
  | 'reports'
  | 'vault'
  | 'history'
  | 'payments'
  | 'all';

type EmployerV4ScreenProps = {
  mode?: EmployerV4Mode;
};

export default function EmployerV4Page({ mode = 'all' }: EmployerV4ScreenProps) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastTx, setLastTx] = useState<TxResult>(null);
  const [teeModeEnabled, setTeeModeEnabled] = useState(false);
  const [teeStatus, setTeeStatus] = useState<'missing' | 'ready'>('missing');

  const [businessIndexInput, setBusinessIndexInput] = useState('');
  const [employeeIndexInput, setEmployeeIndexInput] = useState('');
  const [settleIntervalSecs, setSettleIntervalSecs] = useState('10');
  const [employeeWallet, setEmployeeWallet] = useState('');
  const [salaryPerSecond, setSalaryPerSecond] = useState('0.0001');
  const [payPreset, setPayPreset] = useState<PayPreset>('per_second');
  const [payAmount, setPayAmount] = useState('0.0001');
  const [periodStart, setPeriodStart] = useState('0');
  const [periodEnd, setPeriodEnd] = useState('0');
  const [poolVaultTokenAccount, setPoolVaultTokenAccount] = useState('');
  const [depositorTokenAccount, setDepositorTokenAccount] = useState('');
  const [depositAmount, setDepositAmount] = useState('10');
  const [depositHandle, setDepositHandle] = useState<bigint | null>(null);
  const [depositBalance, setDepositBalance] = useState<bigint | null>(null);
  const [depositBalanceLoading, setDepositBalanceLoading] = useState(false);
  const [depositBalanceDecrypting, setDepositBalanceDecrypting] = useState(false);
  const [depositBalanceError, setDepositBalanceError] = useState('');
  const [vaultHandle, setVaultHandle] = useState<bigint | null>(null);
  const [vaultBalance, setVaultBalance] = useState<bigint | null>(null);
  const [vaultBalanceLoading, setVaultBalanceLoading] = useState(false);
  const [vaultBalanceDecrypting, setVaultBalanceDecrypting] = useState(false);
  const [vaultBalanceError, setVaultBalanceError] = useState('');
  const [autoConfigAttempted, setAutoConfigAttempted] = useState(false);
  const [autoConfigBusy, setAutoConfigBusy] = useState(false);
  const [autoConfigError, setAutoConfigError] = useState('');
  const [showBalancePanel, setShowBalancePanel] = useState(false);
  const [mintAmount, setMintAmount] = useState('100');
  const [lastMintAmount, setLastMintAmount] = useState<number | null>(null);
  const [lastMintTx, setLastMintTx] = useState<string | null>(null);
  const [wrapAmount, setWrapAmount] = useState('10');
  const [lastWrapTx, setLastWrapTx] = useState<string | null>(null);
  const [publicUsdcBalance, setPublicUsdcBalance] = useState<string | null>(null);
  const [publicUsdcBalanceLoading, setPublicUsdcBalanceLoading] = useState(false);
  const [publicUsdcBalanceError, setPublicUsdcBalanceError] = useState('');
  const [usdcMode, setUsdcMode] = useState<'real' | 'demo'>('real');
  const [userTokenRegistry, setUserTokenRegistry] = useState<Awaited<ReturnType<typeof getUserTokenAccountV4>>>(null);
  const [userTokenRegistryLoading, setUserTokenRegistryLoading] = useState(false);

  const [delegateRegion, setDelegateRegion] = useState<MagicblockValidatorRegion>(() => {
    if (typeof window !== 'undefined') {
      const stored = normalizeMagicblockRegion(window.localStorage.getItem(CRANK_REGION_STORAGE_KEY));
      if (stored && isMagicblockValidatorRegionAvailable(stored)) return stored;
    }
    return getMagicblockPreferredRegion();
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(CRANK_REGION_STORAGE_KEY, delegateRegion);
  }, [delegateRegion]);

  const [isDelegated, setIsDelegated] = useState<boolean | null>(null);
  const [crankScheduleInfo, setCrankScheduleInfo] = useState<{
    taskId: number;
    scheduledAt: string;
    region: MagicblockValidatorRegion;
    payer: string;
  } | null>(null);
  const [crankScheduleStatus, setCrankScheduleStatus] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [lastCrankTx, setLastCrankTx] = useState<string | null>(null);
  const [delegationStatusMsg, setDelegationStatusMsg] = useState('');
  const [lastDelegateTx, setLastDelegateTx] = useState<string | null>(null);
  const [lastUndelegateTx, setLastUndelegateTx] = useState<string | null>(null);
  const [lastRedelegateTx, setLastRedelegateTx] = useState<string | null>(null);

  const [masterVault, setMasterVault] = useState<Awaited<ReturnType<typeof getMasterVaultV4Account>>>(null);
  const [business, setBusiness] = useState<Awaited<ReturnType<typeof getBusinessV4AccountByAddress>>>(null);
  const [streamConfig, setStreamConfig] = useState<Awaited<ReturnType<typeof getBusinessStreamConfigV4Account>>>(null);
  const [employee, setEmployee] = useState<Awaited<ReturnType<typeof getEmployeeV4Account>>>(null);
  const [devnetState, setDevnetState] = useState<any | null>(null);
  const [vaultFundingObserved, setVaultFundingObserved] = useState(false);

  const [agentMessages, setAgentMessages] = useState<any[]>([]);
  const [agentPhase, setAgentPhase] = useState<string>('greeting');
  const [agentQueue, setAgentQueue] = useState<AgentExecutionStep[]>([]);
  const [agentExecuteBusy, setAgentExecuteBusy] = useState(false);
  const [agentEnableHighSpeed, setAgentEnableHighSpeed] = useState(true);
  const [agentApprovalMode, setAgentApprovalMode] = useState<AgentApprovalMode>('high_risk_only');
  const [agentRunHydrated, setAgentRunHydrated] = useState(false);
  const [boundPresetPeriod, setBoundPresetPeriod] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const runIdRef = useRef(0);
  const businessIndexPrefilledRef = useRef(false);
  const employeeIndexPrefilledRef = useRef(false);
  const businessIndex = useMemo(() => parseIndex(businessIndexInput), [businessIndexInput]);
  const employeeIndex = useMemo(() => parseIndex(employeeIndexInput), [employeeIndexInput]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('expensee.usdcMode');
    if (stored === 'real' || stored === 'demo') {
      setUsdcMode(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!businessIndexInput && !businessIndexPrefilledRef.current) {
      const stored = window.localStorage.getItem('expensee.businessIndex');
      if (stored) {
        setBusinessIndexInput(stored);
        businessIndexPrefilledRef.current = true;
      }
    }
  }, [businessIndexInput]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (businessIndexInput) {
      window.localStorage.setItem('expensee.businessIndex', businessIndexInput);
    }
  }, [businessIndexInput]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!employeeIndexInput && !employeeIndexPrefilledRef.current) {
      const stored = window.localStorage.getItem('expensee.employeeIndex');
      if (stored) {
        setEmployeeIndexInput(stored);
        employeeIndexPrefilledRef.current = true;
      }
    }
  }, [employeeIndexInput]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (employeeIndexInput) {
      window.localStorage.setItem('expensee.employeeIndex', employeeIndexInput);
    }
  }, [employeeIndexInput]);

  const waitForErAccount = useCallback(
    async (erConnection: Connection, pubkey: PublicKey, attempts = 12, delayMs = 2000) => {
      for (let i = 0; i < attempts; i += 1) {
        const info = await erConnection.getAccountInfo(pubkey, 'confirmed').catch(() => null);
        if (info) return true;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return false;
    },
    []
  );

  const scheduleCrankOnEr = useCallback(
    async (region: MagicblockValidatorRegion, targetBusinessIndex: number, targetEmployeeIndex: number) => {
      if (!wallet.publicKey) throw new Error('Wallet not connected');
      const taskId = await getDeterministicTaskId(wallet.publicKey, targetBusinessIndex, targetEmployeeIndex);
      const [masterVaultPda] = getMasterVaultV4PDA();
      const [businessPda] = getBusinessV4PDA(masterVaultPda, targetBusinessIndex);
      const [employeePda] = getEmployeeV4PDA(businessPda, targetEmployeeIndex);
      const availableRegions: MagicblockValidatorRegion[] = ['eu'];
      if (isMagicblockValidatorRegionAvailable('us')) availableRegions.push('us');
      if (isMagicblockValidatorRegionAvailable('asia')) availableRegions.push('asia');
      const orderedRegions = [region, ...availableRegions.filter((entry) => entry !== region)];

      let lastError: unknown = null;
      for (const entry of orderedRegions) {
        try {
          const erUrl = getMagicblockEndpointForRegion(entry);
          const erConnection = new Connection(erUrl, 'confirmed');
          const visible = await waitForErAccount(erConnection, employeePda);
          if (!visible) {
            throw new Error('ER has not received the delegated account yet. Please retry in a few seconds.');
          }
          const crankTx = await scheduleCrankV4(
            erConnection,
            wallet,
            targetBusinessIndex,
            targetEmployeeIndex,
            taskId
          );
          setLastCrankTx(crankTx);
          setCrankScheduleInfo({
            taskId,
            scheduledAt: new Date().toLocaleString(),
            region: entry,
            payer: wallet.publicKey.toBase58(),
          });
          setCrankScheduleStatus('yes');
          if (entry !== delegateRegion) {
            setDelegateRegion(entry);
          }
          return crankTx;
        } catch (err: any) {
          lastError = err;
          const message = String(err?.message || err || '');
          const retryable =
            message.includes('InvalidWritableAccount') ||
            message.includes('Blockhash not found') ||
            message.includes('Unsupported program id');
          if (!retryable) {
            break;
          }
        }
      }
      throw lastError;
    },
    [wallet, wallet.publicKey, waitForErAccount, delegateRegion]
  );

  // Deterministic crank check — no localStorage needed.
  // Derives the taskId from wallet + businessIndex + employeeIndex, then queries the ER RPC.
  const checkCrankScheduled = useCallback(
    async () => {
      if (!wallet.publicKey || businessIndex === null || employeeIndex === null) {
        setCrankScheduleStatus('unknown');
        return;
      }
      setCrankScheduleStatus('unknown');
      try {
        const taskId = await getDeterministicTaskId(wallet.publicKey, businessIndex, employeeIndex);
        const [taskContextPda] = getTaskContextPDA(wallet.publicKey, taskId);
        const regions: MagicblockValidatorRegion[] = ['eu'];
        if (isMagicblockValidatorRegionAvailable('us')) regions.push('us');
        if (isMagicblockValidatorRegionAvailable('asia')) regions.push('asia');
        const orderedRegions = [delegateRegion, ...regions.filter((region) => region !== delegateRegion)];
        for (const region of orderedRegions) {
          const erUrl = getMagicblockEndpointForRegion(region);
          const erConnection = new Connection(erUrl);
          const acct = await erConnection.getAccountInfo(taskContextPda, 'confirmed').catch(() => null);
          if (acct) {
            setCrankScheduleStatus('yes');
            return;
          }
        }
        setCrankScheduleStatus('no');
      } catch {
        setCrankScheduleStatus('unknown');
      }
    },
    [wallet.publicKey, businessIndex, employeeIndex, delegateRegion]
  );

  // Re-check crank status whenever the employee/business changes or delegation state changes.
  useEffect(() => {
    if (isDelegated) {
      void checkCrankScheduled();
    } else if (isDelegated === false) {
      setCrankScheduleInfo(null);
      setCrankScheduleStatus('no');
    }
  }, [isDelegated, checkCrankScheduled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('expensee.usdcMode', usdcMode);
  }, [usdcMode]);

  const payrollHistory = usePayrollHistory(20);
  const prevWalletRef = useRef<string | null>(null);
  const [rateHistoryExists, setRateHistoryExists] = useState(false);
  const [rateHistoryLoading, setRateHistoryLoading] = useState(false);
  const [salaryUpdateInput, setSalaryUpdateInput] = useState('');
  const [solvencyStatus, setSolvencyStatus] = useState<'unknown' | 'solvent' | 'insolvent'>('unknown');
  const [solvencyMessage, setSolvencyMessage] = useState('');
  const [solvencyChecking, setSolvencyChecking] = useState(false);

  const [masterVaultPda] = useMemo(() => getMasterVaultV4PDA(), []);
  const businessPda = useMemo(() => {
    if (businessIndex === null) return null;
    return getBusinessV4PDA(masterVaultPda, businessIndex)[0];
  }, [businessIndex, masterVaultPda]);
  const employeePda = useMemo(() => {
    if (!businessPda || employeeIndex === null) return null;
    return getEmployeeV4PDA(businessPda, employeeIndex)[0];
  }, [businessPda, employeeIndex]);
  const streamConfigPda = useMemo(() => {
    if (!businessPda) return null;
    return getStreamConfigV4PDA(businessPda)[0];
  }, [businessPda]);

  const businessExists = !!business;
  const vaultExists = Boolean(
    masterVault && masterVault.vaultTokenAccount.toBase58() !== EMPTY_PUBKEY
  );
  const configExists = !!streamConfig;
  const payPresetLabel: Record<PayPreset, string> = {
    per_second: 'Per second',
    hourly: 'Per hour',
    weekly: 'Per week',
    biweekly: 'Per 2 weeks',
    monthly: 'Per month',
    fixed_total: 'Fixed total',
  };
  const payAmountLabel: Record<PayPreset, string> = {
    per_second: 'Pay rate (USDC per second)',
    hourly: 'Pay rate (USDC per hour)',
    weekly: 'Pay rate (USDC per week)',
    biweekly: 'Pay rate (USDC per 2 weeks)',
    monthly: 'Pay rate (USDC per month)',
    fixed_total: 'Total pay (USDC)',
  };
  const resolvedPerSecond = useMemo(() => {
    const amount = Number(payAmount);
    const perSecond = presetToPerSecond(payPreset, amount);
    return perSecond ? perSecond.toString() : '';
  }, [payAmount, payPreset]);
  const resolvedPerSecondDisplay = useMemo(() => {
    const amount = Number(payAmount);
    const perSecond = presetToPerSecond(payPreset, amount);
    return perSecond ? perSecond.toFixed(8) : '';
  }, [payAmount, payPreset]);
  const periodStartLocal = useMemo(() => toDateTimeLocal(periodStart), [periodStart]);
  const periodEndLocal = useMemo(() => toDateTimeLocal(periodEnd), [periodEnd]);
  const streamIndex = employeeIndex;
  const preferredRegion = useMemo(() => getMagicblockPreferredRegion(), []);
  const selectedValidator = useMemo(
    () => getMagicblockValidatorForRegion(delegateRegion),
    [delegateRegion]
  );
  const isTeeValidator = useMemo(
    () => selectedValidator.equals(MAGICBLOCK_TEE_VALIDATOR_IDENTITY),
    [selectedValidator]
  );
  const usValidatorAvailable = isMagicblockValidatorRegionAvailable('us');
  const asiaValidatorAvailable = isMagicblockValidatorRegionAvailable('asia');
  const executionTone = isDelegated === null ? 'neutral' : isDelegated ? 'success' : 'warning';
  const executionLabel = isDelegated === null ? 'UNKNOWN' : isDelegated ? 'FAST' : 'BASE';

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
        const fallback = `Failed to ${label.toLowerCase()}`;
        const primary =
          e?.message ||
          (typeof e === 'string' ? e : null) ||
          null;
        const extra =
          e?.cause?.message ||
          e?.error?.message ||
          e?.data?.message ||
          null;
        const serialized = (() => {
          try {
            return JSON.stringify(e, Object.getOwnPropertyNames(e));
          } catch {
            return null;
          }
        })();
        const detail =
          (primary && extra && primary !== extra ? `${primary} (${extra})` : primary) ||
          serialized ||
          fallback;
        setError(detail);
        return null;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const handleExportHistory = useCallback(() => {
    if (!payrollHistory.rows.length) return;
    const escapeCsv = (value: string | number | null) => {
      const text = value === null ? 'Encrypted' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = [
      'Type',
      'Direction',
      'Amount',
      'Currency',
      'Date',
      'Time',
      'Privacy',
      'Status',
      'Signature',
    ];
    const lines = payrollHistory.rows.map((row) => [
      row.type,
      row.direction,
      row.amount === null ? 'Encrypted' : row.amount.toFixed(2),
      row.currency,
      row.date,
      row.time,
      row.privacy,
      row.status,
      row.signature,
    ]);
    const csv = [header, ...lines].map((line) => line.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'expensee-payroll-history.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [payrollHistory.rows]);

  const refreshTeeStatus = useCallback(() => {
    if (!wallet.publicKey) {
      setTeeStatus('missing');
      return;
    }
    setTeeStatus(isStoredTeeTokenValid(wallet.publicKey) ? 'ready' : 'missing');
  }, [wallet.publicKey]);

  useEffect(() => {
    setTeeModeEnabled(isMagicblockTeeModeEnabled());
  }, []);

  useEffect(() => {
    refreshTeeStatus();
  }, [refreshTeeStatus, teeModeEnabled]);

  const loadState = useCallback(async (silent = false) => {
    if (!wallet.connected) return;
    if (!silent) {
      setBusy(true);
      setMessage('');
      setError('');
    }
    try {
      const master = await getMasterVaultV4Account(connection);
      setMasterVault(master);
      if (master?.vaultTokenAccount && master.vaultTokenAccount.toBase58() !== EMPTY_PUBKEY) {
        setPoolVaultTokenAccount((prev) => prev || master.vaultTokenAccount.toBase58());
      }

      if (businessPda) {
        const businessAccount = await getBusinessV4AccountByAddress(connection, businessPda);
        setBusiness(businessAccount);
      } else {
        setBusiness(null);
      }

      if (streamConfigPda) {
        const configAccount = await getBusinessStreamConfigV4Account(connection, businessPda!);
        setStreamConfig(configAccount);
      } else {
        setStreamConfig(null);
      }

      if (businessPda && employeeIndex !== null) {
        const employeeAccount = await getEmployeeV4Account(connection, businessPda, employeeIndex);
        setEmployee(employeeAccount);
      } else {
        setEmployee(null);
      }

      if (employeePda) {
        const info = await connection.getAccountInfo(employeePda, 'confirmed');
        if (info) {
          setIsDelegated(info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM));
        } else {
          setIsDelegated(null);
        }
      } else {
        setIsDelegated(null);
      }

      if (wallet.publicKey) {
        const registry = await getUserTokenAccountV4(connection, wallet.publicKey, PAYUSD_MINT);
        setUserTokenRegistry(registry);
        if (
          registry &&
          !registry.incoTokenAccount.equals(PublicKey.default) &&
          !depositorTokenAccount
        ) {
          setDepositorTokenAccount(registry.incoTokenAccount.toBase58());
        }
      } else {
        setUserTokenRegistry(null);
      }
    } catch (e: any) {
      if (!silent) {
        setError(e?.message || 'Failed to refresh state');
      } else {
        console.warn(e);
      }
    } finally {
      if (!silent) {
        setBusy(false);
      }
    }
  }, [businessPda, connection, depositorTokenAccount, employeeIndex, employeePda, streamConfigPda, wallet.connected, wallet.publicKey]);

  const resolveSolvencyFromTx = useCallback(
    async (txid: string): Promise<boolean | null> => {
      if (!wallet.publicKey || !wallet.signMessage) return null;
      setSolvencyChecking(true);
      try {
        const handle = await getReturnDataU128(connection, txid);
        if (!handle || handle === 0n) return null;
        const stale = await checkAllowanceStale(connection, handle, wallet.publicKey);
        if (stale) {
          await grantIncoDecryptAccessForHandle(connection, wallet, handle);
        }
        const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
        const result = await decrypt([handle.toString()], {
          address: wallet.publicKey,
          signMessage: wallet.signMessage,
        });
        const value = BigInt(result?.plaintexts?.[0] || '0');
        return value !== 0n;
      } catch {
        return null;
      } finally {
        setSolvencyChecking(false);
      }
    },
    [connection, wallet, wallet.publicKey, wallet.signMessage]
  );

  const buildAgentExecutionQueue = useCallback((): AgentExecutionStep[] => {
    const steps: AgentExecutionStep[] = [];

    steps.push({
      key: 'refresh-state',
      label: 'Refresh current company status',
      status: 'pending',
      required: true,
      risk: 'safe',
      requiresSignature: false,
    });

    steps.push({
      key: 'init-master-vault',
      label: 'Initialize pooled master vault',
      status: masterVault ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    if (!vaultExists && !poolVaultTokenAccount) {
      steps.push({
        key: 'create-pool-vault-token',
        label: 'Create pooled vault token account',
        status: poolVaultTokenAccount ? 'done' : 'pending',
        required: true,
        risk: 'review',
        requiresSignature: true,
      });
    }

    steps.push({
      key: 'set-pool-vault',
      label: 'Set pooled vault token account',
      status: vaultExists ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    steps.push({
      key: 'register-business',
      label: 'Register business (pooled vault)',
      status: businessExists ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    if (!streamConfig) {
      steps.push({
        key: 'init-stream-config',
        label: 'Initialize stream config (auto cooldown)',
        status: 'pending',
        required: true,
        risk: 'high_risk',
        requiresSignature: true,
      });
    }

    steps.push({
      key: 'create-worker-record',
      label: 'Create encrypted employee record',
      status: employee ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    steps.push({
      key: 'enable-high-speed',
      label: 'Enable high-speed mode (MagicBlock delegation, required)',
      status: isDelegated ? 'done' : 'pending',
      required: true,
      risk: 'review',
      requiresSignature: true,
    });

    steps.push({
      key: 'create-depositor-token',
      label: 'Create depositor token account',
      status: depositorTokenAccount ? 'done' : 'pending',
      required: true,
      risk: 'review',
      requiresSignature: true,
    });

    steps.push({
      key: 'deposit-funds',
      label: 'Deposit funds into pooled vault',
      status: vaultFundingObserved ? 'done' : 'pending',
      required: false,
      risk: 'review',
      requiresSignature: true,
    });

    return steps;
  }, [
    agentEnableHighSpeed,
    businessExists,
    depositorTokenAccount,
    employee,
    isDelegated,
    masterVault,
    poolVaultTokenAccount,
    streamConfig,
    vaultExists,
    vaultFundingObserved,
  ]);

  const executeAgentQueue = useCallback(
    async (mode: 'all' | 'next' = 'all') => {
      if (!wallet.publicKey) {
        setError('Wallet not connected');
        return null;
      }
      const queue = buildAgentExecutionQueue();
      if (!queue.length) {
        setError('No execution steps were generated.');
        return null;
      }

      setAgentQueue(queue);
      setAgentExecuteBusy(true);
      setBusy(true);
      setMessage('');
      setError('');
      const runId = runIdRef.current;
      let overrideBusinessPda: PublicKey | null = businessPda;
      let overrideBusinessIndex: number | null = businessIndex;
      let overrideEmployeeIndex: number | null = employeeIndex;
      let lastSolvency: boolean | null = null;

      const updateStep = (key: string, patch: Partial<AgentExecutionStep>) => {
        setAgentQueue((prev) =>
          prev.map((step) => (step.key === key ? { ...step, ...patch } : step))
        );
      };

      const shouldRequireApproval = (step: AgentExecutionStep): boolean => {
        if (!step.requiresSignature) return false;
        if (agentApprovalMode === 'every_tx') return true;
        return step.risk === 'high_risk';
      };

      try {
        let executedNonRefresh = false;
        for (const step of queue) {
          if (runIdRef.current !== runId) throw new Error('ABORTED');
          if (step.status === 'done') continue;

          if (shouldRequireApproval(step)) {
            const approved = window.confirm(
              `Review required before this step:\n\n${step.label}\nRisk: ${step.risk}\nSignature needed: yes\n\nClick OK to continue or Cancel to pause execution.`
            );
            if (!approved) {
              updateStep(step.key, {
                status: 'pending',
                detail: 'Paused for review by operator',
              });
              throw new Error(`Execution paused for review at step: ${step.label}`);
            }
          }

          updateStep(step.key, { status: 'running' });

          let txid: string | undefined;
          try {
            if (step.key === 'refresh-state') {
              await loadState();
              updateStep(step.key, { status: 'done', detail: 'Status refreshed (no signature needed)' });
              if (mode === 'next' && !executedNonRefresh) {
                // Continue to the next real step in the same run.
                continue;
              }
              if (mode === 'next') return { ...step, status: 'done', detail: 'Status refreshed' };
              continue;
            }

            if (step.key === 'init-master-vault') {
              const res = await initMasterVaultV4(connection, wallet);
              txid = res.txid;
            } else if (step.key === 'create-pool-vault-token') {
              const res = await createIncoTokenAccount(connection, wallet, masterVaultPda);
              txid = (res as any)?.txid;
              const tokenAccount = (res as any)?.tokenAccount;
              if (tokenAccount) setPoolVaultTokenAccount(tokenAccount.toBase58());
            } else if (step.key === 'set-pool-vault') {
              const tokenAccount = mustPubkey(
                'pool vault token account',
                poolVaultTokenAccount || masterVault?.vaultTokenAccount?.toBase58() || ''
              );
              txid = await setPoolVaultV4(connection, wallet, tokenAccount);
            } else if (step.key === 'register-business') {
              const res = await registerBusinessV4(connection, wallet);
              txid = res.txid;
              if (res.businessIndex !== undefined) {
                setBusinessIndexInput(String(res.businessIndex));
                overrideBusinessIndex = res.businessIndex;
              }
              if (res.businessPDA) {
                overrideBusinessPda = res.businessPDA;
                const businessAccount = await getBusinessV4AccountByAddress(connection, res.businessPDA);
                setBusiness(businessAccount);
              }
            } else if (step.key === 'init-stream-config') {
              const targetBusinessPda = overrideBusinessPda || businessPda;
              if (!targetBusinessPda) throw new Error('Business index required.');
              const interval = Number(settleIntervalSecs);
              if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid settle interval');
              txid = await initStreamConfigV4(connection, wallet, targetBusinessPda, interval);
            } else if (step.key === 'create-worker-record') {
              const targetBusinessPda = overrideBusinessPda || businessPda;
              if (!targetBusinessPda) throw new Error('Business index required.');
              if (!employeeWallet.trim()) throw new Error('Employee wallet is required.');
              const salaryLamports = parseUiAmount('salary per second', salaryPerSecond);
              const periodStartValue = Number(periodStart || '0') || 0;
              const periodEndValue = Number(periodEnd || '0') || 0;
              // Calculate required deposit for private solvency check:
              // salary × duration for bounded contracts, 0 for open-ended.
              const duration = periodEndValue > periodStartValue ? BigInt(periodEndValue - periodStartValue) : 0n;
              const requiredDeposit = duration > 0n ? salaryLamports * duration : 0n;
              const res = await addEmployeeV4(
                connection,
                wallet,
                targetBusinessPda,
                mustPubkey('employee wallet', employeeWallet),
                salaryLamports,
                periodStartValue,
                periodEndValue,
                requiredDeposit
              );
              txid = res.txid;
              if (res.employeeIndex !== undefined) {
                setEmployeeIndexInput(String(res.employeeIndex));
                overrideEmployeeIndex = res.employeeIndex;
              }
              setSolvencyStatus('unknown');
              setSolvencyMessage('');
              const solvency = await resolveSolvencyFromTx(res.txid);
              lastSolvency = solvency;
              if (solvency === false) {
                setSolvencyStatus('insolvent');
                setSolvencyMessage(
                  'Insufficient funds — employee created but salary is paused. Deposit funds and update salary rate to activate.'
                );
              } else if (solvency === true) {
                setSolvencyStatus('solvent');
              }
            } else if (step.key === 'enable-high-speed') {
              if (lastSolvency === false || solvencyStatus === 'insolvent') {
                throw new Error('Insufficient funds — stream is paused. Deposit funds and update salary rate to activate.');
              }
              const targetBusinessIndex = overrideBusinessIndex ?? businessIndex;
              const targetEmployeeIndex = overrideEmployeeIndex ?? employeeIndex;
              if (targetBusinessIndex === null || targetEmployeeIndex === null) {
                throw new Error('Business index + employee index are required.');
              }
              const validator = getMagicblockValidatorForRegion(delegateRegion);
              txid = await delegateStreamV4(
                connection,
                wallet,
                targetBusinessIndex,
                targetEmployeeIndex,
                mustPubkey('employee wallet', employeeWallet),
                validator
              ).then(async (sig) => {
                await scheduleCrankOnEr(delegateRegion, targetBusinessIndex, targetEmployeeIndex);
                return sig;
              });
            } else if (step.key === 'create-depositor-token') {
              if (!wallet.publicKey) throw new Error('Wallet not connected.');
              const res = await createIncoTokenAccount(connection, wallet, wallet.publicKey, PAYUSD_MINT);
              txid = (res as any)?.txid;
              const tokenAccount = (res as any)?.tokenAccount;
              if (tokenAccount) setDepositorTokenAccount(tokenAccount.toBase58());
            } else if (step.key === 'deposit-funds') {
              const targetBusinessPda = overrideBusinessPda || businessPda;
              if (!targetBusinessPda) throw new Error('Business index is required.');
              if (!depositorTokenAccount.trim()) {
                throw new Error('Depositor token account is required.');
              }
              const poolToken =
                poolVaultTokenAccount ||
                masterVault?.vaultTokenAccount?.toBase58() ||
                '';
              if (!poolToken) throw new Error('Pool vault token account is required.');
              const amountLamports = parseUiAmount('deposit', depositAmount);
              await depositV4(
                connection,
                wallet,
                targetBusinessPda,
                mustPubkey('depositor token account', depositorTokenAccount),
                mustPubkey('pool vault token account', poolToken),
                amountLamports
              );
              setVaultFundingObserved(true);
            }

            await loadState();

            updateStep(step.key, { status: 'done', txid });
            if (txid) setLastTx({ label: step.label, sig: txid });

            if (mode === 'next') {
              executedNonRefresh = true;
              return { ...step, status: 'done', txid };
            }
          } catch (e: any) {
            if (e?.code === 'TX_CONFIRM_TIMEOUT' && e?.txid) {
              updateStep(step.key, {
                status: 'done',
                txid: e.txid,
                detail: 'Transaction submitted; confirmation pending. Check explorer for final status.',
              });
              setLastTx({ label: step.label, sig: e.txid });
              if (mode === 'next') {
                return { ...step, status: 'done', txid: e.txid, detail: 'Confirmation pending' };
              }
              continue;
            }
            updateStep(step.key, { status: 'failed', detail: e?.message || 'Step failed' });
            throw e;
          }
        }
        return null;
      } catch {
        return null;
      } finally {
        setAgentExecuteBusy(false);
        setBusy(false);
      }
    },
    [
      agentApprovalMode,
      buildAgentExecutionQueue,
      businessIndex,
      businessPda,
      connection,
      delegateRegion,
      depositAmount,
      depositorTokenAccount,
      employeeIndex,
      employeeWallet,
      loadState,
      masterVaultPda,
      masterVault,
      poolVaultTokenAccount,
      periodEnd,
      periodStart,
      salaryPerSecond,
      settleIntervalSecs,
      resolveSolvencyFromTx,
      solvencyStatus,
      wallet,
    ]
  );

  const handleChatDraftPlan = useCallback(
    async (instruction: string, _current: Record<string, unknown>) => {
      try {
        const response = await fetch('/api/agent/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction,
            current: {
              employeeWallet,
              payPreset,
              payAmount,
              salaryPerSecond,
              boundPresetPeriod,
            },
          }),
        });
        const json = (await response.json()) as
          | { ok: true; plan: AgentPlanDraft }
          | { ok: false; error?: string };
        if (!response.ok || !json.ok) return null;
        return json.plan;
      } catch {
        return null;
      }
    },
    [boundPresetPeriod, employeeWallet, payAmount, payPreset, salaryPerSecond]
  );

  const handleChatApplyPlan = useCallback(
    (plan: Record<string, unknown>) => {
      if (plan.employeeWallet && typeof plan.employeeWallet === 'string') {
        if (plan.employeeWallet === 'USE_MY_WALLET' && wallet.publicKey) {
          setEmployeeWallet(wallet.publicKey.toBase58());
        } else if (plan.employeeWallet !== 'USE_MY_WALLET') {
          setEmployeeWallet(plan.employeeWallet);
        }
      }
      if (plan.salaryPerSecond && (typeof plan.salaryPerSecond === 'string' || typeof plan.salaryPerSecond === 'number')) {
        setPayPreset('per_second');
        setPayAmount(String(plan.salaryPerSecond));
      } else if (plan.payPreset && plan.payAmount) {
        const preset = plan.payPreset as PayPreset;
        setPayPreset(preset);
        setPayAmount(String(plan.payAmount));
      }
      if (plan.depositAmount && (typeof plan.depositAmount === 'string' || typeof plan.depositAmount === 'number')) {
        setDepositAmount(String(plan.depositAmount));
      }
      if (plan.streamIndex !== undefined && (typeof plan.streamIndex === 'number' || typeof plan.streamIndex === 'string')) {
        setEmployeeIndexInput(String(plan.streamIndex));
      }
    },
    [wallet.publicKey]
  );

  const handleChatExecute = useCallback(
    async (mode: 'all' | 'next' = 'all') => {
      return await executeAgentQueue(mode);
    },
    [executeAgentQueue]
  );

  const handleCancelBusy = useCallback(() => {
    runIdRef.current += 1;
    setBusy(false);
    setAgentExecuteBusy(false);
    setAgentQueue((prev) =>
      prev.map((s) => (s.status === 'running' ? { ...s, status: 'pending' } : s))
    );
    setError('Operation was manually cancelled by the user.');
  }, []);

  useEffect(() => {
    if (!wallet.connected) {
      setAgentRunHydrated(false);
      setAgentMessages([]);
      setAgentQueue([]);
      return;
    }
    let alive = true;
    setAgentRunHydrated(false);
    void loadState(true).finally(() => {
      if (!alive) return;
      setAgentRunHydrated(true);
    });
    return () => {
      alive = false;
    };
  }, [loadState, wallet.connected]);

  useEffect(() => {
    const nextWallet = wallet.publicKey?.toBase58() || null;
    if (!nextWallet) {
      prevWalletRef.current = null;
      return;
    }
    if (prevWalletRef.current && prevWalletRef.current !== nextWallet) {
      // Wallet changed: clear all context so we don't show stale steps/state.
      setAgentMessages([]);
      setAgentQueue([]);
      setAgentPhase('greeting');
      setEmployeeWallet('');
      setDepositorTokenAccount('');
      setDepositAmount('10');
      setEmployeeIndexInput('');
      setBusinessIndexInput('');
      setBusiness(null);
      setStreamConfig(null);
      setEmployee(null);
      setVaultFundingObserved(false);
      setIsDelegated(null);
      setPoolVaultTokenAccount('');
      setUserTokenRegistry(null);
      setUserTokenRegistryLoading(false);
      setAgentRunHydrated(false);
      void loadState(true);
    }
    prevWalletRef.current = nextWallet;
  }, [loadState, wallet.publicKey]);

  useEffect(() => {
    if (!wallet.connected || agentExecuteBusy || !agentRunHydrated) return;
    const queue = buildAgentExecutionQueue();
    if (agentQueue.length === 0) {
      setAgentQueue(queue);
      return;
    }
    const merged = queue.map((step) => {
      const existing = agentQueue.find((s) => s.key === step.key);
      if (existing && (existing.status === 'done' || existing.status === 'running')) {
        return {
          ...step,
          status: existing.status,
          txid: existing.txid,
          detail: existing.detail,
        };
      }
      return step;
    });
    setAgentQueue(merged);
  }, [agentExecuteBusy, buildAgentExecutionQueue, wallet.connected, agentRunHydrated, agentQueue]);

  const refreshMaster = useCallback(async (silent = false) => {
    if (silent) {
      try {
        const account = await getMasterVaultV4Account(connection);
        setMasterVault(account);
        if (account?.vaultTokenAccount) {
          setPoolVaultTokenAccount((prev) => prev || account.vaultTokenAccount.toBase58());
        }
      } catch (e) {
        console.warn(e);
      }
      return;
    }
    await runAction('Refresh master vault', async () => {
      const account = await getMasterVaultV4Account(connection);
      setMasterVault(account);
      if (account?.vaultTokenAccount) {
        setPoolVaultTokenAccount((prev) => prev || account.vaultTokenAccount.toBase58());
      }
      return account;
    });
  }, [connection, runAction]);

  useEffect(() => {
    if (!wallet.publicKey) return;
    void refreshMaster(true);
  }, [wallet.publicKey, refreshMaster]);

  const masterInactive = !!masterVault && !masterVault.isActive;
  const adminFallback = (process.env.NEXT_PUBLIC_MASTER_AUTHORITY || '').trim();
  const isAdmin = useMemo(() => {
    if (!wallet.publicKey) return false;
    if (masterVault?.authority) {
      return masterVault.authority.equals(wallet.publicKey);
    }
    if (adminFallback) {
      try {
        return new PublicKey(adminFallback).equals(wallet.publicKey);
      } catch {
        return false;
      }
    }
    return false;
  }, [wallet.publicKey, masterVault?.authority, adminFallback]);

  const isPoolVaultReady = Boolean(
    masterVault?.vaultTokenAccount &&
    masterVault.vaultTokenAccount.toBase58() !== EMPTY_PUBKEY
  );

  const ensurePoolVaultSetup = useCallback(async () => {
    if (!wallet.publicKey) {
      setError('Connect your admin wallet first.');
      return false;
    }
    if (!isAdmin) {
      setError('Pool vault setup requires the admin wallet.');
      return false;
    }
    if (!masterVault) {
      await runAction('Init master vault', () => initMasterVaultV4(connection, wallet));
      await refreshMaster();
    }

    const vaultAccount =
      masterVault && masterVault.vaultTokenAccount.toBase58() !== EMPTY_PUBKEY
        ? masterVault.vaultTokenAccount
        : null;

    if (!vaultAccount) {
      const created = await runAction('Create pool vault token account', () =>
        createIncoTokenAccount(connection, wallet, masterVaultPda)
      );
      if (!created || typeof created !== 'object' || !('tokenAccount' in created)) {
        setError('Failed to create pool vault token account.');
        return false;
      }
      const tokenAccount = (created as any).tokenAccount as PublicKey;
      setPoolVaultTokenAccount(tokenAccount.toBase58());
      await runAction('Set pool vault', () => setPoolVaultV4(connection, wallet, tokenAccount));
      await refreshMaster();
    }

    return true;
  }, [connection, isAdmin, masterVault, masterVaultPda, refreshMaster, runAction, wallet, wallet.publicKey]);

  const refreshBusiness = useCallback(
    async (overridePda?: PublicKey) => {
      const targetPda = overridePda ?? businessPda;
      if (!targetPda) {
        setError('Business index is required.');
        return;
      }
      await runAction('Refresh business', async () => {
        const account = await getBusinessV4AccountByAddress(connection, targetPda);
        setBusiness(account);
        if (account?.businessIndex !== undefined && account?.businessIndex !== null) {
          setBusinessIndexInput(String(account.businessIndex));
        }
        return account;
      });
    },
    [businessPda, connection, runAction]
  );

  const refreshConfig = useCallback(async () => {
    if (!businessPda) {
      setError('Business index is required.');
      return;
    }
    await runAction('Refresh stream config', async () => {
      const account = await getBusinessStreamConfigV4Account(connection, businessPda);
      setStreamConfig(account);
      return account;
    });
  }, [businessPda, connection, runAction]);

  const refreshEmployee = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setError('Business and employee index are required.');
      return;
    }
    await runAction('Refresh employee', async () => {
      const account = await getEmployeeV4Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      if (account) {
        setIsDelegated(account.isDelegated);
      }
      return account;
    });
  }, [businessPda, employeeIndex, connection, runAction]);

  const refreshRateHistory = useCallback(async () => {
    if (!businessPda || employeeIndex === null) {
      setRateHistoryExists(false);
      return;
    }
    setRateHistoryLoading(true);
    try {
      const history = await getRateHistoryV4Account(connection, businessPda, employeeIndex);
      setRateHistoryExists(Boolean(history));
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh rate history');
    } finally {
      setRateHistoryLoading(false);
    }
  }, [businessPda, employeeIndex, connection]);

  useEffect(() => {
    if (businessPda && employeeIndex !== null) {
      void refreshRateHistory();
    } else {
      setRateHistoryExists(false);
    }
  }, [businessPda, employeeIndex, refreshRateHistory]);

  const refreshDelegation = useCallback(async () => {
    if (!employeePda) {
      setError('Business and employee index are required.');
      return;
    }
    await runAction('Refresh delegation status', async () => {
      const info = await connection.getAccountInfo(employeePda, 'confirmed');
      if (!info) {
        setIsDelegated(null);
        throw new Error('Employee v4 account not found');
      }
      setIsDelegated(info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM));
      return info;
    });
  }, [connection, employeePda, runAction]);

  const waitForDelegationStatus = useCallback(
    async (targetDelegated: boolean, label: string) => {
      if (!employeePda) return false;
      setDelegationStatusMsg(`${label}... waiting for base-layer confirmation.`);
      let attempts = 0;
      while (attempts < 12) {
        attempts += 1;
        const info = await connection.getAccountInfo(employeePda, 'confirmed');
        if (info) {
          const delegatedNow = info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM);
          setIsDelegated(delegatedNow);
          if (delegatedNow === targetDelegated) {
            setDelegationStatusMsg(
              targetDelegated
                ? 'Delegation confirmed on base layer.'
                : 'Undelegate confirmed on base layer.'
            );
            return true;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setDelegationStatusMsg('Status is still pending. Click “Refresh Status” to re-check.');
      return false;
    },
    [connection, employeePda]
  );

  // getCrankStorageKey, storeCrankInfo, clearCrankInfo, checkCrankScheduled
  // are now defined earlier in the file (before the useEffect that references them).

  const refreshPublicUsdcBalance = useCallback(async () => {
    if (!wallet.publicKey) {
      setPublicUsdcBalanceError('Connect wallet first.');
      return;
    }
    const publicMintRaw = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || '';
    if (!publicMintRaw || publicMintRaw === EMPTY_PUBKEY) {
      setPublicUsdcBalanceError('Public USDC mint not configured.');
      return;
    }
    setPublicUsdcBalanceLoading(true);
    setPublicUsdcBalanceError('');
    try {
      const publicMint = new PublicKey(publicMintRaw);
      const userAta = await getAssociatedTokenAddress(publicMint, wallet.publicKey);
      const info = await connection.getAccountInfo(userAta, 'confirmed');
      if (!info) {
        setPublicUsdcBalance(null);
        setPublicUsdcBalanceError('No public USDC account found on this network.');
        return;
      }
      const balance = await connection.getTokenAccountBalance(userAta, 'confirmed');
      setPublicUsdcBalance(balance?.value?.uiAmountString ?? balance?.value?.uiAmount?.toString() ?? '0');
    } catch (e: any) {
      setPublicUsdcBalanceError(e?.message || 'Failed to load public USDC balance.');
    } finally {
      setPublicUsdcBalanceLoading(false);
    }
  }, [connection, wallet.publicKey]);

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
        !depositorTokenAccount
      ) {
        setDepositorTokenAccount(registry.incoTokenAccount.toBase58());
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh token registry');
    } finally {
      setUserTokenRegistryLoading(false);
    }
  }, [connection, depositorTokenAccount, wallet.publicKey]);

  const refreshDepositorBalance = useCallback(async () => {
    if (!depositorTokenAccount) {
      setDepositHandle(null);
      setDepositBalance(null);
      return;
    }
    setDepositBalanceLoading(true);
    setDepositBalanceError('');
    // Clear the stale decrypted balance so the user knows they must decrypt the new state.
    setDepositBalance(null);
    try {
      const account = await connection.getAccountInfo(new PublicKey(depositorTokenAccount), 'confirmed');
      if (!account?.data) {
        setDepositHandle(null);
        return;
      }
      const handle = extractIncoTokenHandle(Buffer.from(account.data));
      setDepositHandle(handle);
      if (handle === 0n) {
        setDepositBalance(null);
      }
    } catch (e: any) {
      setDepositBalanceError(e?.message || 'Failed to load depositor balance');
    } finally {
      setDepositBalanceLoading(false);
    }
  }, [connection, depositorTokenAccount]);

  const decryptDepositorBalance = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setDepositBalanceError('Connect a wallet that supports signMessage.');
      return;
    }
    if (!depositHandle || depositHandle === 0n) {
      setDepositBalanceError('No encrypted balance handle found yet.');
      return;
    }
    setDepositBalanceDecrypting(true);
    setDepositBalanceError('');
    try {
      const stale = await checkAllowanceStale(connection, depositHandle, wallet.publicKey);
      if (stale) {
        await grantIncoDecryptAccessForHandle(connection, wallet, depositHandle);
      }
      const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
      const result = await decrypt([depositHandle.toString()], {
        address: wallet.publicKey,
        signMessage: wallet.signMessage,
      });
      const value = BigInt(result?.plaintexts?.[0] || '0');
      setDepositBalance(value);
    } catch (e: any) {
      setDepositBalanceError(e?.message || 'Failed to decrypt balance');
    } finally {
      setDepositBalanceDecrypting(false);
    }
  }, [connection, depositHandle, wallet, wallet.publicKey, wallet.signMessage]);

  const refreshVaultBalance = useCallback(async () => {
    if (!business) {
      setVaultHandle(null);
      setVaultBalance(null);
      return;
    }
    setVaultBalanceLoading(true);
    setVaultBalanceError('');
    setVaultBalance(null);
    try {
      const handle = extractHandleFromCiphertext32(business.encryptedBalance);
      setVaultHandle(handle);
      if (handle === 0n) {
        setVaultBalance(null);
      }
    } catch (e: any) {
      setVaultBalanceError(e?.message || 'Failed to load vault balance handle');
    } finally {
      setVaultBalanceLoading(false);
    }
  }, [business]);

  const decryptVaultBalance = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      setVaultBalanceError('Connect a wallet that supports signMessage.');
      return;
    }
    if (!vaultHandle || vaultHandle === 0n) {
      setVaultBalanceError('No encrypted vault balance handle found yet.');
      return;
    }
    setVaultBalanceDecrypting(true);
    setVaultBalanceError('');
    try {
      const stale = await checkAllowanceStale(connection, vaultHandle, wallet.publicKey);
      if (stale) {
        await grantIncoDecryptAccessForHandle(connection, wallet, vaultHandle);
      }
      const { decrypt } = await import('@inco/solana-sdk/attested-decrypt');
      const result = await decrypt([vaultHandle.toString()], {
        address: wallet.publicKey,
        signMessage: wallet.signMessage,
      });
      const value = BigInt(result?.plaintexts?.[0] || '0');
      setVaultBalance(value);
    } catch (e: any) {
      setVaultBalanceError(e?.message || 'Failed to decrypt vault balance');
    } finally {
      setVaultBalanceDecrypting(false);
    }
  }, [connection, vaultHandle, wallet, wallet.publicKey, wallet.signMessage]);

  const attemptAutoConfig = useCallback(
    async (force = false) => {
      if (autoConfigBusy) return;
      const targetBusinessPda = business?.address || businessPda;
      if (!targetBusinessPda || !wallet.publicKey) return;
      if (!force && (streamConfig || autoConfigAttempted)) return;
      setAutoConfigAttempted(true);
      setAutoConfigBusy(true);
      setAutoConfigError('');
      try {
        const interval = Number(settleIntervalSecs || '10');
        if (!Number.isFinite(interval) || interval <= 0) {
          throw new Error('Invalid cooldown interval');
        }
        const result = await runAction('Init payroll settings', () =>
          initStreamConfigV4(connection, wallet, targetBusinessPda, interval)
        );
        if (!result) {
          setAutoConfigError('Auto-setup failed. Check your business index and retry.');
          return;
        }
        await refreshConfig();
      } catch (e: any) {
        setAutoConfigError(e?.message || 'Auto-setup failed. Check your business index and retry.');
      } finally {
        setAutoConfigBusy(false);
      }
    },
    [
      autoConfigAttempted,
      autoConfigBusy,
      business,
      businessPda,
      connection,
      initStreamConfigV4,
      refreshConfig,
      runAction,
      settleIntervalSecs,
      streamConfig,
      wallet,
      wallet.publicKey,
    ]
  );

  useEffect(() => {
    if (depositorTokenAccount) {
      void refreshDepositorBalance();
    }
  }, [depositorTokenAccount, refreshDepositorBalance]);

  useEffect(() => {
    if (business) {
      void refreshVaultBalance();
    } else {
      setVaultHandle(null);
      setVaultBalance(null);
    }
  }, [business, refreshVaultBalance]);

  useEffect(() => {
    if (!wallet.connected) return;
    if (!businessPda || streamConfig) return;
    void attemptAutoConfig();
  }, [attemptAutoConfig, businessPda, streamConfig, wallet.connected]);

  const loadDevnetState = useCallback(async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/devnet/state');
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.error || 'Failed to load devnet state');
      }
      const data = json?.data || null;
      setDevnetState(data);
      if (data?.businessIndex !== undefined) {
        setBusinessIndexInput(String(data.businessIndex));
      }
      if (data?.employeeIndex !== undefined) {
        setEmployeeIndexInput(String(data.employeeIndex));
      }
      if (data?.poolVaultTokenAccount) {
        setPoolVaultTokenAccount(String(data.poolVaultTokenAccount));
      }
      if (data?.depositorTokenAccount) {
        setDepositorTokenAccount(String(data.depositorTokenAccount));
      }
      if (data?.employeeWallet) {
        setEmployeeWallet(String(data.employeeWallet));
      }
      setMessage('Loaded devnet v4 state.');
    } catch (e: any) {
      setError(e?.message || 'Failed to load devnet state');
    } finally {
      setBusy(false);
    }
  }, []);

  const step1State: StepState = masterVault ? 'done' : 'active';
  const step2State: StepState = masterVault
    ? business
      ? 'done'
      : masterInactive
        ? 'locked'
        : 'active'
    : 'locked';
  const step3State: StepState = business
    ? (vaultFundingObserved ? 'done' : 'active')
    : 'locked';
  const step4State: StepState = business ? (employee ? 'done' : 'active') : 'locked';
  const totalEmployees = business ? business.nextEmployeeIndex : null;
  const payrollStatus = streamConfig ? (streamConfig.isPaused ? 'Paused' : 'Active') : 'Not configured';
  const lastSettleLabel =
    employee?.lastSettleTime && employee.lastSettleTime > 0
      ? new Date(employee.lastSettleTime * 1000).toLocaleString()
      : '—';
  const suggestedSetupStep = useMemo(() => {
    if (!masterVault) return 1;
    if (!business) return 2;
    if (!vaultFundingObserved) return 3;
    if (!employee) return 4;
    return 4;
  }, [masterVault, business, vaultFundingObserved, employee]);
  const [setupStep, setSetupStep] = useState<number>(suggestedSetupStep);

  useEffect(() => {
    if (mode === 'setup') {
      setSetupStep(suggestedSetupStep);
    }
  }, [mode, suggestedSetupStep]);

  useEffect(() => {
    if (!resolvedPerSecond) return;
    setSalaryPerSecond(resolvedPerSecond);
  }, [resolvedPerSecond]);

  const showDashboard = mode === 'dashboard' || mode === 'all';
  const showEmployees = mode === 'employees' || mode === 'all';
  const showAgent = mode === 'agent' || mode === 'all';
  const showHistory = mode === 'history' || mode === 'all';
  const showReports = mode === 'reports' || mode === 'all';
  const isSoloAgent = showAgent && !showDashboard;
  const setupOnly = mode === 'setup';
  const advancedAllowed =
    process.env.NEXT_PUBLIC_ENABLE_ADVANCED === 'true' ||
    process.env.NEXT_PUBLIC_ADMIN_MODE === 'true';
  const advancedEnabled = advancedAllowed && showAdvanced;
  const showStep1 = setupOnly ? setupStep === 1 : mode === 'vault' || mode === 'all';
  const showStep2 = setupOnly ? setupStep === 2 : mode === 'all';
  const showStep3 = setupOnly ? setupStep === 3 : mode === 'payments' || mode === 'all';
  const showStep4 = setupOnly ? setupStep === 4 : mode === 'all';
  const completedSteps = [step1State, step2State, step3State, step4State].filter(
    (step) => step === 'done'
  ).length;
  const setupSteps = [1, 2, 3, 4];
  const stepNumberMap: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4 };
  const currentSetupIndex = Math.max(0, setupSteps.indexOf(setupStep));
  const canGoBack = currentSetupIndex > 0;
  const canGoNext = currentSetupIndex < setupSteps.length - 1;
  const schedulePresets = ['10', '30', '60', '300', '900', '3600'];
  const schedulePresetLabel: Record<string, string> = {
    '10': 'Every 10 seconds',
    '30': 'Every 30 seconds',
    '60': 'Every 1 minute',
    '300': 'Every 5 minutes',
    '900': 'Every 15 minutes',
    '3600': 'Every 1 hour',
  };
  const isCustomSchedule = !schedulePresets.includes((settleIntervalSecs || '').trim());
  const nextStepLabel = [
    'Master vault',
    'Register business',
    'Fund vault',
    'Add employee',
  ][suggestedSetupStep - 1];

  return (
    <ExpenseeShell
      title="Dashboard"
      subtitle="Manage your private payroll operations"
      actions={
        <button
          type="button"
          className="expensee-action-btn outline"
          onClick={() => setShowBalancePanel((prev) => !prev)}
        >
          {showBalancePanel ? 'Hide Balance' : 'Balance'}
        </button>
      }
    >
      <Head>
        <title>Expensee Employer v4 | Pooled Vault Privacy</title>
      </Head>

      <div className="space-y-6">
        {message ? <div className="expensee-alert">{message}</div> : null}
        {error ? <div className="expensee-alert">{error}</div> : null}
        {lastTx ? <div className="expensee-alert">Last tx ({lastTx.label}): {lastTx.sig}</div> : null}

        {showBalancePanel ? (
          <section id="deposit-balance" className="expensee-card">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h4>Depositor balance</h4>
                <div className="expensee-stat">
                  {depositBalance !== null ? `${formatTokenAmount(depositBalance)} USDC` : 'Encrypted'}
                </div>
                <div className="expensee-sub">
                  {depositorTokenAccount
                    ? `Account: ${formatAddress(depositorTokenAccount)}`
                    : 'Create a depositor token to view balance'}
                </div>
                <div className="expensee-sub">
                  Encrypted status: {depositHandle && depositHandle !== 0n ? 'ready' : 'not available'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void refreshDepositorBalance()}
                  disabled={depositBalanceLoading || !depositorTokenAccount}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  {depositBalanceLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  onClick={() => void decryptDepositorBalance()}
                  disabled={depositBalanceDecrypting || !depositHandle || depositHandle === 0n}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  {depositBalanceDecrypting ? 'Decrypting…' : 'Decrypt'}
                </button>
              </div>
            </div>
            {depositBalanceError ? (
              <div className="expensee-sub text-rose-300">{depositBalanceError}</div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--app-border)] pt-4">
              <div>
                <h4>Total deposited (vault balance)</h4>
                <div className="expensee-stat">
                  {vaultBalance !== null ? `${formatTokenAmount(vaultBalance)} USDC` : 'Encrypted'}
                </div>
                <div className="expensee-sub">
                  Business index: {businessIndex !== null ? businessIndex : '—'}
                </div>
                <div className="expensee-sub">
                  Encrypted status: {vaultHandle && vaultHandle !== 0n ? 'ready' : 'not available'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void refreshVaultBalance()}
                  disabled={vaultBalanceLoading || !business}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  {vaultBalanceLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  onClick={() => void decryptVaultBalance()}
                  disabled={vaultBalanceDecrypting || !vaultHandle || vaultHandle === 0n}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  {vaultBalanceDecrypting ? 'Decrypting…' : 'Decrypt'}
                </button>
              </div>
            </div>
            {vaultBalanceError ? (
              <div className="expensee-sub text-rose-300">{vaultBalanceError}</div>
            ) : null}
            <div className="mt-4 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-3 text-xs text-[var(--app-muted)]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-[var(--app-ink)]">Business identity</span>
                <span>Index: {businessIndex !== null ? businessIndex : '—'}</span>
              </div>
              <div className="mt-2 break-all">Business PDA: {businessPda ? businessPda.toBase58() : '—'}</div>
              <div className="mt-1 break-all">Master PDA: {masterVaultPda.toBase58()}</div>
              <div className="mt-1 break-all">
                Pool vault token: {masterVault?.vaultTokenAccount?.toBase58?.() || poolVaultTokenAccount || '—'}
              </div>
            </div>
          </section>
        ) : null}

        {/* {showDashboard ? (
          <section id="overview" className="expensee-grid">
            <div className="expensee-card">
              <h4>Business</h4>
              <div className="expensee-stat">{businessExists ? 'Registered' : 'Pending'}</div>
              <div className="expensee-sub">Index: {businessIndex ?? '—'}</div>
            </div>
            <div className="expensee-card">
              <h4>Employees</h4>
              <div className="expensee-stat">{totalEmployees ?? '—'}</div>
              <div className="expensee-sub">Active ledger entries</div>
            </div>
            <div className="expensee-card">
              <h4>Vault</h4>
              <div className="expensee-stat">{vaultExists ? 'Ready' : 'Missing'}</div>
              <div className="expensee-sub">{vaultFundingObserved ? 'Funded' : 'Not funded'}</div>
            </div>
            <div className="expensee-card">
              <h4>Payroll operator</h4>
              <div className="expensee-stat">{streamConfig ? 'Configured' : 'Pending'}</div>
              <div className="expensee-sub">{streamConfig ? `Every ${streamConfig.settleIntervalSecs}s` : 'Set schedule'}</div>
            </div>
          </section>
        ) : null} */}

        {mode === 'all' && advancedEnabled ? (
          <section className="expensee-status-grid">
            <div className="expensee-status-card">
              <h3>Business & Vault</h3>
              <div className="expensee-kv">
                <span>Business PDA</span>
                <span className="value mono">{businessPda ? businessPda.toBase58() : '—'}</span>
              </div>
              <div className="expensee-kv">
                <span>Pool vault token</span>
                <span className="value mono">
                  {masterVault?.vaultTokenAccount?.toBase58?.() ?? '—'}
                </span>
              </div>
              <div className="expensee-kv">
                <span>Funding status</span>
                <span className="value">{vaultFundingObserved ? 'Funded' : 'Not funded'}</span>
              </div>
            </div>
            <div className="expensee-status-card">
              <h3>Payroll Settings</h3>
              <div className="expensee-kv">
                <span>Payroll settings</span>
                <span className="value">{streamConfig ? 'Ready' : 'Not configured'}</span>
              </div>
              <div className="expensee-kv">
                <span>Update schedule</span>
                <span className="value">{streamConfig ? `${streamConfig.settleIntervalSecs}s` : '—'}</span>
              </div>
            </div>
            <div className="expensee-status-card">
              <h3>Employee & Execution</h3>
              <div className="expensee-kv">
                <span>Employee PDA</span>
                <span className="value mono">{employeePda ? employeePda.toBase58() : '—'}</span>
              </div>
              <div className="expensee-kv">
                <span>Delegation</span>
                <span className="value">{isDelegated ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div className="expensee-kv">
                <span>TEE auth</span>
                <span className="value">{teeStatus === 'ready' ? 'Ready' : 'Missing'}</span>
              </div>
            </div>
          </section>
        ) : null}

        {/* {showDashboard ? (
          <section className="expensee-setup-summary">
            <div className="expensee-setup-card">
              <div className="expensee-setup-head">
                <div>
                  <h3>Setup Progress</h3>
                  <p>Complete setup to enable private payroll streaming.</p>
                </div>
                <Link className="expensee-cta-btn" href="/setup">Open Setup</Link>
              </div>
              <div className="expensee-setup-slim">
                <div>
                  <span className="expensee-sub">Completed</span>
                  <div className="expensee-stat">{completedSteps}/5</div>
                </div>
                <div>
                  <span className="expensee-sub">Next step</span>
                  <div className="expensee-stat">{nextStepLabel}</div>
                </div>
              </div>
            </div>
          </section>
        ) : null} */}

        {showEmployees ? (
          <section id="employees" className="expensee-section">
            <div className="expensee-section-header">
              <div>
                <h3>Employees</h3>
                <p>Manage your team and payroll settings.</p>
              </div>
              <a className="expensee-cta-btn" href="#setup">
                Add Employee
              </a>
            </div>
            <div className="expensee-table-wrap">
              {employee ? (
                <table className="expensee-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Wallet</th>
                      <th>Salary</th>
                      <th>Status</th>
                      <th>Privacy</th>
                      <th>Last Settle</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>#{employeeIndex ?? '—'}</td>
                      <td className="mono">{employeeWallet || '—'}</td>
                      <td>Encrypted</td>
                      <td>{employee.isActive ? 'Active' : 'Inactive'}</td>
                      <td>{isDelegated ? 'Delegated' : 'Base'}</td>
                      <td>{lastSettleLabel}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div className="expensee-table-empty">
                  <div className="expensee-empty-title">No employees yet</div>
                  <div className="expensee-empty-sub">Create your first encrypted payroll entry.</div>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {/* {showDashboard || showAgent ? (
          <section className={`expensee-panels ${isSoloAgent ? 'expensee-panels--solo' : ''}`}>
            {showDashboard ? (
              <div className="expensee-panel-stack">
                <div className="expensee-panel">
                  <div className="expensee-panel-top">
                    <div>
                      <h3>Fund Payroll</h3>
                      <p>Employers fund payroll using USDC. Employees only withdraw.</p>
                    </div>
                    <span className="expensee-pill">Devnet</span>
                  </div>
                  <div className="expensee-chip-row mb-4">
                    <button
                      onClick={() => setUsdcMode('real')}
                      className={`expensee-chip ${usdcMode === 'real' ? 'active' : ''}`}
                    >
                      Real USDC
                    </button>
                    <button
                      onClick={() => setUsdcMode('demo')}
                      className={`expensee-chip ${usdcMode === 'demo' ? 'active' : ''}`}
                    >
                      Demo USDC
                    </button>
                  </div>
                  {!depositorTokenAccount ? (
                    <div className="space-y-3">
                      <div className="expensee-note">
                        Create a depositor token account in setup before minting or depositing.
                      </div>
                      <Link className="expensee-cta-btn" href="/setup">Open Setup</Link>
                    </div>
                  ) : (
                    <div className="expensee-fund-grid">
                      {usdcMode === 'demo' ? (
                        <div className="expensee-fund-card">
                          <div className="expensee-fund-head">Mint demo USDC (private)</div>
                          <div className="expensee-input-row">
                            <input
                              value={mintAmount}
                              onChange={(e) => setMintAmount(e.target.value)}
                              placeholder="Amount"
                              className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm"
                            />
                            <span className="expensee-unit">USDC</span>
                          </div>
                          <div className="expensee-chip-row">
                            {[10, 50, 100, 500].map((preset) => (
                              <button
                                key={preset}
                                onClick={() => setMintAmount(String(preset))}
                                className={`expensee-chip ${mintAmount === String(preset) ? 'active' : ''}`}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={async () => {
                              const amountNum = Number(mintAmount || '0');
                              if (!amountNum || amountNum <= 0) {
                                setError('Enter a valid mint amount.');
                                return;
                              }
                              const result = await runAction('Mint demo USDC', async () => {
                                const resp = await fetch('/api/faucet/mint-payusd', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    userConfidentialTokenAccount: depositorTokenAccount,
                                    amountUi: amountNum,
                                  }),
                                });
                                const json = await resp.json();
                                if (!resp.ok || !json?.ok) {
                                  throw new Error(json?.error || 'Faucet mint failed');
                                }
                                return json;
                              });
                              if (result && typeof result === 'object' && 'tx' in result) {
                                setLastMintTx((result as any).tx);
                                setLastMintAmount(Number((result as any).amount ?? amountNum));
                              }
                            }}
                            disabled={busy}
                            className="premium-btn premium-btn-primary disabled:opacity-50"
                          >
                            Mint demo USDC
                          </button>
                          {lastMintTx ? (
                            <div className="text-xs text-[var(--app-muted)]">
                              Last mint: {lastMintAmount ?? '—'} USDC ·{' '}
                              <span className="mono">{lastMintTx.slice(0, 8)}...{lastMintTx.slice(-4)}</span>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="expensee-fund-card">
                          <div className="expensee-fund-head">Get real devnet USDC</div>
                          <div className="text-xs text-[var(--app-muted)]">
                            Get Circle devnet USDC in the employer wallet, then wrap to private USDC in the Bridge.
                          </div>
                          <div className="mt-3 flex flex-col gap-3">
                            <a
                              className="premium-btn premium-btn-primary text-center"
                              href="https://faucet.circle.com/"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open Circle Faucet
                            </a>
                            <div className="expensee-input-row">
                              <input
                                value={wrapAmount}
                                onChange={(e) => setWrapAmount(e.target.value)}
                                placeholder="Wrap amount"
                                className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm"
                              />
                              <span className="expensee-unit">USDC</span>
                            </div>
                            <button
                              onClick={async () => {
                                if (!wallet.publicKey) {
                                  setError('Connect wallet first.');
                                  return;
                                }
                                if (!depositorTokenAccount) {
                                  setError('Create a depositor token account first.');
                                  return;
                                }
                                const amountNum = Number(wrapAmount || '0');
                                if (!amountNum || amountNum <= 0) {
                                  setError('Enter a valid wrap amount.');
                                  return;
                                }
                                const publicMintRaw = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || '';
                                if (!publicMintRaw || publicMintRaw === EMPTY_PUBKEY) {
                                  setError('Public USDC mint not configured.');
                                  return;
                                }
                                if (!wallet.publicKey) {
                                  setError('Connect wallet first.');
                                  return;
                                }
                                const pubkey = wallet.publicKey;
                                const publicMint = new PublicKey(publicMintRaw);
                                const wrapResult = await runAction('Wrap public USDC → Private', async () => {
                                  // ── Step 1: Transfer public USDC to escrow ──
                                  const userAta = await getAssociatedTokenAddress(publicMint, pubkey);
                                  const buildResp = await fetch('/api/bridge/build-wrap-public', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      userPublicKey: pubkey.toBase58(),
                                      userPublicUsdcAta: userAta.toBase58(),
                                      amountUi: amountNum,
                                      publicUsdcMint: publicMint.toBase58(),
                                    }),
                                  });
                                  const buildRaw = await buildResp.text();
                                  let buildJson: any = null;
                                  try {
                                    buildJson = buildRaw ? JSON.parse(buildRaw) : null;
                                  } catch {
                                    throw new Error(`Wrap build failed (${buildResp.status}): ${buildRaw || 'invalid JSON response'}`);
                                  }
                                  if (!buildResp.ok || !buildJson?.ok) {
                                    throw new Error(buildJson?.error || `Wrap build failed (${buildResp.status})`);
                                  }
                                  const tx = Transaction.from(Buffer.from(buildJson.txBase64, 'base64'));
                                  if (!wallet.signTransaction) {
                                    throw new Error('Wallet does not support signTransaction.');
                                  }
                                  const signed = await wallet.signTransaction(tx);
                                  const sig = await connection.sendRawTransaction(signed.serialize(), {
                                    skipPreflight: false,
                                    maxRetries: 3,
                                  });
                                  if (tx.recentBlockhash && tx.lastValidBlockHeight) {
                                    await connection.confirmTransaction(
                                      {
                                        signature: sig,
                                        blockhash: tx.recentBlockhash,
                                        lastValidBlockHeight: tx.lastValidBlockHeight,
                                      },
                                      'confirmed'
                                    );
                                  }
                                  setLastWrapTx(sig);

                                  // ── Step 2: Mint confidential USDC ──
                                  const mintResp = await fetch('/api/faucet/mint-payusd', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      userConfidentialTokenAccount: depositorTokenAccount,
                                      amountUi: amountNum,
                                    }),
                                  });
                                  const mintJson = await mintResp.json();
                                  if (!mintResp.ok || !mintJson?.ok) {
                                    throw new Error(mintJson?.error || 'Confidential mint failed after escrow transfer');
                                  }
                                  return sig;
                                });
                                if (wrapResult) {
                                  void refreshDepositorBalance();
                                }
                              }}
                              disabled={busy || !wallet.publicKey || !depositorTokenAccount}
                              className="premium-btn premium-btn-secondary disabled:opacity-50"
                            >
                              Wrap Public USDC → Private
                            </button>
                            {lastWrapTx ? (
                              <div className="text-xs text-[var(--app-muted)]">
                                Last wrap: <span className="mono">{lastWrapTx.slice(0, 8)}...{lastWrapTx.slice(-4)}</span>
                              </div>
                            ) : null}
                            <Link className="premium-btn premium-btn-secondary text-center" href="/bridge">
                              Open Full Bridge
                            </Link>
                          </div>
                        </div>
                      )}
                      <div className="expensee-fund-card">
                        <div className="expensee-fund-head">Deposit to pooled vault</div>
                        <div className="expensee-input-row">
                          <input
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            placeholder="Amount"
                            className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm"
                          />
                          <span className="expensee-unit">USDC</span>
                        </div>
                        <div className="text-xs text-[var(--app-muted)]">
                          Deposits move funds into the pooled vault ledger.
                        </div>
                        <button
                          onClick={async () => {
                            if (!businessPda) {
                              setError('Business index is required.');
                              return;
                            }
                            await runAction('Deposit to pool', () => {
                              const depositor = mustPubkey('depositor token account', depositorTokenAccount);
                              const poolToken = mustPubkey(
                                'pool vault token account',
                                poolVaultTokenAccount || masterVault?.vaultTokenAccount?.toBase58() || ''
                              );
                              const amount = parseUiAmount('deposit', depositAmount);
                              return depositV4(connection, wallet, businessPda, depositor, poolToken, amount);
                            });
                            setVaultFundingObserved(true);
                            await refreshBusiness();
                            await refreshVaultBalance();
                          }}
                          disabled={busy || !businessPda}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Deposit USDC
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="expensee-panel">
                  <h3>Recent Activity</h3>
                  {lastTx ? (
                    <div className="mt-3 space-y-2 text-xs text-[var(--app-muted)]">
                      <div>Last action: {lastTx.label}</div>
                      <div className="mono break-all">{lastTx.sig}</div>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--app-muted)] mt-3">No recent transactions yet.</p>
                  )}
                </div>
              </div>
            ) : null}
            {showAgent ? (
              <div id="agent" className="expensee-panel expensee-chat-panel">
                {!wallet.connected ? (
                  <p className="text-sm text-[var(--app-muted)] mb-4 px-5 pt-5">
                    Connect a wallet to activate the agent.
                  </p>
                ) : null}
                <AgentChat
                  walletConnected={!!wallet.connected}
                  walletAddress={wallet.publicKey?.toBase58() || ''}
                  businessExists={businessExists}
                  vaultExists={vaultExists}
                  configExists={configExists}
                  depositorBalance={null}
                  vaultBalance={vaultBalance !== null ? String(vaultBalance) : null}
                  depositorTokenAccount={depositorTokenAccount}
                  employeeWallet={employeeWallet}
                  payPreset={payPreset}
                  payAmount={payAmount}
                  depositAmount={depositAmount}
                  setDepositAmount={setDepositAmount}
                  streamIndex={streamIndex}
                  onDraftPlan={handleChatDraftPlan}
                  onExecutePlan={handleChatExecute}
                  onApplyPlan={handleChatApplyPlan}
                  executionSteps={agentQueue}
                  busy={agentExecuteBusy}
                  messages={agentMessages}
                  setMessages={setAgentMessages}
                  phase={agentPhase as any}
                  setPhase={setAgentPhase}
                  ready={wallet.connected}
                  hydrated={agentRunHydrated}
                  onCancelBusy={handleCancelBusy}
                  onClearChat={() => {
                    setAgentMessages([]);
                    setAgentQueue([]);
                    setAgentPhase('greeting');
                  }}
                  boundPresetPeriod={boundPresetPeriod}
                  setBoundPresetPeriod={setBoundPresetPeriod}
                  scope="employer"
                />
              </div>
            ) : null}
          </section>
        ) : null} */}

        {showHistory ? (
          <section id="history" className="expensee-section">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[var(--app-ink)]">Payroll History</h2>
                <p className="text-sm text-[var(--app-muted)]">Expensee program activity only.</p>
                <p className="text-xs text-[var(--app-muted)]">
                  Source: {payrollHistory.source === 'helius' ? 'Helius enhanced API' : 'RPC fallback (set NEXT_PUBLIC_HELIUS_API_KEY)'}
                </p>
              </div>
              <div className="expensee-history-actions">
                <button
                  onClick={handleExportHistory}
                  disabled={payrollHistory.rows.length === 0}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  Export CSV
                </button>
                <button
                  onClick={() => void payrollHistory.refresh()}
                  disabled={payrollHistory.loading}
                  className="premium-btn premium-btn-secondary disabled:opacity-50"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="expensee-grid expensee-history-stats">
              <div className="expensee-card">
                <h4>Total Incoming</h4>
                <div className="expensee-stat">
                  {payrollHistory.stats.totalIncoming === null ? 'Encrypted' : payrollHistory.stats.totalIncoming.toFixed(2)}
                </div>
                <div className="expensee-sub">USDC</div>
              </div>
              <div className="expensee-card">
                <h4>Total Outgoing</h4>
                <div className="expensee-stat">
                  {payrollHistory.stats.totalOutgoing === null ? 'Encrypted' : payrollHistory.stats.totalOutgoing.toFixed(2)}
                </div>
                <div className="expensee-sub">USDC</div>
              </div>
              <div className="expensee-card">
                <h4>Transactions</h4>
                <div className="expensee-stat">{payrollHistory.stats.transactionCount}</div>
                <div className="expensee-sub">Loaded</div>
              </div>
              <div className="expensee-card">
                <h4>Privacy</h4>
                <div className="expensee-stat">Encrypted</div>
                <div className="expensee-sub">Expensee program</div>
              </div>
            </div>

            <div className="expensee-table-wrap expensee-history-table">
              {payrollHistory.loading ? (
                <div className="expensee-table-empty">
                  <div className="expensee-empty-title">Loading transactions…</div>
                  <div className="expensee-empty-sub">Fetching program activity.</div>
                </div>
              ) : payrollHistory.error ? (
                <div className="expensee-table-empty">
                  <div className="expensee-empty-title">Failed to load history</div>
                  <div className="expensee-empty-sub">{payrollHistory.error}</div>
                </div>
              ) : payrollHistory.rows.length === 0 ? (
                <div className="expensee-table-empty">
                  <div className="expensee-empty-title">No payroll transactions yet</div>
                  <div className="expensee-empty-sub">Run setup and stream to generate history.</div>
                </div>
              ) : (
                <table className="expensee-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Direction</th>
                      <th>Amount</th>
                      <th>Date</th>
                      <th>Privacy</th>
                      <th>Status</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payrollHistory.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.type}</td>
                        <td>{row.direction === 'neutral' ? '—' : row.direction}</td>
                        <td>
                          {row.amount === null ? 'Encrypted' : `${row.amount.toFixed(2)} ${row.currency}`}
                        </td>
                        <td>
                          {row.date} · {row.time}
                        </td>
                        <td>{row.privacy}</td>
                        <td>{row.status}</td>
                        <td>
                          <a
                            className="expensee-link mono"
                            href={`https://explorer.solana.com/tx/${row.signature}?cluster=${payrollHistory.cluster}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.signature.slice(0, 8)}...{row.signature.slice(-4)}
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ) : null}

        {/* USER_REQUEST: Removed setup wizard from homepage */}
        {false && (showStep1 || showStep2 || showStep3 || showStep4) ? (
          <section id="setup" className="expensee-steps">
            {setupOnly ? (
              <div className="expensee-setup-nav">
                <div className="expensee-setup-nav-title">
                  <h3>Setup Wizard</h3>
                  <p>Follow the steps in order. Use Next to continue.</p>
                </div>
                <div className="expensee-setup-nav-steps">
                  {setupSteps.map((step, idx) => (
                    <button
                      key={step}
                      type="button"
                      className={`expensee-step-chip ${setupStep === step ? 'active' : ''}`}
                      onClick={() => setSetupStep(step)}
                    >
                      Step {idx + 1}
                    </button>
                  ))}
                </div>
                {isAdmin ? (
                  <div className="expensee-step-badge">
                    Admin mode · {wallet.publicKey ? wallet.publicKey.toBase58() : 'connect wallet'}
                  </div>
                ) : null}
                <div className="expensee-setup-nav-actions">
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
                    onClick={() => setSetupStep(setupSteps[Math.max(0, currentSetupIndex - 1)])}
                    disabled={!canGoBack}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="expensee-action-btn"
                    onClick={() => setSetupStep(setupSteps[Math.min(setupSteps.length - 1, currentSetupIndex + 1)])}
                    disabled={!canGoNext}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
            {showStep1 ? (
              <div id="vault" className="expensee-step-wrap">
                <StepCard
                  number={stepNumberMap[1] ?? 1}
                  title="Master vault"
                  description="Initialize the pooled master vault and set the global vault token account."
                  state={step1State}
                  collapsible={!setupOnly}
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="panel-card">
                      <h2 className="text-lg font-semibold text-[var(--app-ink)]">Master Vault Status</h2>
                      <p className="mt-1 text-sm text-[var(--app-muted)]">Initialize once per program.</p>
                      <div className="mt-4 space-y-3">
                        {masterVault && !isAdmin ? (
                          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                            ✅ Master vault is active · Authority: <span className="mono">{masterVault.authority.toBase58().slice(0, 8)}...{masterVault.authority.toBase58().slice(-4)}</span>
                            <div className="mt-1 text-[10px] text-emerald-200/60">
                              Your wallet is not the admin. Vault init is read-only. You can proceed to Step 2.
                            </div>
                          </div>
                        ) : isAdmin ? (
                          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                            Admin wallet: {wallet.publicKey ? wallet.publicKey.toBase58() : 'connect wallet'}
                            {masterVault?.authority ? (
                              <div className="mt-1 text-[10px] text-emerald-200">
                                Master vault authority: {masterVault.authority.toBase58()}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="expensee-note">
                          This creates the shared pooled vault used by all businesses.
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => void runAction('Init master vault', () => initMasterVaultV4(connection, wallet))}
                            disabled={busy || !isAdmin}
                            className="premium-btn premium-btn-primary disabled:opacity-50"
                            title={!isAdmin ? 'Only the admin wallet can initialize the vault' : undefined}
                          >
                            Init Master Vault
                          </button>
                          <button
                            onClick={() => void refreshMaster()}
                            disabled={busy}
                            className="premium-btn premium-btn-secondary disabled:opacity-50"
                          >
                            Refresh
                          </button>
                        </div>
                        {advancedEnabled ? (
                          <AdvancedDetails title="Technical details">
                            {masterVault ? (
                              <div className="text-xs text-[var(--app-muted)]">
                                Next business index: {masterVault.nextBusinessIndex} · Active: {masterVault.isActive ? 'yes' : 'no'}
                              </div>
                            ) : null}
                            <div className="text-xs text-[var(--app-muted)] break-all">
                              Master PDA: {masterVaultPda.toBase58()}
                            </div>
                          </AdvancedDetails>
                        ) : null}
                      </div>
                    </div>

                    <div className="panel-card">
                      <h2 className="text-lg font-semibold text-[var(--app-ink)]">Pooled Vault Token</h2>
                      <p className="mt-1 text-sm text-[var(--app-muted)]">Create or set the global pooled Inco token account.</p>
                      <div className="mt-4 space-y-3">
                        <input
                          value={poolVaultTokenAccount}
                          onChange={(e) => setPoolVaultTokenAccount(e.target.value)}
                          placeholder="Pool vault token account"
                          className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={async () => {
                              if (!wallet.publicKey) {
                                setError('Connect wallet first.');
                                return;
                              }
                              const result = await runAction('Create pooled vault token account', () =>
                                createIncoTokenAccount(connection, wallet, masterVaultPda)
                              );
                              if (result && typeof result === 'object' && 'tokenAccount' in result) {
                                setPoolVaultTokenAccount((result as any).tokenAccount.toBase58());
                              }
                            }}
                            disabled={busy}
                            className="premium-btn premium-btn-secondary disabled:opacity-50"
                          >
                            Create Pool Vault Token
                          </button>
                          <button
                            onClick={async () => {
                              await runAction('Set pool vault', () => {
                                const tokenAccount = mustPubkey('pool vault token account', poolVaultTokenAccount);
                                return setPoolVaultV4(connection, wallet, tokenAccount);
                              });
                              await refreshMaster();
                            }}
                            disabled={busy || !poolVaultTokenAccount}
                            className="premium-btn premium-btn-primary disabled:opacity-50"
                          >
                            Set Pool Vault
                          </button>
                        </div>
                        {advancedEnabled ? (
                          <AdvancedDetails title="Technical details">
                            {masterVault?.vaultTokenAccount ? (
                              <div className="text-xs text-[var(--app-muted)] break-all">
                                Current pool vault: {masterVault.vaultTokenAccount.toBase58()}
                              </div>
                            ) : null}
                            <div className="text-xs text-[var(--app-muted)] break-all">Mint: {PAYUSD_MINT.toBase58()}</div>
                          </AdvancedDetails>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </StepCard>
              </div>
            ) : null}

            {showStep2 ? (
              <div className="expensee-step-wrap">
                <StepCard
                  number={stepNumberMap[2] ?? 2}
                  title="Register business"
                  description="Create a privacy-preserving business entry using pooled vault PDAs."
                  state={step2State}
                  collapsible={!setupOnly}
                >
                  <div className="panel-card">
                    <h2 className="text-lg font-semibold text-[var(--app-ink)]">Business Registry</h2>
                    <p className="mt-1 text-sm text-[var(--app-muted)]">Index-based PDAs hide employer identities.</p>
                    <div className="mt-4 space-y-3">
                      <input
                        value={businessIndexInput}
                        onChange={(e) => setBusinessIndexInput(e.target.value)}
                        placeholder="Business index (leave blank to create new)"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      {masterInactive ? (
                        <div className="text-sm text-amber-500">Master vault is inactive. Reactivate it with the authority wallet.</div>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            const result = await runAction('Register business', () => registerBusinessV4(connection, wallet));
                            if (!result) return;
                            if (result && typeof result === 'object' && 'businessIndex' in result) {
                              setBusinessIndexInput(String((result as any).businessIndex));
                            }
                            if (result && typeof result === 'object' && 'businessPDA' in result) {
                              await refreshBusiness((result as any).businessPDA as PublicKey);
                            }
                            if (!isPoolVaultReady) {
                              await ensurePoolVaultSetup();
                            }
                          }}
                          disabled={busy || masterInactive}
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Register Business
                        </button>
                        <button
                          onClick={() => void refreshBusiness()}
                          disabled={busy || businessIndex === null}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Refresh
                        </button>
                      </div>
                      {advancedEnabled ? (
                        <AdvancedDetails title="Technical details">
                          {business ? (
                            <div className="text-xs text-[var(--app-muted)]">
                              Next employee index: {business.nextEmployeeIndex} · Active: {business.isActive ? 'yes' : 'no'}
                            </div>
                          ) : null}
                          <div className="text-xs text-[var(--app-muted)] break-all">
                            Business PDA: {businessPda ? businessPda.toBase58() : '—'}
                          </div>
                        </AdvancedDetails>
                      ) : null}
                    </div>
                  </div>
                </StepCard>
              </div>
            ) : null}

            {showStep4 ? (
              <div id="setup-employee" className="expensee-step-wrap">
                <StepCard
                  number={stepNumberMap[4] ?? 4}
                  title="Add employee"
                  description="Set who gets paid, how much, and (optionally) the contract window."
                  state={step4State}
                  collapsible={!setupOnly}
                >
                  <div className="panel-card">
                    <h2 className="text-lg font-semibold text-[var(--app-ink)]">Employee details</h2>
                    <p className="mt-1 text-sm text-[var(--app-muted)]">
                      Pay is calculated linearly over time: <span className="font-semibold">rate × elapsed</span>. If you set a
                      contract window, pay only accrues within that time range.
                    </p>
                    {!streamConfig ? (
                      <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                        Payroll settings are auto‑configuring. {autoConfigBusy ? 'Setting up now…' : 'Waiting for setup.'}
                        {autoConfigError ? (
                          <div className="mt-2 text-amber-200">{autoConfigError}</div>
                        ) : null}
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => void attemptAutoConfig(true)}
                            disabled={autoConfigBusy || !businessPda}
                            className="premium-btn premium-btn-secondary disabled:opacity-50"
                          >
                            Retry Auto‑Setup
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-4 space-y-3">
                      <input
                        value={employeeIndexInput}
                        onChange={(e) => setEmployeeIndexInput(e.target.value)}
                        placeholder="Employee index (leave blank for next)"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <input
                        value={employeeWallet}
                        onChange={(e) => setEmployeeWallet(e.target.value)}
                        placeholder="Employee wallet (identity)"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <div className="text-xs text-[var(--app-muted)]">
                        This is the employee’s identity wallet. The payout destination is chosen by the employee at claim time.
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="flex flex-wrap gap-2">
                          {(['per_second', 'hourly', 'weekly', 'biweekly', 'monthly'] as PayPreset[]).map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setPayPreset(preset)}
                              className={`expensee-chip ${payPreset === preset ? 'active' : ''}`}
                            >
                              {payPresetLabel[preset]}
                            </button>
                          ))}
                        </div>
                        <select
                          value={payPreset}
                          onChange={(e) => setPayPreset(e.target.value as PayPreset)}
                          className="w-full rounded-lg border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm"
                        >
                          {(['per_second', 'hourly', 'weekly', 'biweekly', 'monthly'] as PayPreset[]).map((preset) => (
                            <option key={preset} value={preset}>
                              {payPresetLabel[preset]}
                            </option>
                          ))}
                        </select>
                        <input
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.target.value)}
                          placeholder={payAmountLabel[payPreset]}
                          className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="text-xs text-[var(--app-muted)]">
                        We convert this to a per‑second rate on‑chain. {resolvedPerSecondDisplay
                          ? `Current rate: ${resolvedPerSecondDisplay} USDC/sec.`
                          : 'Enter a valid amount to preview the per‑second rate.'}
                      </div>
                      <AdvancedDetails title="Contract window (optional)">
                        <div className="grid gap-3 md:grid-cols-2">
                          <input
                            type="datetime-local"
                            value={periodStartLocal}
                            onChange={(e) => setPeriodStart(fromDateTimeLocal(e.target.value))}
                            className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                          />
                          <input
                            type="datetime-local"
                            value={periodEndLocal}
                            onChange={(e) => setPeriodEnd(fromDateTimeLocal(e.target.value))}
                            className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                          />
                        </div>
                        <div className="text-xs text-[var(--app-muted)] mt-2">
                          Leave empty to start now / keep it open‑ended. Pay stops after the end time.
                        </div>
                        {advancedEnabled ? (
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <input
                              value={periodStart}
                              onChange={(e) => setPeriodStart(e.target.value)}
                              placeholder="Start time (Unix seconds)"
                              className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                            />
                            <input
                              value={periodEnd}
                              onChange={(e) => setPeriodEnd(e.target.value)}
                              placeholder="End time (Unix seconds)"
                              className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                            />
                          </div>
                        ) : null}
                      </AdvancedDetails>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            if (!businessPda) {
                              setError('Business index is required.');
                              return;
                            }
                            const walletKey = employeeWallet
                              ? mustPubkey('employee wallet', employeeWallet)
                              : wallet.publicKey;
                            if (!walletKey) throw new Error('Connect wallet or enter employee wallet');
                            const result = await runAction('Add employee', () => {
                              if (!streamConfig) {
                                throw new Error('Payroll settings not initialized yet. Please retry in a moment.');
                              }
                              const perSecond = resolvedPerSecond || salaryPerSecond;
                              if (!perSecond) throw new Error('Pay rate is required.');
                              const salary = parseUiAmount('salary per second', perSecond);
                              const start = Number(periodStart || '0');
                              const end = Number(periodEnd || '0');
                              // Calculate required deposit for private solvency check
                              const dur = end > start ? BigInt(end - start) : 0n;
                              const reqDeposit = dur > 0n ? salary * dur : 0n;
                              return addEmployeeV4(connection, wallet, businessPda, walletKey, salary, start, end, reqDeposit);
                            });
                            const createdIndex =
                              result && typeof result === 'object' && 'employeeIndex' in result
                                ? Number((result as any).employeeIndex)
                                : employeeIndex;
                            if (createdIndex !== null && Number.isFinite(createdIndex)) {
                              setEmployeeIndexInput(String(createdIndex));
                              // Generate invite link for the employee
                              const biVal = businessIndex ?? 0;
                              const origin = typeof window !== 'undefined' ? window.location.origin : '';
                              setInviteLink(`${origin}/employee?bi=${biVal}&ei=${createdIndex}`);
                            }
                            const addTxid =
                              result && typeof result === 'object' && 'txid' in result
                                ? String((result as any).txid)
                                : '';
                            let solvency: boolean | null = null;
                            if (addTxid) {
                              setSolvencyStatus('unknown');
                              setSolvencyMessage('');
                              solvency = await resolveSolvencyFromTx(addTxid);
                              if (solvency === false) {
                                setSolvencyStatus('insolvent');
                                setSolvencyMessage(
                                  'Insufficient funds — employee created but salary is paused. Deposit funds and update salary rate to activate.'
                                );
                              } else if (solvency === true) {
                                setSolvencyStatus('solvent');
                              }
                            }
                            if (businessIndex !== null && createdIndex !== null) {
                              if (solvency === false) {
                                await refreshEmployee();
                                return;
                              }
                              const delegationResult = await runAction('Auto-enable high-speed mode', () => {
                                const validator = getMagicblockValidatorForRegion(delegateRegion);
                              return delegateStreamV4(
                                connection,
                                wallet,
                                businessIndex,
                                createdIndex,
                                walletKey,
                                validator
                              ).then(async (sig) => {
                                await scheduleCrankOnEr(delegateRegion, businessIndex, createdIndex);
                                return sig;
                              });
                            });
                              if (!delegationResult) {
                                setError('⚠️ MagicBlock delegation failed. Stream is NOT real-time. Please retry delegation manually.');
                                await refreshDelegation();
                                await refreshEmployee();
                                return;
                              }
                              await waitForDelegationStatus(true, 'Delegating stream');
                            }
                            if (businessPda && createdIndex !== null) {
                              try {
                                const history = await getRateHistoryV4Account(connection, businessPda, createdIndex);
                                if (!history) {
                                  await runAction('Init rate history', () =>
                                    initRateHistoryV4(connection, wallet, businessPda, createdIndex)
                                  );
                                }
                              } catch (e: any) {
                                setError(e?.message || 'Failed to initialize rate history');
                              } finally {
                                await refreshRateHistory();
                              }
                            }
                            await refreshEmployee();
                          }}
                          disabled={busy || !businessPda}
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Add Employee
                        </button>
                        {solvencyChecking ? (
                          <div className="w-full text-xs text-[var(--app-muted)]">Checking solvency…</div>
                        ) : null}
                        {solvencyStatus === 'solvent' ? (
                          <div className="w-full text-xs text-emerald-400">
                            Solvency check: OK — stream is active.
                          </div>
                        ) : null}
                        {solvencyStatus === 'insolvent' ? (
                          <div className="w-full text-xs text-amber-400">
                            {solvencyMessage ||
                              'Insufficient funds — employee created but salary is paused. Deposit funds and update salary rate to activate.'}
                          </div>
                        ) : null}
                        {(inviteLink || (businessIndex !== null && employeeIndex !== null && employee)) && (
                          <div className="w-full mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4">
                            <div className="text-xs font-semibold uppercase tracking-widest text-emerald-400 mb-2">Employee Invite Link</div>
                            <div className="flex items-center gap-2">
                              <input
                                value={inviteLink || (typeof window !== 'undefined' ? `${window.location.origin}/employee?bi=${businessIndex}&ei=${employeeIndex}` : '')}
                                readOnly
                                className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2 text-xs font-mono text-[var(--app-ink)]"
                              />
                              <button
                                onClick={() => {
                                  const linkToCopy = inviteLink || (typeof window !== 'undefined' ? `${window.location.origin}/employee?bi=${businessIndex}&ei=${employeeIndex}` : '');
                                  navigator.clipboard.writeText(linkToCopy);
                                  setMessage('Invite link copied!');
                                }}
                                className="premium-btn premium-btn-secondary whitespace-nowrap"
                              >
                                📋 Copy
                              </button>
                            </div>
                            <p className="mt-2 text-xs text-[var(--app-muted)]">Share this link with your employee. They open it, connect their wallet, and they&#39;re ready to go.</p>
                          </div>
                        )}
                        <button
                          onClick={() => void refreshEmployee()}
                          disabled={busy || !businessPda || employeeIndex === null}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Refresh
                        </button>
                      </div>
                      <div className="mt-6 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4">
                        <div className="text-xs font-semibold uppercase tracking-widest text-[var(--app-muted)]">
                          Salary Rate Updates
                        </div>
                        <p className="mt-2 text-sm text-[var(--app-muted)]">
                          Update the encrypted salary rate (requires undelegated stream).
                        </p>
                        <div className="mt-3 space-y-3">
                          <input
                            value={salaryUpdateInput}
                            onChange={(e) => setSalaryUpdateInput(e.target.value)}
                            placeholder="New salary per second (USDC)"
                            className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={async () => {
                                if (!businessPda || employeeIndex === null) {
                                  setError('Business and employee index are required.');
                                  return;
                                }
                                await runAction('Init rate history', () =>
                                  initRateHistoryV4(connection, wallet, businessPda, employeeIndex)
                                );
                                await refreshRateHistory();
                              }}
                              disabled={busy || !businessPda || employeeIndex === null}
                              className="premium-btn premium-btn-secondary disabled:opacity-50"
                            >
                              Init Rate History
                            </button>
                            <button
                              onClick={async () => {
                                if (!businessPda || employeeIndex === null || businessIndex === null) {
                                  setError('Business and employee index are required.');
                                  return;
                                }
                                if (!salaryUpdateInput.trim()) {
                                  setError('Enter a new salary per second.');
                                  return;
                                }
                                // Step 1: If currently delegated, commit+undelegate first so base layer can write
                                const wasDelegate = isDelegated;
                                if (wasDelegate) {
                                  const commitResult = await runAction('Commit stream (required for rate update)', () =>
                                    commitAndUndelegateStreamV4(
                                      new Connection(getMagicblockEndpointForRegion(delegateRegion)),
                                      wallet,
                                      businessIndex,
                                      employeeIndex
                                    )
                                  );
                                  if (!commitResult) {
                                    setError('⚠️ Failed to commit stream. Cannot update salary rate while delegated.');
                                    return;
                                  }
                                  await refreshDelegation();
                                }
                                // Step 2: Init rate history if missing
                                if (!rateHistoryExists) {
                                  await runAction('Init rate history', () =>
                                    initRateHistoryV4(connection, wallet, businessPda, employeeIndex)
                                  );
                                }
                                // Step 3: Update salary rate on base layer
                                const salaryLamports = parseUiAmount('salary update', salaryUpdateInput);
                                // Calculate required deposit for solvency check
                                const pEnd = Number(periodEnd || '0');
                                const now = Math.floor(Date.now() / 1000);
                                const remaining = pEnd > now ? BigInt(pEnd - now) : 0n;
                                const reqDep = remaining > 0n ? salaryLamports * remaining : 0n;
                                const updateResult = await runAction('Update salary rate', () =>
                                  updateSalaryRateV4(connection, wallet, businessPda, employeeIndex, salaryLamports, reqDep)
                                );
                                if (!updateResult) {
                                  await refreshEmployee();
                                  return;
                                }
                                setSolvencyStatus('unknown');
                                setSolvencyMessage('');
                                const solvency = await resolveSolvencyFromTx(String(updateResult));
                                if (solvency === false) {
                                  setSolvencyStatus('insolvent');
                                  setSolvencyMessage(
                                    'Insufficient funds — salary update parked. Deposit funds and retry to activate.'
                                  );
                                  await refreshEmployee();
                                  await refreshRateHistory();
                                  await refreshDelegation();
                                  return;
                                }
                                if (solvency === true) {
                                  setSolvencyStatus('solvent');
                                }
                                // Step 4: Re-delegate immediately so real-time streaming resumes
                                if (wasDelegate && employeeWallet.trim()) {
                                  const validator = getMagicblockValidatorForRegion(delegateRegion);
                                const redelegateResult = await runAction('Re-delegate stream (resume real-time)', () =>
                                  delegateStreamV4(
                                    connection,
                                    wallet,
                                    businessIndex,
                                    employeeIndex,
                                      mustPubkey('employee wallet', employeeWallet),
                                      validator
                                    ).then(async (sig) => {
                                      await scheduleCrankOnEr(delegateRegion, businessIndex, employeeIndex);
                                      return sig;
                                    })
                                  );
                                  if (!redelegateResult) {
                                    setError('⚠️ Salary rate updated but re-delegation failed. Please redelegate manually.');
                                  }
                                }
                                await refreshEmployee();
                                await refreshRateHistory();
                                if (wasDelegate) {
                                  await waitForDelegationStatus(true, 'Re-delegating stream');
                                } else {
                                  await refreshDelegation();
                                }
                              }}
                              disabled={busy || !businessPda || employeeIndex === null}
                              className="premium-btn premium-btn-primary disabled:opacity-50"
                            >
                              Update Salary Rate
                            </button>
                          </div>
                          <div className="text-xs text-[var(--app-muted)]">
                            Rate history: {rateHistoryLoading ? 'checking…' : rateHistoryExists ? 'ready' : 'missing'}
                          </div>
                        </div>
                      </div>
                      {advancedEnabled ? (
                        <AdvancedDetails title="Technical details">
                          {employee ? (
                            <div className="text-xs text-[var(--app-muted)]">
                              Employee active: {employee.isActive ? 'yes' : 'no'} · Last settle: {employee.lastSettleTime}
                            </div>
                          ) : null}
                          <div className="text-xs text-[var(--app-muted)] break-all">
                            Employee PDA: {employeePda ? employeePda.toBase58() : '—'}
                          </div>
                        </AdvancedDetails>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-6 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4">
                    <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--app-muted)]">High-Speed Mode (MagicBlock — Required)</h2>
                    <p className="mt-1 text-sm text-[var(--app-muted)]">
                      Delegation to MagicBlock ER is required for real-time streaming. Withdrawals are employee-triggered.
                    </p>
                    <div className="mt-4 space-y-3">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--app-muted)]">
                        <span className="uppercase tracking-wider text-[10px] font-semibold text-[var(--app-muted)]">Execution mode</span>
                        <StatusPill tone={executionTone}>{executionLabel}</StatusPill>
                        <span className="text-[var(--app-muted)]">Validator:</span>
                        <span className="font-mono text-[var(--app-ink)]">{selectedValidator.toBase58()}</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <select
                          value={delegateRegion}
                          onChange={(e) => setDelegateRegion(e.target.value as MagicblockValidatorRegion)}
                          className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                        >
                          <option value="eu">EU Validator (default)</option>
                          <option value="us" disabled={!usValidatorAvailable}>
                            US Validator {usValidatorAvailable ? '' : '(set env)'}
                          </option>
                          <option value="asia" disabled={!asiaValidatorAvailable}>
                            Asia Validator {asiaValidatorAvailable ? '' : '(set env)'}
                          </option>
                        </select>
                        <div className="text-xs text-[var(--app-muted)] flex items-center">
                          Delegated: {isDelegated === null ? 'unknown' : isDelegated ? 'yes' : 'no'}
                        </div>
                        <div className="text-xs text-[var(--app-muted)] flex items-center">
                          Crank scheduled: {crankScheduleStatus === 'yes' ? 'yes' : crankScheduleStatus === 'no' ? 'no' : 'unknown'}
                        </div>
                      </div>
                      {crankScheduleInfo ? (
                        <div className="text-xs text-[var(--app-muted)]">
                          Last scheduled: {crankScheduleInfo.scheduledAt} · Task ID: {crankScheduleInfo.taskId}
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--app-muted)]">
                        <span className="text-[var(--app-muted)]">TEE token:</span>
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
                          {teeStatus === 'ready' ? 'Refresh auth' : 'Authorize TEE'}
                        </button>
                      </div>
                      <div className="text-xs text-[var(--app-muted)]">
                        Default ER region: {preferredRegion.toUpperCase()} (set{' '}
                        <span className="font-mono">NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_REGION</span> to override).
                      </div>
                      {(!usValidatorAvailable || !asiaValidatorAvailable) ? (
                        <div className="text-xs text-[var(--app-muted)]">
                          Enable additional ER regions by setting{' '}
                          <span className="font-mono">NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_US</span> and/or{' '}
                          <span className="font-mono">NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_ASIA</span>.
                        </div>
                      ) : null}
                      {isTeeValidator ? (
                        <div className="text-xs text-amber-600">
                          Selected validator points to the TEE identity (token-gated on devnet). Prefer an ER validator for general use.
                        </div>
                      ) : null}
                      {delegationStatusMsg ? (
                        <div className="text-xs text-[var(--app-muted)]">{delegationStatusMsg}</div>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            if (businessIndex === null || employeeIndex === null) {
                              setError('Business index + employee index are required.');
                              return;
                            }
                            if (!employeeWallet.trim()) {
                              setError('Employee wallet is required for permission membership.');
                              return;
                            }
                            const validator = getMagicblockValidatorForRegion(delegateRegion);
                            const delegateTx = await runAction('Delegate v4 stream', () =>
                              delegateStreamV4(
                                connection,
                                wallet,
                                businessIndex,
                                employeeIndex,
                                mustPubkey('employee wallet', employeeWallet),
                                validator
                              ).then(async (sig) => {
                                await scheduleCrankOnEr(delegateRegion, businessIndex, employeeIndex);
                                return sig;
                              })
                            );
                            if (delegateTx) {
                              if (typeof delegateTx === 'string') setLastDelegateTx(delegateTx);
                              await waitForDelegationStatus(true, 'Delegating stream');
                            }
                          }}
                          disabled={busy || businessIndex === null || employeeIndex === null || isDelegated === true}
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Delegate
                        </button>
                        <button
                          onClick={async () => {
                            if (businessIndex === null || employeeIndex === null) {
                              setError('Business index + employee index are required.');
                              return;
                            }
                            const undelegateTx = await runAction('Commit + Undelegate', () =>
                              commitAndUndelegateStreamV4(
                                new Connection(getMagicblockEndpointForRegion(delegateRegion)),
                                wallet,
                                businessIndex,
                                employeeIndex
                              )
                            );
                            if (undelegateTx) {
                              if (typeof undelegateTx === 'string') setLastUndelegateTx(undelegateTx);
                              setCrankScheduleInfo(null);
                              setCrankScheduleStatus('no');
                              await waitForDelegationStatus(false, 'Committing and undelegating');
                            }
                          }}
                          disabled={busy || businessIndex === null || employeeIndex === null}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Commit + Undelegate
                        </button>
                        <button
                          onClick={async () => {
                            if (businessIndex === null || employeeIndex === null) {
                              setError('Business index + employee index are required.');
                              return;
                            }
                            const validator = getMagicblockValidatorForRegion(delegateRegion);
                            const redelegateTx = await runAction('Redelegate v4 stream', () =>
                              redelegateStreamV4(connection, wallet, businessIndex, employeeIndex, validator).then(async (sig) => {
                                await scheduleCrankOnEr(delegateRegion, businessIndex, employeeIndex);
                                return sig;
                              })
                            );
                            if (redelegateTx) {
                              if (typeof redelegateTx === 'string') setLastRedelegateTx(redelegateTx);
                              await waitForDelegationStatus(true, 'Re-delegating stream');
                            }
                          }}
                          disabled={busy || businessIndex === null || employeeIndex === null}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Redelegate
                        </button>
                        <button
                          onClick={async () => {
                            if (businessIndex === null || employeeIndex === null) {
                              setError('Business index + employee index are required.');
                              return;
                            }
                            if (!isDelegated) {
                              setError('Stream must be delegated before scheduling the crank.');
                              return;
                            }
                            await runAction('Schedule crank', () =>
                              scheduleCrankOnEr(delegateRegion, businessIndex, employeeIndex)
                            );
                          }}
                          disabled={
                            busy ||
                            businessIndex === null ||
                            employeeIndex === null ||
                            !isDelegated
                          }
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Schedule Crank
                        </button>
                        <button
                          onClick={() => {
                            void refreshDelegation();
                            void checkCrankScheduled();
                          }}
                          disabled={busy || !employeePda}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Refresh Status
                        </button>
                      </div>
                      {(lastDelegateTx || lastUndelegateTx || lastRedelegateTx || lastCrankTx) ? (
                        <div className="mt-3 text-xs text-[var(--app-muted)] space-y-1">
                          {lastCrankTx ? (
                            <div>
                              Last crank tx:{' '}
                              <a
                                href={`https://explorer.solana.com/tx/${lastCrankTx}?cluster=devnet`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-purple-400 underline"
                              >
                                {lastCrankTx.slice(0, 8)}…{lastCrankTx.slice(-6)}
                              </a>
                            </div>
                          ) : null}
                          {lastDelegateTx ? (
                            <div>
                              Last delegate tx:{' '}
                              <a
                                href={`https://explorer.solana.com/tx/${lastDelegateTx}?cluster=devnet`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-emerald-400 underline"
                              >
                                {lastDelegateTx.slice(0, 8)}…{lastDelegateTx.slice(-6)}
                              </a>
                            </div>
                          ) : null}
                          {lastUndelegateTx ? (
                            <div>
                              Last undelegate tx:{' '}
                              <a
                                href={`https://explorer.solana.com/tx/${lastUndelegateTx}?cluster=devnet`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-amber-400 underline"
                              >
                                {lastUndelegateTx.slice(0, 8)}…{lastUndelegateTx.slice(-6)}
                              </a>
                            </div>
                          ) : null}
                          {lastRedelegateTx ? (
                            <div>
                              Last redelegate tx:{' '}
                              <a
                                href={`https://explorer.solana.com/tx/${lastRedelegateTx}?cluster=devnet`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sky-400 underline"
                              >
                                {lastRedelegateTx.slice(0, 8)}…{lastRedelegateTx.slice(-6)}
                              </a>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </StepCard>
              </div>
            ) : null}

            {showStep3 ? (
              <div id="payments" className="expensee-step-wrap">
                <StepCard
                  number={stepNumberMap[3] ?? 3}
                  title="Fund pooled vault"
                  description="Deposit encrypted USDC into the pooled vault and credit your business balance."
                  state={step3State}
                  collapsible={!setupOnly}
                >
                  <div className="panel-card">
                    <h2 className="text-lg font-semibold text-[var(--app-ink)]">Deposit Funds</h2>
                    <div className="mt-4 space-y-3">
                      {!isPoolVaultReady ? (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                          Pool vault not configured yet. Ask the platform admin to initialize the pooled vault.
                        </div>
                      ) : null}
                      {advancedEnabled && wallet.publicKey ? (
                        <AdvancedDetails title="Token registry">
                          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-3 text-xs text-[var(--app-muted)]">
                            <div className="flex items-center justify-between">
                              <span className="font-medium text-[var(--app-ink)]">Token registry</span>
                              <span>
                                {userTokenRegistry && !userTokenRegistry.incoTokenAccount.equals(PublicKey.default)
                                  ? userTokenRegistry.incoTokenAccount.toBase58()
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
                                  const depositor = mustPubkey('depositor token account', depositorTokenAccount);
                                  await runAction('Link depositor token', () =>
                                    linkUserTokenAccountV4(connection, wallet, depositor, PAYUSD_MINT)
                                  );
                                  await refreshUserTokenRegistry();
                                }}
                                disabled={busy || userTokenRegistryLoading || !depositorTokenAccount}
                                className="premium-btn premium-btn-secondary disabled:opacity-50"
                              >
                                Link Depositor Token
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
                        </AdvancedDetails>
                      ) : null}
                      <input
                        value={depositorTokenAccount}
                        onChange={(e) => setDepositorTokenAccount(e.target.value)}
                        placeholder="Depositor token account"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <input
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(e.target.value)}
                        placeholder="Deposit amount (USDC)"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <input
                        value={wrapAmount}
                        onChange={(e) => setWrapAmount(e.target.value)}
                        placeholder="Wrap amount (public USDC)"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <div className="expensee-note">
                        Need USDC? For devnet, get public USDC in Phantom first, then wrap it into confidential USDC
                        before depositing. For quick demos, you can also mint confidential test USDC directly.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={async () => {
                            if (!wallet.publicKey) {
                              setError('Connect wallet first.');
                              return;
                            }
                            const pubkey = wallet.publicKey;
                            const result = await runAction('Create depositor token account', () =>
                              createIncoTokenAccount(connection, wallet, pubkey)
                            );
                            if (result && typeof result === 'object' && 'tokenAccount' in result) {
                              setDepositorTokenAccount((result as any).tokenAccount.toBase58());
                              void refreshDepositorBalance();
                            }
                          }}
                          disabled={busy}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Create Depositor Token
                        </button>
                        <button
                          onClick={async () => {
                            const amountNum = Number(wrapAmount || '0');
                            if (!wallet.publicKey) {
                              setError('Connect wallet first.');
                              return;
                            }
                            if (!depositorTokenAccount) {
                              setError('Create a depositor token account first.');
                              return;
                            }
                            if (!amountNum || amountNum <= 0) {
                              setError('Enter a valid wrap amount.');
                              return;
                            }
                            const publicMintRaw = process.env.NEXT_PUBLIC_PUBLIC_USDC_MINT || '';
                            if (!publicMintRaw || publicMintRaw === EMPTY_PUBKEY) {
                              setError('Public USDC mint not configured.');
                              return;
                            }
                            const publicMint = new PublicKey(publicMintRaw);
                            await runAction('Wrap public USDC → Private', async () => {
                              if (!wallet.publicKey) return;
                              const pubkey = wallet.publicKey;
                              // ── Step 1: Transfer public USDC to escrow ──
                              const userAta = await getAssociatedTokenAddress(publicMint, pubkey);
                              const buildResp = await fetch('/api/bridge/build-wrap-public', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  userPublicKey: pubkey.toBase58(),
                                  userPublicUsdcAta: userAta.toBase58(),
                                  amountUi: amountNum,
                                  publicUsdcMint: publicMint.toBase58(),
                                }),
                              });
                              const buildRaw = await buildResp.text();
                              let buildJson: any = null;
                              try {
                                buildJson = buildRaw ? JSON.parse(buildRaw) : null;
                              } catch {
                                throw new Error(`Wrap build failed (${buildResp.status}): ${buildRaw || 'invalid JSON response'}`);
                              }
                              if (!buildResp.ok || !buildJson?.ok) {
                                throw new Error(buildJson?.error || `Wrap build failed (${buildResp.status})`);
                              }
                              const tx = Transaction.from(Buffer.from(buildJson.txBase64, 'base64'));
                              if (!wallet.signTransaction) {
                                throw new Error('Wallet does not support signTransaction.');
                              }
                              const signed = await wallet.signTransaction(tx);
                              const sig = await connection.sendRawTransaction(signed.serialize(), {
                                skipPreflight: false,
                                maxRetries: 3,
                              });
                              if (tx.recentBlockhash && tx.lastValidBlockHeight) {
                                await connection.confirmTransaction(
                                  {
                                    signature: sig,
                                    blockhash: tx.recentBlockhash,
                                    lastValidBlockHeight: tx.lastValidBlockHeight,
                                  },
                                  'confirmed'
                                );
                              }
                              setLastWrapTx(sig);

                              // ── Step 2: Mint confidential USDC ──
                              const mintResp = await fetch('/api/faucet/mint-payusd', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  userConfidentialTokenAccount: depositorTokenAccount,
                                  amountUi: amountNum,
                                }),
                              });
                              const mintJson = await mintResp.json();
                              if (!mintResp.ok || !mintJson?.ok) {
                                throw new Error(mintJson?.error || 'Confidential mint failed after escrow transfer');
                              }
                              return sig;
                            });
                            void refreshDepositorBalance();
                          }}
                          disabled={busy || !wallet.publicKey || !depositorTokenAccount}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Wrap Public USDC → Private
                        </button>
                        <button
                          onClick={() => void refreshPublicUsdcBalance()}
                          disabled={busy || !wallet.publicKey || publicUsdcBalanceLoading}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          {publicUsdcBalanceLoading ? 'Checking…' : 'Check Public USDC'}
                        </button>
                        <button
                          onClick={async () => {
                            if (!depositorTokenAccount) {
                              setError('Create or paste a depositor token account first.');
                              return;
                            }
                            await runAction('Mint test USDC', async () => {
                              const resp = await fetch('/api/faucet/mint-payusd', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  userConfidentialTokenAccount: depositorTokenAccount,
                                }),
                              });
                              const json = await resp.json();
                              if (!resp.ok || !json?.ok) {
                                throw new Error(json?.error || 'Faucet mint failed');
                              }
                              return json;
                            });
                            void refreshDepositorBalance();
                          }}
                          disabled={busy || !depositorTokenAccount}
                          className="premium-btn premium-btn-secondary disabled:opacity-50"
                        >
                          Mint Test USDC
                        </button>
                        <button
                          onClick={async () => {
                            if (!businessPda) {
                              setError('Business index is required.');
                              return;
                            }
                            if (!isPoolVaultReady) {
                              const ready = await ensurePoolVaultSetup();
                              if (!ready) return;
                            }
                            await runAction('Deposit to pool', () => {
                              const depositor = mustPubkey('depositor token account', depositorTokenAccount);
                              const poolToken = mustPubkey('pool vault token account', poolVaultTokenAccount || masterVault?.vaultTokenAccount?.toBase58() || '');
                              const amount = parseUiAmount('deposit', depositAmount);
                              return depositV4(connection, wallet, businessPda, depositor, poolToken, amount);
                            });
                            setVaultFundingObserved(true);
                            void refreshDepositorBalance();
                          }}
                          disabled={busy || !businessPda || !depositorTokenAccount}
                          className="premium-btn premium-btn-primary disabled:opacity-50"
                        >
                          Deposit
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-muted)]">
                        <span>Public USDC (wallet): {publicUsdcBalance ?? '—'}</span>
                        {publicUsdcBalanceError ? (
                          <span className="text-rose-300">{publicUsdcBalanceError}</span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--app-muted)]">
                        <a className="expensee-link" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
                          Open Circle Faucet
                        </a>
                        <span>·</span>
                        <Link className="expensee-link" href="/bridge">
                          Open full bridge
                        </Link>
                        {lastWrapTx ? (
                          <>
                            <span>·</span>
                            <span>Last wrap: {lastWrapTx.slice(0, 8)}...{lastWrapTx.slice(-4)}</span>
                          </>
                        ) : null}
                      </div>
                      {advancedEnabled && masterVault?.vaultTokenAccount ? (
                        <div className="text-xs text-[var(--app-muted)] break-all">
                          Pool vault token: {masterVault.vaultTokenAccount.toBase58()}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </StepCard>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* USER_REQUEST: Removed reports from homepage */}
        {false && showReports ? (
          <section id="reports" className="expensee-section">
            <h3 className="text-lg font-semibold text-[var(--app-ink)]">Reports</h3>
            <p className="text-sm text-[var(--app-muted)]">
              Export payroll activity and compliance summaries. (Coming soon)
            </p>
          </section>
        ) : null}
      </div>
    </ExpenseeShell>
  );
}
