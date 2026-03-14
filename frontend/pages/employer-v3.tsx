import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ActionResult from '../components/ActionResult';
import AgentChat from '../components/AgentChat';
import PageShell from '../components/PageShell';
import {
  PAYUSD_MINT,
  MAGICBLOCK_DELEGATION_PROGRAM,
  addEmployeeV3,
  commitAndUndelegateStreamV3,
  createIncoTokenAccount,
  createVaultTokenAccount,
  delegateStreamV3,
  depositV3,
  getBusinessStreamConfigV3Account,
  getBusinessV3AccountByAddress,
  getBusinessV3PDA,
  getEmployeeV3Account,
  getEmployeeV3PDA,
  getMagicblockValidatorForRegion,
  getMasterVaultV3Account,
  getMasterVaultV3PDA,
  isMagicblockValidatorRegionAvailable,
  MagicblockValidatorRegion,
  redelegateStreamV3,
  getStreamConfigV3PDA,
  getVaultAccount,
  getVaultPDA,
  initMasterVaultV3,
  initStreamConfigV3,
  initVaultV3,
  registerBusinessV3,
  updateKeeperV3,
} from '../lib/payroll-client';

const DEFAULT_KEEPER =
  process.env.NEXT_PUBLIC_DEFAULT_KEEPER_PUBKEY?.trim() ||
  process.env.NEXT_PUBLIC_KEEPER_PUBKEY?.trim() ||
  '';

const LEGACY_V3_ENABLED = (process.env.NEXT_PUBLIC_ENABLE_LEGACY_V3 || '').toLowerCase() === 'true';

type PayPreset = 'per_second' | 'hourly' | 'weekly' | 'monthly' | 'fixed_total';
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

function parseUiAmount(label: string, value: string): bigint {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label} amount`);
  return BigInt(Math.floor(n * 1_000_000_000));
}

function presetToPerSecond(preset: PayPreset, amount: number, days?: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (preset === 'per_second') return amount;
  if (preset === 'hourly') return amount / 3600;
  if (preset === 'weekly') return amount / (7 * 24 * 3600);
  if (preset === 'monthly') return amount / (30 * 24 * 3600);
  if (preset === 'fixed_total') {
    const totalDays = days && Number.isFinite(days) && days > 0 ? days : 1;
    return amount / (totalDays * 24 * 3600);
  }
  return null;
}

export default function EmployerV3Page() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [lastTx, setLastTx] = useState<{ label: string; sig: string } | null>(null);

  const [businessIndexInput, setBusinessIndexInput] = useState('0');
  const [employeeIndexInput, setEmployeeIndexInput] = useState('0');
  const [keeperPubkey, setKeeperPubkey] = useState(DEFAULT_KEEPER);
  const [settleIntervalSecs, setSettleIntervalSecs] = useState('10');
  const [employeeWallet, setEmployeeWallet] = useState('');
  const [salaryPerSecond, setSalaryPerSecond] = useState('0.0001');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [vaultTokenAccount, setVaultTokenAccount] = useState('');
  const [depositorTokenAccount, setDepositorTokenAccount] = useState('');
  const [depositAmount, setDepositAmount] = useState('10');
  const [delegateRegion, setDelegateRegion] = useState<MagicblockValidatorRegion>('eu');
  const [isDelegated, setIsDelegated] = useState<boolean | null>(null);

  const [masterVault, setMasterVault] = useState<Awaited<ReturnType<typeof getMasterVaultV3Account>>>(null);
  const [business, setBusiness] = useState<Awaited<ReturnType<typeof getBusinessV3AccountByAddress>>>(null);
  const [streamConfig, setStreamConfig] = useState<Awaited<ReturnType<typeof getBusinessStreamConfigV3Account>>>(null);
  const [employee, setEmployee] = useState<Awaited<ReturnType<typeof getEmployeeV3Account>>>(null);
  const [vaultAccount, setVaultAccount] = useState<Awaited<ReturnType<typeof getVaultAccount>>>(null);
  const [vaultFundingObserved, setVaultFundingObserved] = useState(false);

  const [agentMessages, setAgentMessages] = useState<any[]>([]);
  const [agentPhase, setAgentPhase] = useState<string>('greeting');
  const [agentQueue, setAgentQueue] = useState<AgentExecutionStep[]>([]);
  const [agentExecuteBusy, setAgentExecuteBusy] = useState(false);
  const [agentEnableHighSpeed, setAgentEnableHighSpeed] = useState(true);
  const [agentApprovalMode, setAgentApprovalMode] = useState<AgentApprovalMode>('high_risk_only');
  const [agentRunHydrated, setAgentRunHydrated] = useState(false);
  const [autoGrantKeeperDecrypt, setAutoGrantKeeperDecrypt] = useState(true);
  const [boundPresetPeriod, setBoundPresetPeriod] = useState(true);
  const runIdRef = useRef(0);

  const businessIndex = useMemo(() => parseIndex(businessIndexInput), [businessIndexInput]);
  const employeeIndex = useMemo(() => parseIndex(employeeIndexInput), [employeeIndexInput]);

  const [masterVaultPda] = useMemo(() => getMasterVaultV3PDA(), []);
  const businessPda = useMemo(() => {
    if (businessIndex === null) return null;
    return getBusinessV3PDA(masterVaultPda, businessIndex)[0];
  }, [businessIndex, masterVaultPda]);
  const employeePda = useMemo(() => {
    if (!businessPda || employeeIndex === null) return null;
    return getEmployeeV3PDA(businessPda, employeeIndex)[0];
  }, [businessPda, employeeIndex]);
  const streamConfigPda = useMemo(() => {
    if (!businessPda) return null;
    return getStreamConfigV3PDA(businessPda)[0];
  }, [businessPda]);
  const vaultPda = useMemo(() => {
    if (!businessPda) return null;
    return getVaultPDA(businessPda)[0];
  }, [businessPda]);

  const businessExists = !!business;
  const vaultExists = !!vaultAccount;
  const configExists = !!streamConfig;
  const keeperMismatch = Boolean(
    streamConfig &&
      keeperPubkey &&
      streamConfig.keeperPubkey.toBase58() !== keeperPubkey.trim()
  );
  const payPreset: PayPreset = 'per_second';
  const payAmount = salaryPerSecond;
  const streamIndex = employeeIndex;

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

  const refreshMaster = async () => {
    await runAction('Refresh master vault', async () => {
      const account = await getMasterVaultV3Account(connection);
      setMasterVault(account);
      return account;
    });
  };

  const refreshBusiness = async () => {
    if (!businessPda) {
      setError('Business index is required.');
      return;
    }
    await runAction('Refresh business', async () => {
      const account = await getBusinessV3AccountByAddress(connection, businessPda);
      setBusiness(account);
      return account;
    });
  };

  const refreshVault = async () => {
    if (!businessPda) {
      setError('Business index is required.');
      return;
    }
    await runAction('Refresh vault', async () => {
      const account = await getVaultAccount(connection, businessPda);
      setVaultAccount(account);
      if (account?.tokenAccount && !vaultTokenAccount) {
        setVaultTokenAccount(account.tokenAccount.toBase58());
      }
      return account;
    });
  };

  const refreshStreamConfig = async () => {
    if (!businessPda) {
      setError('Business index is required.');
      return;
    }
    await runAction('Refresh stream config', async () => {
      const account = await getBusinessStreamConfigV3Account(connection, businessPda);
      setStreamConfig(account);
      return account;
    });
  };

  const refreshEmployee = async () => {
    if (!businessPda || employeeIndex === null) {
      setError('Business index + employee index are required.');
      return;
    }
    await runAction('Refresh employee', async () => {
      const account = await getEmployeeV3Account(connection, businessPda, employeeIndex);
      setEmployee(account);
      if (account) {
        setIsDelegated(account.isDelegated);
      }
      return account;
    });
  };

  const refreshDelegation = async () => {
    if (!employeePda) {
      setError('Business index + employee index are required.');
      return;
    }
    await runAction('Refresh delegation status', async () => {
      const info = await connection.getAccountInfo(employeePda, 'confirmed');
      if (!info) {
        setIsDelegated(null);
        throw new Error('Employee v3 account not found');
      }
      setIsDelegated(info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM));
      return info;
    });
  };

  const loadState = useCallback(async () => {
    if (!wallet.connected) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const master = await getMasterVaultV3Account(connection);
      setMasterVault(master);
      if (businessPda) {
        const businessAccount = await getBusinessV3AccountByAddress(connection, businessPda);
        setBusiness(businessAccount);
        const vaultAccount = await getVaultAccount(connection, businessPda);
        setVaultAccount(vaultAccount);
        if (vaultAccount?.tokenAccount && !vaultTokenAccount) {
          setVaultTokenAccount(vaultAccount.tokenAccount.toBase58());
        }
        const cfg = await getBusinessStreamConfigV3Account(connection, businessPda);
        setStreamConfig(cfg);
      }
      if (businessPda && employeeIndex !== null) {
        const employeeAccount = await getEmployeeV3Account(connection, businessPda, employeeIndex);
        setEmployee(employeeAccount);
      }
      if (employeePda) {
        const info = await connection.getAccountInfo(employeePda, 'confirmed');
        if (info) {
          setIsDelegated(info.owner.equals(MAGICBLOCK_DELEGATION_PROGRAM));
        } else {
          setIsDelegated(null);
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh state');
    } finally {
      setBusy(false);
    }
  }, [
    businessPda,
    connection,
    employeeIndex,
    employeePda,
    vaultTokenAccount,
    wallet.connected,
  ]);

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
      label: 'Initialize global master vault',
      status: masterVault ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    steps.push({
      key: 'register-business',
      label: 'Register business (index-based)',
      status: businessExists ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    if (!vaultTokenAccount || !vaultExists) {
      steps.push({
        key: 'create-vault-pda-token',
        label: 'Create encrypted payroll vault token account',
        status: vaultTokenAccount && vaultExists ? 'done' : 'pending',
        required: true,
        risk: 'review',
        requiresSignature: true,
      });
    }

    steps.push({
      key: 'init-vault',
      label: 'Authorize vault for payroll',
      status: vaultExists ? 'done' : 'pending',
      required: true,
      risk: 'high_risk',
      requiresSignature: true,
    });

    if (!streamConfig) {
      steps.push({
        key: 'init-automation',
        label: 'Initialize automation (keeper + cadence)',
        status: 'pending',
        required: true,
        risk: 'high_risk',
        requiresSignature: true,
      });
    } else if (keeperMismatch) {
      steps.push({
        key: 'update-keeper',
        label: 'Update automation keeper wallet',
        status: 'pending',
        required: true,
        risk: 'review',
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

    if (agentEnableHighSpeed) {
      steps.push({
        key: 'enable-high-speed',
        label: 'Enable high-speed mode (MagicBlock delegation)',
        status: isDelegated ? 'done' : 'pending',
        required: false,
        risk: 'review',
        requiresSignature: true,
      });
    }

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
      label: 'Deposit funds into the vault',
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
    keeperMismatch,
    masterVault,
    streamConfig,
    vaultExists,
    vaultFundingObserved,
    vaultTokenAccount,
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
              if (mode === 'next') return { ...step, status: 'done', detail: 'Status refreshed' };
              continue;
            }

            if (step.key === 'init-master-vault') {
              const res = await initMasterVaultV3(connection, wallet);
              txid = res.txid;
            } else if (step.key === 'register-business') {
              const res = await registerBusinessV3(connection, wallet);
              txid = res.txid;
              if (res.businessIndex !== undefined) {
                setBusinessIndexInput(String(res.businessIndex));
              }
            } else if (step.key === 'create-vault-pda-token') {
              if (!vaultPda) throw new Error('Business index required to derive vault PDA.');
              const res = await createVaultTokenAccount(connection, wallet, vaultPda, PAYUSD_MINT);
              txid = (res as any)?.txid;
              const tokenAccount = (res as any)?.tokenAccount;
              if (tokenAccount) setVaultTokenAccount(tokenAccount.toBase58());
            } else if (step.key === 'init-vault') {
              if (!businessPda) throw new Error('Business index required.');
              const token = mustPubkey('vault token account', vaultTokenAccount);
              const res = await initVaultV3(connection, wallet, businessPda, token, PAYUSD_MINT);
              txid = res.txid;
            } else if (step.key === 'init-automation') {
              if (!businessPda) throw new Error('Business index required.');
              const keeper = mustPubkey('keeper', keeperPubkey);
              const interval = Number(settleIntervalSecs);
              if (!Number.isFinite(interval) || interval <= 0) throw new Error('Invalid settle interval');
              txid = await initStreamConfigV3(connection, wallet, businessPda, keeper, interval);
            } else if (step.key === 'update-keeper') {
              if (!businessPda) throw new Error('Business index required.');
              const keeper = mustPubkey('keeper', keeperPubkey);
              txid = await updateKeeperV3(connection, wallet, businessPda, keeper);
            } else if (step.key === 'create-worker-record') {
              if (!businessPda) throw new Error('Business index required.');
              if (!employeeWallet.trim()) throw new Error('Employee wallet is required.');
              const salaryLamports = parseUiAmount('salary per second', salaryPerSecond);
              const periodStartValue = Number(periodStart || '0') || 0;
              const periodEndValue = Number(periodEnd || '0') || 0;
              const res = await addEmployeeV3(
                connection,
                wallet,
                businessPda,
                mustPubkey('employee wallet', employeeWallet),
                salaryLamports,
                periodStartValue,
                periodEndValue
              );
              txid = res.txid;
              if (res.employeeIndex !== undefined) {
                setEmployeeIndexInput(String(res.employeeIndex));
              }
            } else if (step.key === 'enable-high-speed') {
              if (businessIndex === null || employeeIndex === null) {
                throw new Error('Business index + employee index are required.');
              }
              const validator = getMagicblockValidatorForRegion(delegateRegion);
              await delegateStreamV3(connection, wallet, businessIndex, employeeIndex, validator);
            } else if (step.key === 'create-depositor-token') {
              if (!wallet.publicKey) throw new Error('Wallet not connected.');
              const res = await createIncoTokenAccount(connection, wallet, wallet.publicKey, PAYUSD_MINT);
              txid = (res as any)?.txid;
              const tokenAccount = (res as any)?.tokenAccount;
              if (tokenAccount) setDepositorTokenAccount(tokenAccount.toBase58());
            } else if (step.key === 'deposit-funds') {
              if (!businessPda) throw new Error('Business index is required.');
              if (!depositorTokenAccount.trim() || !vaultTokenAccount.trim()) {
                throw new Error('Depositor + vault token accounts are required.');
              }
              const amountLamports = parseUiAmount('deposit', depositAmount);
              await depositV3(
                connection,
                wallet,
                businessPda,
                mustPubkey('depositor token account', depositorTokenAccount),
                mustPubkey('vault token account', vaultTokenAccount),
                amountLamports
              );
              setVaultFundingObserved(true);
            }

            await loadState();

            updateStep(step.key, { status: 'done', txid });
            if (txid) setLastTx({ label: step.label, sig: txid });

            if (mode === 'next') {
              return { ...step, status: 'done', txid };
            }
          } catch (e: any) {
            updateStep(step.key, { status: 'failed', detail: e?.message || 'Step failed' });
            throw e;
          }
        }
        return null;
      } catch (e) {
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
      keeperPubkey,
      loadState,
      periodEnd,
      periodStart,
      salaryPerSecond,
      settleIntervalSecs,
      vaultPda,
      vaultTokenAccount,
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
        setSalaryPerSecond(String(plan.salaryPerSecond));
      } else if (plan.payPreset && plan.payAmount) {
        const preset = plan.payPreset as PayPreset;
        const amount = Number(plan.payAmount);
        const days = plan.fixedTotalDays ? Number(plan.fixedTotalDays) : undefined;
        const perSecond = presetToPerSecond(preset, amount, days);
        if (perSecond) setSalaryPerSecond(String(perSecond));
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
    setAgentRunHydrated(true);
    void loadState();
  }, [loadState, wallet.connected]);

  useEffect(() => {
    if (!wallet.connected || agentExecuteBusy) return;
    const queue = buildAgentExecutionQueue();
    setAgentQueue(queue);
  }, [agentExecuteBusy, buildAgentExecutionQueue, wallet.connected]);

  if (!LEGACY_V3_ENABLED) {
    return (
      <PageShell
        icon=""
        title="Expensee"
        subtitle="Employer v3 (disabled)"
        navItems={[
          { href: '/employer', label: 'Employer' },
          { href: '/employee', label: 'Employee' },
        ]}
      >
        <Head>
          <title>Expensee Employer v3 | Disabled</title>
        </Head>
        <section className="panel-card">
          <p className="text-sm text-gray-700">
            Legacy v3 is disabled. Use the v4 employer console at{' '}
            <Link href="/employer" className="underline font-semibold">
              /employer
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
      subtitle="Employer v3 (index-based privacy)"
      navItems={[
        { href: '/employer', label: 'Employer' },
        { href: '/employee', label: 'Employee' },
      ]}
    >
      <Head>
        <title>Expensee Employer v3 | Privacy-First Setup</title>
      </Head>

      <div className="space-y-6">
        {!wallet.connected ? (
          <section className="panel-card">
            <p className="text-sm text-gray-700">Connect a wallet to continue.</p>
          </section>
        ) : (
          <>
            <AgentChat
              walletConnected={!!wallet.connected}
              walletAddress={wallet.publicKey?.toBase58() || ''}
              businessExists={businessExists}
              vaultExists={vaultExists}
              configExists={configExists}
              depositorBalance={null}
              vaultBalance={null}
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
              autoGrantKeeperDecrypt={autoGrantKeeperDecrypt}
              setAutoGrantKeeperDecrypt={setAutoGrantKeeperDecrypt}
              boundPresetPeriod={boundPresetPeriod}
              setBoundPresetPeriod={setBoundPresetPeriod}
              scope="employer-v3"
            />

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Master Vault</h2>
              <p className="mt-1 text-sm text-gray-600">
                Initialize the global v3 master vault once per program.
              </p>
              <div className="mt-4 space-y-3">
                <div className="text-xs text-gray-500 break-all">
                  Master vault PDA: {masterVaultPda.toBase58()}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => void runAction('Init master vault', () => initMasterVaultV3(connection, wallet))}
                    disabled={busy}
                    className="premium-btn premium-btn-primary disabled:opacity-50"
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
                {masterVault ? (
                  <div className="text-xs text-gray-600">
                    Next business index: {masterVault.nextBusinessIndex} · Active: {masterVault.isActive ? 'yes' : 'no'}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Business Registry</h2>
              <p className="mt-1 text-sm text-gray-600">
                Register a privacy-first business record. The index is used for all v3 PDAs.
              </p>
              <div className="mt-4 space-y-3">
                <input
                  value={businessIndexInput}
                  onChange={(e) => setBusinessIndexInput(e.target.value)}
                  placeholder="Business index (leave 0 for new)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="text-xs text-gray-500 break-all">
                  Business PDA: {businessPda ? businessPda.toBase58() : '—'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      const result = await runAction('Register business', () => registerBusinessV3(connection, wallet));
                      if (result && typeof result === 'object' && 'businessIndex' in result) {
                        setBusinessIndexInput(String((result as any).businessIndex));
                      }
                      await refreshBusiness();
                    }}
                    disabled={busy}
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
                {business ? (
                  <div className="text-xs text-gray-600">
                    Next employee index: {business.nextEmployeeIndex} · Active: {business.isActive ? 'yes' : 'no'}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Vault + Stream Config</h2>
              <p className="mt-1 text-sm text-gray-600">
                Initialize the vault token account and configure the keeper cadence.
              </p>
              <div className="mt-4 space-y-3">
                <div className="text-xs text-gray-500 break-all">
                  Vault PDA: {vaultPda ? vaultPda.toBase58() : '—'}
                </div>
                <div className="text-xs text-gray-500 break-all">
                  Stream config PDA: {streamConfigPda ? streamConfigPda.toBase58() : '—'}
                </div>
                <input
                  value={vaultTokenAccount}
                  onChange={(e) => setVaultTokenAccount(e.target.value)}
                  placeholder="Vault token account (confidential)"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!vaultPda) {
                        setError('Business index required to derive vault PDA.');
                        return;
                      }
                      const res = await runAction('Create vault token account', () =>
                        createVaultTokenAccount(connection, wallet, vaultPda, PAYUSD_MINT)
                      );
                      if (res && typeof res === 'object' && 'tokenAccount' in res) {
                        setVaultTokenAccount((res as any).tokenAccount.toBase58());
                      }
                      if (businessPda) {
                        const vault = await getVaultAccount(connection, businessPda);
                        setVaultAccount(vault);
                        if (vault?.tokenAccount) {
                          setVaultTokenAccount(vault.tokenAccount.toBase58());
                        }
                      }
                    }}
                    disabled={busy || !vaultPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Create Vault Token Account
                  </button>
                  <button
                    onClick={async () => {
                      if (!businessPda) return;
                      const vault = await getVaultAccount(connection, businessPda);
                      setVaultAccount(vault);
                      if (vault?.tokenAccount) {
                        setVaultTokenAccount(vault.tokenAccount.toBase58());
                      }
                    }}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Load Vault Token
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!businessPda || !vaultTokenAccount.trim()) {
                        setError('Business index + vault token account are required.');
                        return;
                      }
                      await runAction('Init vault', () =>
                        initVaultV3(
                          connection,
                          wallet,
                          businessPda,
                          mustPubkey('vault token account', vaultTokenAccount),
                          PAYUSD_MINT
                        )
                      );
                      await refreshVault();
                    }}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Init Vault
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={keeperPubkey}
                    onChange={(e) => setKeeperPubkey(e.target.value)}
                    placeholder="Keeper pubkey"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={settleIntervalSecs}
                    onChange={(e) => setSettleIntervalSecs(e.target.value)}
                    placeholder="Settle interval (secs)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      if (!businessPda || !keeperPubkey.trim()) {
                        setError('Business index + keeper pubkey are required.');
                        return;
                      }
                      return runAction('Init stream config', () =>
                        initStreamConfigV3(
                          connection,
                          wallet,
                          businessPda,
                          mustPubkey('keeper', keeperPubkey),
                          Number(settleIntervalSecs || '0')
                        )
                      );
                    }}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Init Stream Config
                  </button>
                  <button
                    onClick={() => {
                      if (!businessPda || !keeperPubkey.trim()) {
                        setError('Business index + keeper pubkey are required.');
                        return;
                      }
                      return runAction('Update keeper', () =>
                        updateKeeperV3(connection, wallet, businessPda, mustPubkey('keeper', keeperPubkey))
                      );
                    }}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Update Keeper
                  </button>
                  <button
                    onClick={() => void refreshStreamConfig()}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Refresh Config
                  </button>
                </div>
                {streamConfig ? (
                  <div className="text-xs text-gray-600">
                    Keeper: {streamConfig.keeperPubkey.toBase58()} · Interval: {streamConfig.settleIntervalSecs}s
                  </div>
                ) : null}
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Employee Record</h2>
              <p className="mt-1 text-sm text-gray-600">
                Create a privacy-first employee entry (index-based PDA).
              </p>
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={employeeWallet}
                    onChange={(e) => setEmployeeWallet(e.target.value)}
                    placeholder="Employee wallet pubkey"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={employeeIndexInput}
                    onChange={(e) => setEmployeeIndexInput(e.target.value)}
                    placeholder="Employee index (leave 0 for new)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <input
                    value={salaryPerSecond}
                    onChange={(e) => setSalaryPerSecond(e.target.value)}
                    placeholder="Salary per second (USDC)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={periodStart}
                    onChange={(e) => setPeriodStart(e.target.value)}
                    placeholder="Period start (unix, optional)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={periodEnd}
                    onChange={(e) => setPeriodEnd(e.target.value)}
                    placeholder="Period end (unix, optional)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="text-xs text-gray-500 break-all">
                  Employee PDA: {employeePda ? employeePda.toBase58() : '—'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!businessPda) {
                        setError('Business index is required.');
                        return;
                      }
                      if (!employeeWallet.trim()) {
                        setError('Employee wallet is required.');
                        return;
                      }
                      const salaryLamports = parseUiAmount('salary per second', salaryPerSecond);
                      const periodStartValue = Number(periodStart || '0') || 0;
                      const periodEndValue = Number(periodEnd || '0') || 0;
                      const res = await runAction('Add employee', () =>
                        addEmployeeV3(
                          connection,
                          wallet,
                          businessPda,
                          mustPubkey('employee wallet', employeeWallet),
                          salaryLamports,
                          periodStartValue,
                          periodEndValue
                        )
                      );
                      if (res && typeof res === 'object' && 'employeeIndex' in res) {
                        setEmployeeIndexInput(String((res as any).employeeIndex));
                      }
                      await refreshEmployee();
                    }}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Add Employee
                  </button>
                  <button
                    onClick={() => void refreshEmployee()}
                    disabled={busy || !businessPda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Refresh
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
              <h2 className="text-lg font-semibold text-[#2D2D2A]">High-Speed Mode (MagicBlock)</h2>
              <p className="mt-1 text-sm text-gray-600">
                Delegate a v3 stream to MagicBlock ER for faster execution. Keeper will commit+undelegate on withdraw.
              </p>
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <select
                    value={delegateRegion}
                    onChange={(e) => setDelegateRegion(e.target.value as MagicblockValidatorRegion)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="eu">EU Validator</option>
                    <option value="us" disabled={!isMagicblockValidatorRegionAvailable('us')}>
                      US Validator
                    </option>
                    <option value="asia" disabled={!isMagicblockValidatorRegionAvailable('asia')}>
                      Asia Validator
                    </option>
                  </select>
                  <div className="text-xs text-gray-600 flex items-center">
                    Delegated: {isDelegated === null ? 'unknown' : isDelegated ? 'yes' : 'no'}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (businessIndex === null || employeeIndex === null) {
                        setError('Business index + employee index are required.');
                        return;
                      }
                      const validator = getMagicblockValidatorForRegion(delegateRegion);
                      await runAction('Delegate v3 stream', () =>
                        delegateStreamV3(connection, wallet, businessIndex, employeeIndex, validator)
                      );
                      await refreshDelegation();
                    }}
                    disabled={busy || businessIndex === null || employeeIndex === null}
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
                      await runAction('Commit + Undelegate', () =>
                        commitAndUndelegateStreamV3(connection, wallet, businessIndex, employeeIndex)
                      );
                      await refreshDelegation();
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
                      await runAction('Redelegate v3 stream', () =>
                        redelegateStreamV3(connection, wallet, businessIndex, employeeIndex, validator)
                      );
                      await refreshDelegation();
                    }}
                    disabled={busy || businessIndex === null || employeeIndex === null}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Redelegate
                  </button>
                  <button
                    onClick={() => void refreshDelegation()}
                    disabled={busy || !employeePda}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Refresh Status
                  </button>
                </div>
              </div>
            </section>

            <section className="panel-card">
              <h2 className="text-lg font-semibold text-[#2D2D2A]">Fund Vault</h2>
              <p className="mt-1 text-sm text-gray-600">
                Deposit encrypted funds from your depositor token account into the vault.
              </p>
              <div className="mt-4 space-y-3">
                <input
                  value={depositorTokenAccount}
                  onChange={(e) => setDepositorTokenAccount(e.target.value)}
                  placeholder="Depositor token account"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={async () => {
                      if (!wallet.publicKey) {
                        setError('Wallet not connected.');
                        return;
                      }
                      const res = await runAction('Create depositor token account', () =>
                        createIncoTokenAccount(connection, wallet, wallet.publicKey!, PAYUSD_MINT)
                      );
                      if (res && typeof res === 'object' && 'tokenAccount' in res) {
                        setDepositorTokenAccount((res as any).tokenAccount.toBase58());
                      }
                    }}
                    disabled={busy}
                    className="premium-btn premium-btn-secondary disabled:opacity-50"
                  >
                    Create Depositor Token Account
                  </button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    placeholder="Deposit amount (USDC)"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <input
                    value={vaultTokenAccount}
                    onChange={(e) => setVaultTokenAccount(e.target.value)}
                    placeholder="Vault token account"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  onClick={() => {
                    if (!businessPda) {
                      setError('Business index is required.');
                      return;
                    }
                    if (!depositorTokenAccount.trim() || !vaultTokenAccount.trim()) {
                      setError('Depositor + vault token accounts are required.');
                      return;
                    }
                    const amountLamports = parseUiAmount('deposit', depositAmount);
                    return runAction('Deposit', () =>
                      depositV3(
                        connection,
                        wallet,
                        businessPda,
                        mustPubkey('depositor token account', depositorTokenAccount),
                        mustPubkey('vault token account', vaultTokenAccount),
                        amountLamports
                      )
                    );
                  }}
                  disabled={busy || !businessPda}
                  className="premium-btn premium-btn-primary disabled:opacity-50"
                >
                  Deposit to Vault
                </button>
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
