import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import dynamic from "next/dynamic";
import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AgentChat from "../components/AgentChat";
import {
  PAYUSD_MINT,
  MAGICBLOCK_DELEGATION_PROGRAM,
  INCO_TOKEN_PROGRAM_ID,
  adminWithdrawVaultV2,
  addEmployeeStreamV2,
  deactivateStreamV2,
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
} from "../lib/payroll-client";
import PageShell from "../components/PageShell";
import StepCard from "../components/StepCard";
import StatusPill from "../components/StatusPill";
import InlineHelp from "../components/InlineHelp";
import ActionResult from "../components/ActionResult";
import AdvancedDetails from "../components/AdvancedDetails";
import { COPY } from "../lib/copy";
import { getEmployerStepStates } from "../lib/ui-state";

const WalletButton = dynamic(() => import("../components/WalletButton"), {
  ssr: false,
});

const ACTION_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_AUTOMATION_WALLET =
  process.env.NEXT_PUBLIC_DEFAULT_KEEPER_PUBKEY?.trim() ||
  process.env.NEXT_PUBLIC_KEEPER_PUBKEY?.trim() ||
  "";
type PayPreset = "per_second" | "hourly" | "weekly" | "monthly" | "fixed_total";
type AgentPlanDraft = {
  source: "heuristic" | "llm" | "toolkit";
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
  autoGrantDecrypt?: boolean;
  autoGrantKeeperDecrypt?: boolean;
  streamIndex?: number;
  bonusAmount?: string;
  depositAmount?: string;
  recoverAmount?: string;
};
type AgentExecutionStatus = "pending" | "running" | "done" | "failed";
type AgentExecutionRisk = "safe" | "review" | "high_risk";
type AgentApprovalMode = "high_risk_only" | "every_tx";
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

type AgentRunStatePayload = {
  agentPrompt: string;
  agentDraft: AgentPlanDraft | null;
  agentQueue: AgentExecutionStep[];
  agentEnableHighSpeed: boolean;
  agentApprovalMode: AgentApprovalMode;
  agentMessages: any[];
  agentPhase: string;
};

function normalizeAgentQueue(raw: unknown): AgentExecutionStep[] {
  if (!Array.isArray(raw)) return [];
  const next: AgentExecutionStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const step = item as Partial<AgentExecutionStep>;
    if (typeof step.key !== "string" || typeof step.label !== "string")
      continue;
    const status: AgentExecutionStatus =
      step.status === "running" ||
        step.status === "done" ||
        step.status === "failed"
        ? step.status
        : "pending";
    const risk: AgentExecutionRisk =
      step.risk === "safe" ||
        step.risk === "high_risk" ||
        step.risk === "review"
        ? step.risk
        : "review";
    next.push({
      key: step.key,
      label: step.label,
      status,
      required: typeof step.required === "boolean" ? step.required : true,
      risk,
      requiresSignature: Boolean(step.requiresSignature),
      detail: typeof step.detail === "string" ? step.detail : undefined,
      txid: typeof step.txid === "string" ? step.txid : undefined,
    });
  }
  return next;
}
function isPayPreset(value: string): value is PayPreset {
  return (
    value === "per_second" ||
    value === "hourly" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "fixed_total"
  );
}

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
  timeoutMs = FETCH_TIMEOUT_MS,
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
  const [busyAction, setBusyAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastTx, setLastTx] = useState<{ label: string; sig: string } | null>(
    null,
  );
  const runIdRef = useRef(0);

  const [vaultTokenAccount, setVaultTokenAccount] = useState("");
  const [keeperPubkey, setKeeperPubkey] = useState("");
  const [settleIntervalSecs, setSettleIntervalSecs] = useState("10");
  const [depositAmount, setDepositAmount] = useState("10");
  const [hasConfirmedDeposit, setHasConfirmedDeposit] = useState(false);
  const [depositorTokenAccount, setDepositorTokenAccount] = useState("");
  const depositorTokenAccountRef = useRef(depositorTokenAccount);
  useEffect(() => { depositorTokenAccountRef.current = depositorTokenAccount; }, [depositorTokenAccount]);
  const [depositorBalance, setDepositorBalance] = useState<string | null>(null);
  const [vaultBalance, setVaultBalance] = useState<string | null>(null);
  const [vaultWithdrawAmount, setVaultWithdrawAmount] = useState("1");
  const [vaultWithdrawTokenAccount, setVaultWithdrawTokenAccount] =
    useState("");

  const [employeeWallet, setEmployeeWallet] = useState("");
  const [employeeTokenAccount, setEmployeeTokenAccount] = useState("");
  const [salaryPerSecond, setSalaryPerSecond] = useState("0.0001");
  const [payPreset, setPayPreset] = useState<PayPreset>("per_second");
  const [payAmount, setPayAmount] = useState("100"); // amount per hour/week/month or total amount (fixed_total)
  const [fixedTotalDays, setFixedTotalDays] = useState("30"); // used only when payPreset === 'fixed_total'
  const [boundPresetPeriod, setBoundPresetPeriod] = useState(true);
  const [autoGrantDecrypt, setAutoGrantDecrypt] = useState(true);
  const [autoGrantKeeperDecrypt, setAutoGrantKeeperDecrypt] = useState(true);

  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDraft, setAgentDraft] = useState<AgentPlanDraft | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentExecutionStep[]>([]);
  const [agentExecuteBusy, setAgentExecuteBusy] = useState(false);
  const [agentEnableHighSpeed, setAgentEnableHighSpeed] = useState(true);
  const [agentApprovalMode, setAgentApprovalMode] =
    useState<AgentApprovalMode>("high_risk_only");
  const [agentRunHydrated, setAgentRunHydrated] = useState(false);
  const [showAdvancedMode, setShowAdvancedMode] = useState(false);

  const [raiseSalaryPerSecond, setRaiseSalaryPerSecond] = useState("0.0001");
  const [bonusAmount, setBonusAmount] = useState("1");

  const [streamIndexInput, setStreamIndexInput] = useState("0");

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

  const [agentMessages, setAgentMessages] = useState<any[]>([]);
  const [agentPhase, setAgentPhase] = useState<string>("greeting");
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const agentGreetedRef = useRef(false);

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
    () =>
      (
        keeperPubkey ||
        DEFAULT_AUTOMATION_WALLET ||
        wallet.publicKey?.toBase58() ||
        ""
      ).trim(),
    [keeperPubkey, wallet.publicKey],
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
  const highSpeedOn = Boolean(
    streamStatus?.isDelegated || streamRoute?.delegated,
  );
  const automationMismatch = Boolean(
    v2ConfigExists &&
    v2Config?.keeper &&
    effectiveKeeperPubkey &&
    v2Config.keeper !== effectiveKeeperPubkey,
  );
  const automationStatusLabel = !v2ConfigExists
    ? "Pending"
    : automationMismatch
      ? "Needs update"
      : "Configured";
  const stepStates = getEmployerStepStates({
    businessReady: businessExists,
    vaultReady: vaultExists,
    vaultFunded: Number(vaultBalance || 0) > 0,
    configReady: v2ConfigExists,
    hasWorkerRecord,
    highSpeedOn,
  });

  function parsePositiveNumber(label: string, value: string): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${label} must be a positive number`);
    return n;
  }

  function secondsPerPreset(preset: typeof payPreset): number {
    if (preset === "hourly") return 60 * 60;
    if (preset === "weekly") return 7 * 24 * 60 * 60;
    if (preset === "monthly") return 30 * 24 * 60 * 60;
    return 1;
  }

  function computePerSecondRate(): number {
    if (payPreset === "per_second") {
      return parsePositiveNumber("Salary per second", salaryPerSecond);
    }
    if (payPreset === "fixed_total") {
      const total = parsePositiveNumber("Total amount", payAmount);
      const days = parsePositiveNumber("Days", fixedTotalDays);
      return total / (days * 24 * 60 * 60);
    }
    const perPeriod = parsePositiveNumber("Amount per period", payAmount);
    return perPeriod / secondsPerPreset(payPreset);
  }

  function computePeriodBounds(): { periodStart: number; periodEnd: number } {
    if (payPreset === "fixed_total") {
      const now = Math.floor(Date.now() / 1000);
      const days = parsePositiveNumber("Days", fixedTotalDays);
      const periodStart = now;
      const periodEnd = now + Math.floor(days * 24 * 60 * 60);
      return { periodStart, periodEnd };
    }

    if (!boundPresetPeriod) return { periodStart: 0, periodEnd: 0 };
    if (
      payPreset !== "hourly" &&
      payPreset !== "weekly" &&
      payPreset !== "monthly"
    ) {
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
    if (typeof window === "undefined") return;
    if (!ownerPubkey) return;
    const key = `expensee_employer_state_v2:${ownerPubkey.toBase58()}`;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.vaultTokenAccount === "string")
        setVaultTokenAccount(parsed.vaultTokenAccount);
      if (typeof parsed?.depositorTokenAccount === "string")
        setDepositorTokenAccount(parsed.depositorTokenAccount);
      if (typeof parsed?.depositAmount === "string")
        setDepositAmount(parsed.depositAmount);
      if (typeof parsed?.vaultWithdrawAmount === "string")
        setVaultWithdrawAmount(parsed.vaultWithdrawAmount);
      if (typeof parsed?.vaultWithdrawTokenAccount === "string")
        setVaultWithdrawTokenAccount(parsed.vaultWithdrawTokenAccount);
      if (typeof parsed?.keeperPubkey === "string")
        setKeeperPubkey(parsed.keeperPubkey);
      if (typeof parsed?.settleIntervalSecs === "string")
        setSettleIntervalSecs(parsed.settleIntervalSecs);
      if (typeof parsed?.employeeWallet === "string")
        setEmployeeWallet(parsed.employeeWallet);
      if (typeof parsed?.employeeTokenAccount === "string")
        setEmployeeTokenAccount(parsed.employeeTokenAccount);
      if (typeof parsed?.salaryPerSecond === "string")
        setSalaryPerSecond(parsed.salaryPerSecond);
      if (
        typeof parsed?.payPreset === "string" &&
        isPayPreset(parsed.payPreset)
      )
        setPayPreset(parsed.payPreset);
      if (typeof parsed?.payAmount === "string") setPayAmount(parsed.payAmount);
      if (typeof parsed?.fixedTotalDays === "string")
        setFixedTotalDays(parsed.fixedTotalDays);
      setBoundPresetPeriod(typeof parsed?.boundPresetPeriod === "boolean" ? parsed.boundPresetPeriod : true);
      setAutoGrantDecrypt(typeof parsed?.autoGrantDecrypt === "boolean" ? parsed.autoGrantDecrypt : true);
      setAutoGrantKeeperDecrypt(typeof parsed?.autoGrantKeeperDecrypt === "boolean" ? parsed.autoGrantKeeperDecrypt : true);
      if (typeof parsed?.streamIndexInput === "string")
        setStreamIndexInput(parsed.streamIndexInput);
      if (typeof parsed?.agentApprovalMode === "string") {
        if (
          parsed.agentApprovalMode === "every_tx" ||
          parsed.agentApprovalMode === "high_risk_only"
        ) {
          setAgentApprovalMode(parsed.agentApprovalMode);
        }
      }
      if (typeof parsed?.hasConfirmedDeposit === "boolean")
        setHasConfirmedDeposit(parsed.hasConfirmedDeposit);
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

  const saveAgentRunState = useCallback(
    async (owner: string, payload: AgentRunStatePayload) => {
      try {
        await fetchWithTimeout("/api/agent/run-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner,
            scope: "employer",
            state: payload,
          }),
        });
      } catch {
        // Best effort only; local flow should never fail because cloud save failed.
      }
    },
    [],
  );

  useEffect(() => {
    if (!ownerPubkey) {
      setAgentRunHydrated(false);
      // EDGE CASE: Reset all agent state on disconnect so next wallet starts fresh
      setAgentMessages([]);
      setAgentPhase("greeting");
      setInitialDataLoaded(false);
      agentGreetedRef.current = false;
      return;
    }

    let closed = false;
    const owner = ownerPubkey.toBase58();

    (async () => {
      try {
        const response = await fetchWithTimeout(
          `/api/agent/run-state?owner=${encodeURIComponent(owner)}&scope=employer`,
        );
        const json = (await response.json()) as
          | {
            ok: true;
            enabled: boolean;
            state: Partial<AgentRunStatePayload> | null;
          }
          | {
            ok: false;
            enabled: boolean;
            error?: string;
          };
        if (closed) return;

        if (!response.ok || !json.ok || !json.enabled || !json.state) {
          setAgentRunHydrated(true);
          return;
        }

        const remote = json.state;
        if (typeof remote.agentPrompt === "string")
          setAgentPrompt(remote.agentPrompt);
        if (typeof remote.agentEnableHighSpeed === "boolean")
          setAgentEnableHighSpeed(remote.agentEnableHighSpeed);
        if (
          remote.agentApprovalMode === "every_tx" ||
          remote.agentApprovalMode === "high_risk_only"
        ) {
          setAgentApprovalMode(remote.agentApprovalMode);
        }
        if (Array.isArray(remote.agentQueue)) {
          setAgentQueue(normalizeAgentQueue(remote.agentQueue));
        }
        if (remote.agentDraft && typeof remote.agentDraft === "object") {
          setAgentDraft(remote.agentDraft as AgentPlanDraft);
        }
        if (Array.isArray(remote.agentMessages)) {
          setAgentMessages(remote.agentMessages);
        }
        if (typeof remote.agentPhase === "string") {
          setAgentPhase(remote.agentPhase);
        }
      } catch {
        // ignore and continue with local-only mode
      } finally {
        if (!closed) setAgentRunHydrated(true);
      }
    })();

    return () => {
      closed = true;
    };
  }, [ownerPubkey]);

  useEffect(() => {
    if (!ownerPubkey || !agentRunHydrated) return;
    const owner = ownerPubkey.toBase58();
    const timer = window.setTimeout(() => {
      void saveAgentRunState(owner, {
        agentPrompt,
        agentDraft,
        agentQueue,
        agentEnableHighSpeed,
        agentApprovalMode,
        agentMessages,
        agentPhase,
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    agentApprovalMode,
    agentDraft,
    agentEnableHighSpeed,
    agentPrompt,
    agentQueue,
    agentRunHydrated,
    agentMessages,
    agentPhase,
    ownerPubkey,
    saveAgentRunState,
  ]);

  // FINAL BOSS: Robust Agent Greeting & Phase Guard
  // This lives in the parent to ensure it only fires when blockchain state is TRUSTED.
  useEffect(() => {
    if (
      !ownerPubkey ||
      !initialDataLoaded ||
      !agentRunHydrated ||
      agentGreetedRef.current
    )
      return;

    // If we have history, we've already "greeted" in a past session.
    if (agentMessages.length > 0) {
      agentGreetedRef.current = true;

      const pendingTask = agentQueue.find((s) => s.status === "pending");
      const isFullySetup =
        businessExists && vaultExists && v2ConfigExists && !pendingTask;

      if (isFullySetup && agentPhase === "ask_setup") {
        const correctionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setAgentMessages((prev) => [
          ...prev,
          {
            id: correctionId,
            role: "agent",
            text:
              `Welcome back to OnyxFii! I've synchronized with the blockchain. 🤖\n\n` +
              `Your account status:\n✅ Company registered\n✅ Payroll vault ready\n✅ Automation configured\n\n` +
              `Everything is set up. Ready to create a new payment stream? Just paste a **worker's wallet address** to begin.`,
            timestamp: Date.now(),
          },
        ]);
        setAgentPhase("ask_wallet");
      } else if (!isFullySetup && agentPhase !== "ask_setup" && agentPhase !== "greeting") {
        // AUTO-CORRECT: The cache thinks we are past setup, but the blockchain says we are not.
        // This happens if the user switched wallets or reset the local chain.
        const correctionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setAgentMessages((prev) => [
          ...prev,
          {
            id: correctionId,
            role: "agent",
            text:
              `⚠️ **Chain Sync Notice:** I noticed your on-chain data doesn't match our previous conversation (possibly a new wallet or network reset).\n\n` +
              `Let's get back on track. It looks like you still need to complete the foundational setup. Type **"setup"** to resume where the blockchain left off.`,
            timestamp: Date.now(),
          },
        ]);
        setAgentPhase("ask_setup");
      } else if (pendingTask && agentPhase === "ask_wallet") {
        // Soft correction
        setAgentPhase("ask_setup");
      }
      return;
    }

    agentGreetedRef.current = true;

    const statusParts: string[] = [];
    if (businessExists) statusParts.push("✅ Company registered");
    else statusParts.push("⏳ Company not yet registered");
    if (vaultExists) statusParts.push("✅ Payroll vault ready");
    else statusParts.push("⏳ Payroll vault needed");
    if (v2ConfigExists) statusParts.push("✅ Automation configured");
    else statusParts.push("⏳ Automation needed");

    const nextPending = agentQueue.find((s) => s.status === "pending");
    const isFullySetup =
      businessExists && vaultExists && v2ConfigExists && !nextPending;
    const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (isFullySetup) {
      setAgentMessages([
        {
          id: msgId,
          role: "agent",
          text:
            `Welcome back to OnyxFii! I've synchronized with the blockchain. 🤖\n\n` +
            `Your account status:\n${statusParts.join("\n")}\n\n` +
            `The company is fully initialized. Ready to set up a new payment stream? Just paste a **worker's wallet address** to begin.`,
          timestamp: Date.now(),
        },
      ]);
      setAgentPhase("ask_wallet");
    } else {
      const stepMsg = nextPending
        ? `I see we have a pending task: **${nextPending.label}**.\n\nType **"go"** and I'll handle that for you.`
        : `It looks like you haven't finished setting up your company profile. Type **"setup"** and I'll walk you through the missing initialization steps.`;

      setAgentMessages([
        {
          id: msgId,
          role: "agent",
          text:
            `Welcome to OnyxFii! I'm your autonomous payroll agent. 🤖\n\n` +
            `Your account status:\n${statusParts.join("\n")}\n\n` +
            stepMsg,
          timestamp: Date.now(),
        },
      ]);
      setAgentPhase("ask_setup");
    }
  }, [
    ownerPubkey,
    initialDataLoaded,
    agentRunHydrated,
    businessExists,
    vaultExists,
    v2ConfigExists,
    agentMessages.length,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!ownerPubkey) return;
    const key = `expensee_employer_state_v2:${ownerPubkey.toBase58()}`;
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          vaultTokenAccount,
          depositorTokenAccount,
          depositAmount,
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
          autoGrantKeeperDecrypt,
          streamIndexInput,
          agentApprovalMode,
          hasConfirmedDeposit,
        }),
      );
    } catch {
      // ignore
    }
  }, [
    depositorTokenAccount,
    depositAmount,
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
    autoGrantKeeperDecrypt,
    agentApprovalMode,
    settleIntervalSecs,
    streamIndexInput,
    vaultTokenAccount,
    hasConfirmedDeposit,
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
        setInitialDataLoaded(true);
        return;
      }

      const vault = await getVaultAccount(connection, business.address);
      setVaultExists(vault !== null);
      if (vault) {
        setVaultTokenAccount((prev) => prev || vault.tokenAccount.toBase58());
      }

      const cfg = await getBusinessStreamConfigV2Account(
        connection,
        business.address,
      );
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
        const stream = await getEmployeeStreamV2Account(
          connection,
          business.address,
          streamIndex,
        );
        if (stream) {
          const accruedBytes = stream.encryptedAccrued.slice(0, 16);
          let accrued = BigInt(0);
          for (let i = 15; i >= 0; i--) {
            accrued = accrued * BigInt(256) + BigInt(accruedBytes[i]);
          }
          // Best-effort: ask MagicBlock router where this stream is delegated (more reliable than base owner).
          try {
            const resp = await fetchWithTimeout(
              `/api/magicblock/delegation-status?pubkey=${encodeURIComponent(stream.address.toBase58())}`,
            );
            const json = await resp.json();
            if (resp.ok && json?.ok) {
              const r = json.result || {};
              const delegatedRaw =
                r?.delegated ??
                r?.isDelegated ??
                r?.delegation?.delegated ??
                false;
              const delegated =
                typeof delegatedRaw === "number"
                  ? delegatedRaw !== 0
                  : Boolean(delegatedRaw);
              setStreamRoute({
                delegated,
                endpoint: r?.endpoint || r?.delegation?.endpoint || null,
                error: null,
              });
            } else {
              setStreamRoute({
                delegated: null,
                endpoint: null,
                error: json?.error || "Router request failed",
              });
            }
          } catch (e: any) {
            setStreamRoute({
              delegated: null,
              endpoint: null,
              error: e?.message || "Router request failed",
            });
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
          setStreamRoute(null);
        }
      }

      // Fetch token balances for agent context
      try {
        if (vault?.tokenAccount) {
          const vBal = await connection.getTokenAccountBalance(vault.tokenAccount, 'confirmed').catch(() => null);
          setVaultBalance(vBal?.value?.uiAmountString ?? null);
        } else {
          setVaultBalance(null);
        }
      } catch {
        setVaultBalance(null);
      }

      // Fetch depositor (source account) balance
      try {
        if (depositorTokenAccount) {
          const depPubkey = new PublicKey(depositorTokenAccount);
          const dBal = await connection.getTokenAccountBalance(depPubkey, 'confirmed').catch(() => null);
          setDepositorBalance(dBal?.value?.uiAmountString ?? null);
        } else {
          setDepositorBalance(null);
        }
      } catch {
        setDepositorBalance(null);
      }

      setInitialDataLoaded(true);
    } catch (e: any) {
      setError(e?.message || "Failed to load employer state");
      setBusinessExists(false);
      setVaultExists(false);
      setV2ConfigExists(false);
      setV2Config(null);
      setStreamStatus(null);
      setStreamRoute(null);
      setInitialDataLoaded(true);
    }
  }, [connection, ownerPubkey, streamIndex]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const rotateAutomationWalletTask = useCallback(async () => {
    const keeper = mustPubkey(
      "automation service wallet",
      effectiveKeeperPubkey,
    );
    const txid = await updateKeeperV2(connection, wallet, keeper);
    return {
      txid,
      message: `Automation service wallet updated to ${keeper.toBase58()}`,
    };
  }, [connection, effectiveKeeperPubkey, wallet]);

  useEffect(() => {
    if (!busy) return;
    const activeRunId = runIdRef.current;
    const timer = setTimeout(() => {
      if (runIdRef.current !== activeRunId) return;
      runIdRef.current += 1;
      setBusy(false);
      setBusyAction("");
      setError(
        "Action timed out in UI. It may still complete on-chain. Check Phantom, then refresh stream status.",
      );
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
      >,
    ) => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setBusy(true);
      setBusyAction(label);
      setError("");
      setMessage("");
      setLastTx(null);
      try {
        const result = await task();
        if (runIdRef.current !== runId) return;
        const txid =
          typeof result === "string"
            ? result
            : result &&
              typeof result === "object" &&
              typeof (result as any).txid === "string"
              ? (result as any).txid
              : "";
        const successMessage =
          result &&
            typeof result === "object" &&
            typeof (result as any).message === "string"
            ? (result as any).message
            : `${label} succeeded`;
        setMessage(successMessage);
        if (txid) setLastTx({ label, sig: txid });
        // Do not block the action UI on post-success reads; a slow RPC should not look like a frozen button.
        setBusy(false);
        setBusyAction("");
        void loadState().catch(() => {
          // Keep success state even if refresh fails; user can manually refresh.
        });
      } catch (e: any) {
        if (runIdRef.current !== runId) return;
        setError(e?.message || `${label} failed`);
      } finally {
        if (runIdRef.current !== runId) return;
        setBusy(false);
        setBusyAction("");
      }
    },
    [loadState],
  );

  const applyAgentDraft = useCallback((draft: AgentPlanDraft) => {
    if (draft.employeeWallet) setEmployeeWallet(draft.employeeWallet);
    if (draft.payPreset) setPayPreset(draft.payPreset);
    if (draft.payAmount) setPayAmount(draft.payAmount);
    if (draft.fixedTotalDays) setFixedTotalDays(draft.fixedTotalDays);
    if (draft.salaryPerSecond) setSalaryPerSecond(draft.salaryPerSecond);
    setBoundPresetPeriod(typeof draft.boundPresetPeriod === "boolean" ? draft.boundPresetPeriod : true);
    setAutoGrantDecrypt(typeof draft.autoGrantDecrypt === "boolean" ? draft.autoGrantDecrypt : true);
    setAutoGrantKeeperDecrypt(typeof draft.autoGrantKeeperDecrypt === "boolean" ? draft.autoGrantKeeperDecrypt : true);
    if (draft.depositAmount) setDepositAmount(draft.depositAmount);
    if (draft.recoverAmount) setVaultWithdrawAmount(draft.recoverAmount);
    if (draft.bonusAmount) setBonusAmount(draft.bonusAmount);
    if (typeof draft.streamIndex === "number")
      setStreamIndexInput(String(draft.streamIndex));
    if (draft.intent) setAgentDraft((prev) => ({ ...prev!, intent: draft.intent }));
  }, []);

  const createWorkerDestinationAccountTask = useCallback(async () => {
    const employee = mustPubkey("worker wallet", employeeWallet);
    const { txid, tokenAccount } = await createIncoTokenAccount(
      connection,
      wallet,
      employee,
      PAYUSD_MINT,
    );
    setEmployeeTokenAccount(tokenAccount.toBase58());
    return { txid, tokenAccount: tokenAccount.toBase58() };
  }, [connection, employeeWallet, wallet]);

  const createWorkerPayrollRecordTask = useCallback(
    async (overrideTokenAccount?: string) => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      const employee = mustPubkey("worker wallet", employeeWallet);
      const tokenStr = overrideTokenAccount || employeeTokenAccount;
      const employeeToken = mustPubkey("worker token account", tokenStr);
      const ratePerSecond = computePerSecondRate();
      const { periodStart, periodEnd } = computePeriodBounds();
      const result = await addEmployeeStreamV2(
        connection,
        wallet,
        employee,
        employeeToken,
        ratePerSecond,
        periodStart,
        periodEnd,
      );
      setStreamIndexInput(String(result.streamIndex));
      let historyMessage = "rate history initialized";
      try {
        await initRateHistoryV2(connection, wallet, result.streamIndex);
      } catch (historyError: any) {
        const reason = historyError?.message || "unknown error";
        historyMessage = `rate history init failed (${reason})`;
      }

      let decryptMessage = "worker view access skipped";
      if (autoGrantDecrypt) {
        try {
          await grantEmployeeViewAccessV2(
            connection,
            wallet,
            ownerPubkey,
            result.streamIndex,
            employee,
          );
          decryptMessage = "worker view access granted";
        } catch (grantError: any) {
          const reason = grantError?.message || "unknown error";
          decryptMessage = `worker view grant failed (${reason})`;
        }
      }

      let keeperMessage = "automation decrypt skipped";
      if (autoGrantKeeperDecrypt) {
        try {
          const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
          if (!keeperKey) throw new Error("automation wallet missing");
          const keeper = mustPubkey("automation wallet", keeperKey);
          await grantKeeperViewAccessV2(
            connection,
            wallet,
            ownerPubkey,
            result.streamIndex,
            keeper,
          );
          keeperMessage = "automation decrypt granted";
        } catch (keeperError: any) {
          const reason = keeperError?.message || "unknown error";
          keeperMessage = `automation decrypt grant failed (${reason})`;
        }
      }

      return {
        txid: result.txid,
        streamIndex: result.streamIndex,
        message: `Worker payroll record #${result.streamIndex} created: ${historyMessage}; ${decryptMessage}; ${keeperMessage}.`,
      };
    },
    [
      autoGrantDecrypt,
      autoGrantKeeperDecrypt,
      computePeriodBounds,
      connection,
      effectiveKeeperPubkey,
      employeeTokenAccount,
      employeeWallet,
      ownerPubkey,
      v2Config?.keeper,
      wallet,
    ],
  );

  const buildAgentExecutionQueue = useCallback((): AgentExecutionStep[] => {
    const steps: AgentExecutionStep[] = [];
    // Intent logic: default to 'create_stream' if any worker-related details are present but no stream index yet.
    // This prevents accidental 'update_stream' or 'unknown' intents from skipping setup steps.
    const hasWorkerDraft = !!employeeWallet || !!agentDraft?.employeeWallet || !!agentDraft?.payPreset;
    const hasStreamIndex = (streamStatus?.streamIndex !== undefined && streamStatus?.streamIndex !== null) || (agentDraft?.streamIndex !== undefined && agentDraft?.streamIndex !== null);

    let intent = (agentDraft && agentDraft.intent) ? agentDraft.intent : "create_stream";
    if (!intent || intent === "unknown" || intent === "none") {
      intent = "create_stream";
    }
    if (hasWorkerDraft && !hasStreamIndex && intent !== 'create_stream') {
      intent = "create_stream";
    }

    // Shared: Refresh state
    steps.push({
      key: "refresh-state",
      label: "Refresh current company status",
      status: "pending",
      required: true,
      risk: "safe",
      requiresSignature: false,
    });

    // FOUNDATION: Register business
    steps.push({
      key: "register-business",
      label: "Register company profile on-chain",
      status: businessExists ? "done" : "pending",
      required: true,
      risk: "high_risk",
      requiresSignature: true,
    });

    // FOUNDATION: Setup vault
    // If we don't even have a token account for the vault yet
    if (!vaultTokenAccount || !vaultExists) {
      steps.push({
        key: "create-vault-pda-token",
        label: "Create encrypted payroll vault account",
        status: (vaultTokenAccount && vaultExists) ? "done" : "pending",
        required: true,
        risk: "review",
        requiresSignature: true,
      });
    }
    steps.push({
      key: "init-vault",
      label: "Initialize payroll vault custody",
      status: vaultExists ? "done" : "pending",
      required: true,
      risk: "high_risk",
      requiresSignature: true,
    });

    // FIX VAULT MINT: If user requested a mint fix and vault already exists
    if (intent === "fix_vault_mint" && businessExists && vaultExists && vaultTokenAccount) {
      steps.push({
        key: "rotate-vault-mint",
        label: "Fix payroll wallet mint (rotate to latest)",
        status: "pending",
        required: true,
        risk: "high_risk",
        requiresSignature: true,
      });
    }

    // RECOVER FUNDS: If user requested vault fund recovery
    if (intent === "recover_funds" && businessExists && vaultExists) {
      steps.push({
        key: "admin-withdraw-vault",
        label: "Recover unused payroll funds from vault",
        status: "pending",
        required: true,
        risk: "high_risk",
        requiresSignature: true,
      });
    }

    // STEP 2: Funding (Move funds into vault)
    const currentDepositor =
      depositorTokenAccountRef.current || depositorTokenAccount;
    steps.push({
      key: "create-depositor-token",
      label: "Create company source account",
      status: currentDepositor ? "done" : "pending",
      required: true,
      risk: "review",
      requiresSignature: true,
    });

    // Smart status: If they have tokens in their wallet OR in the vault, they've finished minting
    // Also mark as done if the vault exists and is funded, or if they've progressed to later steps (automation/worker)
    const hasObtainedTokens =
      Number(depositorBalance || 0) > 0 || Number(vaultBalance || 0) > 0;
    const hasProgressedPastFunding = !!v2ConfigExists || !!employeeTokenAccount.trim();
    steps.push({
      key: "mint-demo-tokens",
      label: "Get 1,000 demo tokens",
      status: (hasObtainedTokens || hasConfirmedDeposit || Number(vaultBalance || 0) > 0 || hasProgressedPastFunding) ? "done" : "pending",
      required: true,
      risk: "safe",
      requiresSignature: false,
    });

    const hasVaultFunds = Number(vaultBalance || 0) > 0;
    steps.push({
      key: "configure-deposit-amount",
      label: "Confirm deposit amount",
      status: (hasConfirmedDeposit || hasVaultFunds || hasProgressedPastFunding) ? "done" : "pending",
      required: true,
      risk: "safe",
      requiresSignature: false,
    });

    steps.push({
      key: "deposit-funds",
      label: "Add funds to payroll wallet",
      status: (hasVaultFunds || hasProgressedPastFunding) ? "done" : "pending",
      required: true,
      risk: "review",
      requiresSignature: true,
    });

    if (intent === "create_stream") {
      const keeperMismatch =
        !!v2ConfigExists &&
        !!v2Config?.keeper &&
        !!effectiveKeeperPubkey &&
        v2Config.keeper !== effectiveKeeperPubkey;

      steps.push({
        key: "init-automation",
        label: "Initialize automation service",
        status: v2ConfigExists ? "done" : "pending",
        required: true,
        risk: "high_risk",
        requiresSignature: true,
      });

      if (keeperMismatch) {
        steps.push({
          key: "rotate-automation",
          label: "Rotate automation wallet to active keeper",
          status: "pending",
          required: true,
          risk: "high_risk",
          requiresSignature: true,
        });
      }

      steps.push({
        key: "create-worker-token",
        label: "Create worker destination account",
        status: employeeTokenAccount.trim() ? "done" : "pending",
        required: true,
        risk: "review",
        requiresSignature: true,
      });

      steps.push({
        key: "configure-worker-options",
        label: "Configure worker record options",
        status: "pending",
        required: true,
        risk: "safe",
        requiresSignature: false,
      });

      steps.push({
        key: "create-worker-record",
        label: "Create worker payroll record",
        status: "pending",
        required: true,
        risk: "review",
        requiresSignature: true,
      });

      if (agentEnableHighSpeed) {
        steps.push({
          key: "enable-high-speed",
          label: "Enable high-speed mode",
          status: "pending",
          required: false,
          risk: "review",
          requiresSignature: true,
        });
      }
    } else if (intent === "pause_stream") {
      steps.push({
        key: "pause-stream",
        label: "Pause payroll execution",
        status: "pending",
        required: true,
        risk: "review",
        requiresSignature: true,
      });
    } else if (intent === "resume_stream") {
      steps.push({
        key: "resume-stream",
        label: "Resume payroll execution",
        status: "pending",
        required: true,
        risk: "review",
        requiresSignature: true,
      });
    } else if (intent === "update_stream") {
      if (agentDraft?.payAmount || agentDraft?.salaryPerSecond) {
        steps.push({
          key: "apply-raise",
          label: "Apply pay rate update",
          status: "pending",
          required: true,
          risk: "review",
          requiresSignature: true,
        });
      }
      if (agentDraft?.bonusAmount) {
        steps.push({
          key: "apply-bonus",
          label: "Apply one-time private bonus",
          status: "pending",
          required: true,
          risk: "review",
          requiresSignature: true,
        });
      }
    } else if (intent === "deactivate_stream") {
      steps.push({
        key: "deactivate-stream",
        label: "Deactivate payroll record",
        status: "pending",
        required: true,
        risk: "high_risk",
        requiresSignature: true,
      });
    } else if (intent === "grant_access") {
      if (agentDraft?.employeeWallet) {
        steps.push({
          key: "grant-worker-access",
          label: "Grant view access to worker",
          status: "pending",
          required: true,
          risk: "safe",
          requiresSignature: true,
        });
      }
      steps.push({
        key: "grant-keeper-access",
        label: "Grant decrypt access to automation",
        status: "pending",
        required: true,
        risk: "safe",
        requiresSignature: true,
      });
    }

    return steps;
  }, [
    agentDraft,
    agentEnableHighSpeed,
    businessExists,
    vaultExists,
    depositorTokenAccount,
    v2ConfigExists,
    effectiveKeeperPubkey,
    v2Config?.keeper,
    employeeTokenAccount,
    hasConfirmedDeposit,
    depositorBalance,
    vaultBalance,
  ]);

  // Self-heal the agent queue if the code introduces new steps that aren't in localStorage.
  useEffect(() => {
    if (agentQueue.length > 0) {
      const freshQueue = buildAgentExecutionQueue();
      const currentKeys = agentQueue.map(s => s.key).join(',');
      const freshKeys = freshQueue.map(s => s.key).join(',');
      if (currentKeys !== freshKeys) {
        const mergedQueue = freshQueue.map(step => {
          const existing = agentQueue.find(s => s.key === step.key);
          return existing && (existing.status === 'done' || existing.status === 'running')
            ? { ...step, status: existing.status as AgentExecutionStatus, txid: existing.txid, detail: existing.detail }
            : step;
        });
        setAgentQueue(mergedQueue);
      }
    }
  }, [agentQueue, buildAgentExecutionQueue]);

  const previewAgentExecution = useCallback(() => {
    const workerWallet = employeeWallet.trim();
    if (!workerWallet) {
      setError(
        "Add a worker wallet first (or ask the assistant to include one).",
      );
      return;
    }
    const queue = buildAgentExecutionQueue();
    if (!queue.length) {
      setError("No execution steps were generated.");
      return;
    }
    setError("");
    setAgentQueue(queue);
    setMessage("Execution preview ready. Review and run.");
  }, [buildAgentExecutionQueue, employeeWallet]);

  const executeAgentQueue = useCallback(async () => {
    if (!ownerPubkey) {
      setError("Wallet not connected");
      return;
    }
    const queue = buildAgentExecutionQueue();
    if (!queue.length) {
      setError("No execution steps were generated.");
      return;
    }

    setAgentQueue(queue);
    setAgentExecuteBusy(true);
    setBusy(true);
    setBusyAction("Executing assistant plan");
    setError("");
    setMessage("");

    const updateStep = (key: string, patch: Partial<AgentExecutionStep>) => {
      setAgentQueue((prev) =>
        prev.map((step) => (step.key === key ? { ...step, ...patch } : step)),
      );
    };
    let createdStreamIndex: number | null = null;
    let createdTokenAccount: string | undefined = undefined;
    const shouldRequireApproval = (step: AgentExecutionStep): boolean => {
      if (!step.requiresSignature) return false;
      if (agentApprovalMode === "every_tx") return true;
      return step.risk === "high_risk";
    };

    try {
      for (const step of queue) {
        if (shouldRequireApproval(step)) {
          const approved = window.confirm(
            `Review required before this step:\n\n${step.label}\nRisk: ${step.risk}\nSignature needed: yes\n\nClick OK to continue or Cancel to pause execution.`,
          );
          if (!approved) {
            updateStep(step.key, {
              status: "pending",
              detail: "Paused for review by operator",
            });
            throw new Error(
              `Execution paused for review at step: ${step.label}`,
            );
          }
        }

        updateStep(step.key, { status: "running" });

        try {
          if (step.key === "refresh-state") {
            await loadState();
            updateStep(step.key, {
              status: "done",
              detail: "Status refreshed (no signature needed)",
            });
            continue;
          }

          if (step.key === "register-business") {
            const result = await registerBusiness(connection, wallet);
            updateStep(step.key, { status: "done", txid: result.txid });
            continue;
          }

          if (step.key === "create-vault-pda-token") {
            // Need the PDA for the vault
            const [businessPDA] = getBusinessPDA(ownerPubkey);
            const [vaultPDA] = getVaultPDA(businessPDA);
            const { txid, tokenAccount } = await createVaultTokenAccount(
              connection,
              wallet,
              vaultPDA,
              PAYUSD_MINT,
            );
            setVaultTokenAccount(tokenAccount.toBase58());
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "init-vault") {
            const token = mustPubkey(
              "payroll wallet token account",
              vaultTokenAccount,
            );
            const result = await initVault(
              connection,
              wallet,
              token,
              PAYUSD_MINT,
            );
            updateStep(step.key, { status: "done", txid: result.txid });
            continue;
          }

          if (step.key === "create-depositor-token") {
            const { txid, tokenAccount } = await createIncoTokenAccount(
              connection,
              wallet,
              ownerPubkey,
              PAYUSD_MINT,
            );
            const tokenAddr = tokenAccount.toBase58();
            setDepositorTokenAccount(tokenAddr);
            depositorTokenAccountRef.current = tokenAddr;
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "mint-demo-tokens") {
            const currentDepositorToken =
              depositorTokenAccountRef.current || depositorTokenAccount;
            if (!currentDepositorToken)
              throw new Error("No company source account found to fund.");
            const resp = await fetch("/api/faucet/mint-payusd", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                userConfidentialTokenAccount: currentDepositorToken,
              }),
            });
            const json = await resp.json();
            if (!resp.ok || !json?.ok)
              throw new Error(json?.error || "Faucet failed");
            updateStep(step.key, { status: "done", txid: json.tx });
            continue;
          }

          if (step.key === "configure-deposit-amount") {
            updateStep(step.key, {
              status: "done",
              detail: "TRIGGER_DEPOSIT_PROMPT",
            });
            setAgentPhase("ask_funding");
            throw new Error("PAUSE_FOR_DEPOSIT");
          }

          if (step.key === "deposit-funds") {
            const business = await getBusinessAccount(connection, ownerPubkey);
            if (!business) throw new Error("Business not found");
            const vault = await getVaultAccount(connection, business.address);
            if (!vault) throw new Error("Vault not found");
            const currentDepositorToken =
              depositorTokenAccountRef.current || depositorTokenAccount;
            if (!currentDepositorToken)
              throw new Error(
                "Please paste your Company Source Token Account address in Step 2.",
              );
            if (!depositAmount || Number(depositAmount) <= 0)
              throw new Error("Please enter a valid deposit amount in Step 2.");

            const depositorToken = mustPubkey(
              "source token account",
              currentDepositorToken,
            );
            const amount = Number(depositAmount);
            const txid = await deposit(
              connection,
              wallet,
              depositorToken,
              vault.tokenAccount,
              amount,
            );

            // Instantly update UI state so Step 2 turns green
            const currentBal = Number(vaultBalance || 0);
            setVaultBalance((currentBal + amount).toString());

            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "init-automation") {
            const keeper = mustPubkey(
              "automation service wallet",
              effectiveKeeperPubkey,
            );
            const result = await initStreamConfigV2(
              connection,
              wallet,
              keeper,
              Number(settleIntervalSecs),
            );
            updateStep(step.key, { status: "done", txid: result.txid });
            continue;
          }

          if (step.key === "rotate-automation") {
            const result = await rotateAutomationWalletTask();
            updateStep(step.key, {
              status: "done",
              txid: result.txid,
              detail: result.message,
            });
            continue;
          }

          if (step.key === "configure-worker-options") {
            updateStep(step.key, {
              status: "done",
              detail: "TRIGGER_ASK_OPTIONS",
            });
            setAgentPhase("ask_options");
            // Stop the automated queue and wait for conversational input
            throw new Error("PAUSE_FOR_OPTIONS");
          }

          if (step.key === "create-worker-token") {
            const workerWallet = employeeWallet.trim();
            if (!workerWallet)
              throw new Error(
                "Worker wallet address is missing. Please provide one.",
              );
            const result = await createWorkerDestinationAccountTask();
            createdTokenAccount = result.tokenAccount;
            updateStep(step.key, { status: "done", txid: result.txid });
            continue;
          }

          if (step.key === "create-worker-record") {
            const workerWallet = employeeWallet.trim();
            if (!workerWallet)
              throw new Error(
                "Worker wallet address is missing. Please provide one.",
              );
            const result =
              await createWorkerPayrollRecordTask(createdTokenAccount);
            createdStreamIndex = result.streamIndex;
            updateStep(step.key, {
              status: "done",
              txid: result.txid,
              detail: result.message,
            });
            continue;
          }

          if (step.key === "enable-high-speed") {
            const nextIndex = createdStreamIndex ?? Number(streamIndexInput);
            const validIndex =
              Number.isFinite(nextIndex) && nextIndex >= 0 ? nextIndex : null;
            if (validIndex === null) {
              throw new Error(
                "No payroll record number available to enable high-speed mode",
              );
            }
            const txid = await delegateStreamV2(
              connection,
              wallet,
              ownerPubkey,
              validIndex,
            );
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "pause-stream") {
            const txid = await pauseStreamV2(
              connection,
              wallet,
              ownerPubkey,
              1,
            );
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "resume-stream") {
            const txid = await resumeStreamV2(connection, wallet);
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "apply-raise") {
            const index = Number(streamIndexInput);
            const rate = Number(agentDraft?.salaryPerSecond || salaryPerSecond);
            const txid = await updateSalaryRateV2(
              connection,
              wallet,
              index,
              rate,
            );
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "apply-bonus") {
            const index = Number(streamIndexInput);
            const amount = Number(agentDraft?.bonusAmount || bonusAmount);
            const txid = await grantBonusV2(connection, wallet, index, amount);
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "deactivate-stream") {
            const index = Number(streamIndexInput);
            const txid = await deactivateStreamV2(connection, wallet, index);
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "grant-worker-access") {
            const workerWallet = employeeWallet.trim();
            if (!workerWallet)
              throw new Error(
                "Worker wallet address is missing for access grant.",
              );
            const index = Number(streamIndexInput);
            const employee = mustPubkey("worker wallet", employeeWallet);
            const txid = await grantEmployeeViewAccessV2(
              connection,
              wallet,
              ownerPubkey,
              index,
              employee,
            );
            updateStep(step.key, { status: "done", txid });
            continue;
          }

          if (step.key === "grant-keeper-access") {
            const index = Number(streamIndexInput);
            const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
            if (!keeperKey) throw new Error("automation wallet missing");
            const keeper = mustPubkey("automation wallet", keeperKey);
            const txid = await grantKeeperViewAccessV2(
              connection,
              wallet,
              ownerPubkey,
              index,
              keeper,
            );
            updateStep(step.key, { status: "done", txid });
            continue;
          }
        } catch (stepError: any) {
          const stepMessage = stepError?.message || "step failed";
          updateStep(step.key, { status: "failed", detail: stepMessage });
          throw new Error(`${step.label}: ${stepMessage}`);
        }
      }

      setMessage(
        "Assistant execution completed. Review Step 5 and Worker Portal.",
      );
      await loadState();
    } catch (e: any) {
      if (e?.message === "PAUSE_FOR_OPTIONS" || e?.message === "PAUSE_FOR_DEPOSIT") return;
      setError(e?.message || "Assistant execution failed");
      throw e;
    } finally {
      setBusy(false);
      setBusyAction("");
      setAgentExecuteBusy(false);
    }
  }, [
    agentApprovalMode,
    buildAgentExecutionQueue,
    connection,
    createWorkerDestinationAccountTask,
    createWorkerPayrollRecordTask,
    effectiveKeeperPubkey,
    employeeWallet,
    loadState,
    ownerPubkey,
    rotateAutomationWalletTask,
    settleIntervalSecs,
    streamIndexInput,
    wallet,
  ]);

  const executeNextAgentStep =
    useCallback(async (): Promise<AgentExecutionStep | null> => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      if (agentExecuteBusy) return null; // Lock
      if (!initialDataLoaded) throw new Error("Synchronization in progress... please try again in a second.");

      // Always get the latest "truth" from buildAgentExecutionQueue
      const freshQueue = buildAgentExecutionQueue();

      // Merge status from existing agentQueue to preserve "done" or "running" status for this session
      const mergedQueue = freshQueue.map((step): AgentExecutionStep => {
        const existing = agentQueue.find((s) => s.key === step.key);
        if (
          existing &&
          (existing.status === "done" || existing.status === "running")
        ) {
          return {
            ...step,
            status: existing.status as AgentExecutionStatus,
            txid: existing.txid,
            detail: existing.detail,
          };
        }
        return step;
      });

      const nextStep = mergedQueue.find((s) => s.status === "pending");
      if (!nextStep) return null;

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;

      setAgentQueue(mergedQueue);
      setAgentExecuteBusy(true);
      setBusy(true);
      setBusyAction(`Executing: ${nextStep.label}`);
      setError("");
      setMessage("");

      const updateStep = (key: string, patch: Partial<AgentExecutionStep>) => {
        setAgentQueue((prev) =>
          prev.map((step) => (step.key === key ? { ...step, ...patch } : step)),
        );
      };

      try {
        updateStep(nextStep.key, { status: "running" });

        let result: { txid: string; detail: string } | null = null;

        if (nextStep.key === "refresh-state") {
          await loadState();
          result = { txid: "", detail: "Status refreshed" };
        } else if (nextStep.key === "register-business") {
          const existing = await getBusinessAccount(connection, ownerPubkey);
          if (existing) {
            result = { detail: "Company is already registered (on-chain verified)", txid: "" };
            setBusinessExists(true);
          } else {
            const regRes = await registerBusiness(connection, wallet);
            result = { txid: regRes.txid, detail: "Business successfully registered." };
            setBusinessExists(true);
          }
        } else if (nextStep.key === "create-vault-pda-token") {
          const business = await getBusinessAccount(connection, ownerPubkey);
          if (business) {
            const vault = await getVaultAccount(connection, business.address);
            if (vault) {
              setVaultTokenAccount(vault.tokenAccount.toBase58());
              setVaultExists(true);
              result = {
                txid: "",
                detail: "Vault token account already exists (on-chain verified)",
              };
            }
          }

          if (!result) {
            const [businessPDA] = getBusinessPDA(ownerPubkey);
            const [vaultPDA] = getVaultPDA(businessPDA);
            const res = await createVaultTokenAccount(
              connection,
              wallet,
              vaultPDA,
              PAYUSD_MINT,
            );
            setVaultTokenAccount(res.tokenAccount.toBase58());
            result = { txid: res.txid, detail: "Vault token account created." };
          }
        } else if (nextStep.key === "init-vault") {
          const business = await getBusinessAccount(connection, ownerPubkey);
          if (!business) throw new Error("Company profile not found in blockchain state");

          const vault = await getVaultAccount(connection, business.address);
          if (vault) {
            result = { detail: "Payroll vault is already initialized (on-chain verified)", txid: "" };
            setVaultExists(true);
          } else {
            const token = mustPubkey(
              "payroll wallet token account",
              vaultTokenAccount,
            );
            const initRes = await initVault(connection, wallet, token, PAYUSD_MINT);
            result = { txid: initRes.txid, detail: "Vault initialized successfully." };
            setVaultExists(true);
          }
        } else if (nextStep.key === "create-depositor-token") {
          if (!ownerPubkey) throw new Error("Wallet not connected");

          // Check if a depositor token account already exists (from ref, state, or localStorage)
          const existingDepositor = depositorTokenAccountRef.current || depositorTokenAccount;
          if (existingDepositor) {
            try {
              const existingPubkey = new PublicKey(existingDepositor);
              const acctInfo = await connection.getAccountInfo(existingPubkey, 'confirmed');
              if (acctInfo && acctInfo.owner.toBase58() === INCO_TOKEN_PROGRAM_ID.toBase58()) {
                // Account exists on-chain and is a valid token account — reuse it, skip creation
                setDepositorTokenAccount(existingDepositor);
                depositorTokenAccountRef.current = existingDepositor;
                result = { txid: "", detail: "Company source account already exists (on-chain verified)" };
              }
            } catch {
              // Invalid pubkey or RPC error — fall through to create a new one
            }
          }

          if (!result) {
            const { txid, tokenAccount } = await createIncoTokenAccount(
              connection,
              wallet,
              ownerPubkey,
              PAYUSD_MINT,
            );
            const tokenAddr = tokenAccount.toBase58();
            setDepositorTokenAccount(tokenAddr);
            depositorTokenAccountRef.current = tokenAddr;
            result = { txid, detail: "Company source account created." };
          }
        } else if (nextStep.key === "mint-demo-tokens") {
          const currentDepositorToken = depositorTokenAccountRef.current || depositorTokenAccount;
          if (!currentDepositorToken) throw new Error("No company source account found to fund.");
          const resp = await fetch('/api/faucet/mint-payusd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userConfidentialTokenAccount: currentDepositorToken }),
          });
          const json = await resp.json();
          if (!resp.ok || !json?.ok) throw new Error(json?.error || 'Faucet failed');
          result = { txid: json.tx, detail: "Minted 1,000 demo PAYUSD." };
        } else if (nextStep.key === "configure-deposit-amount") {
          updateStep(nextStep.key, { status: "done", detail: "TRIGGER_DEPOSIT_PROMPT" });
          setAgentPhase("ask_funding");
          result = { txid: "", detail: "PAUSE_FOR_DEPOSIT" };
        } else if (nextStep.key === "deposit-funds") {
          if (!ownerPubkey) throw new Error("Wallet not connected");
          const business = await getBusinessAccount(connection, ownerPubkey);
          if (!business) throw new Error("Business not found");
          const vault = await getVaultAccount(connection, business.address);
          if (!vault) throw new Error("Vault not found");
          const currentDepositorToken = depositorTokenAccountRef.current || depositorTokenAccount;
          if (!currentDepositorToken) throw new Error("Please paste your Company Source Token Account address in Step 2.");
          if (!depositAmount || Number(depositAmount) <= 0) throw new Error("Please enter a valid deposit amount in Step 2.");

          const depositorToken = mustPubkey(
            "source token account",
            currentDepositorToken,
          );
          const amount = Number(depositAmount);
          const txid = await deposit(
            connection,
            wallet,
            depositorToken,
            vault.tokenAccount,
            amount,
          );

          // Instantly update UI state so Step 2 turns green
          const currentBal = Number(vaultBalance || 0);
          setVaultBalance((currentBal + amount).toString());

          result = { txid, detail: `Deposited ${amount} payUSD into payroll wallet.` };
        } else if (nextStep.key === "init-automation") {
          const keeper = mustPubkey(
            "automation service wallet",
            effectiveKeeperPubkey,
          );
          const initAutoRes = await initStreamConfigV2(
            connection,
            wallet,
            keeper,
            Number(settleIntervalSecs),
          );
          result = { txid: initAutoRes.txid, detail: "Automation service initialized." };
        } else if (nextStep.key === "rotate-automation") {
          const rotateRes = await rotateAutomationWalletTask();
          result = { txid: rotateRes.txid, detail: rotateRes.message || "Automation wallet rotated." };
        } else if (nextStep.key === "create-worker-token") {
          const workerWallet = employeeWallet.trim();
          if (!workerWallet)
            throw new Error(
              "Worker wallet address is missing. Please provide one.",
            );
          const workerTokenRes = await createWorkerDestinationAccountTask();
          result = { txid: workerTokenRes.txid, detail: "Worker destination account created." };
        } else if (nextStep.key === "configure-worker-options") {
          // This step triggers the ask_options conversational flow in AgentChat
          // No transaction needed — mark it done so we can move to the next step later
          updateStep(nextStep.key, { status: "done", detail: "TRIGGER_ASK_OPTIONS" });
          setAgentPhase("ask_options");
          result = {
            txid: "",
            detail: "TRIGGER_ASK_OPTIONS",
          };
        } else if (nextStep.key === "create-worker-record") {
          const workerWallet = employeeWallet.trim();
          if (!workerWallet)
            throw new Error(
              "Worker wallet address is missing. Please provide one.",
            );
          const workerRecordRes = await createWorkerPayrollRecordTask();
          result = {
            txid: workerRecordRes.txid,
            detail: workerRecordRes.message || "Worker payroll record created successfully.",
          };
        } else if (nextStep.key === "enable-high-speed") {
          const index = Number(streamIndexInput);
          const txid = await delegateStreamV2(
            connection,
            wallet,
            ownerPubkey,
            index,
          );
          result = { txid, detail: "High-speed mode enabled via TEE." };
        } else if (nextStep.key === "pause-stream") {
          const txid = await pauseStreamV2(connection, wallet, ownerPubkey, 1);
          result = { txid, detail: "Payroll stream paused." };
        } else if (nextStep.key === "resume-stream") {
          const txid = await resumeStreamV2(connection, wallet);
          result = { txid, detail: "Payroll stream resumed." };
        } else if (nextStep.key === "apply-raise") {
          const index = Number(streamIndexInput);
          const rate = Number(agentDraft?.salaryPerSecond || salaryPerSecond);
          const txid = await updateSalaryRateV2(
            connection,
            wallet,
            index,
            rate,
          );
          result = { txid, detail: "Salary rate updated successfully." };
        } else if (nextStep.key === "apply-bonus") {
          const index = Number(streamIndexInput);
          const amount = Number(agentDraft?.bonusAmount || bonusAmount);
          const txid = await grantBonusV2(connection, wallet, index, amount);
          result = { txid, detail: `Bonus of ${amount} granted.` };
        } else if (nextStep.key === "deactivate-stream") {
          const index = Number(streamIndexInput);
          const txid = await deactivateStreamV2(connection, wallet, index);
          result = { txid, detail: "Payroll stream deactivated." };
        } else if (nextStep.key === "grant-worker-access") {
          const index = Number(streamIndexInput);
          const employee = mustPubkey("worker wallet", employeeWallet);
          const txid = await grantEmployeeViewAccessV2(
            connection,
            wallet,
            ownerPubkey,
            index,
            employee,
          );
          result = { txid, detail: "Worker view access granted." };
        } else if (nextStep.key === "grant-keeper-access") {
          const index = Number(streamIndexInput);
          const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
          if (!keeperKey) throw new Error("automation wallet missing");
          const keeper = mustPubkey("automation wallet", keeperKey);
          const txid = await grantKeeperViewAccessV2(
            connection,
            wallet,
            ownerPubkey,
            index,
            keeper,
          );
          result = { txid, detail: "Automation service access granted." };
        } else if (nextStep.key === "rotate-vault-mint") {
          const token = mustPubkey(
            "payroll wallet token account",
            vaultTokenAccount,
          );
          const txid = await rotateVaultTokenAccount(
            connection,
            wallet,
            token,
            PAYUSD_MINT,
          );
          result = {
            txid,
            detail: "Payroll wallet mint updated to latest.",
          };
        } else if (nextStep.key === "admin-withdraw-vault") {
          if (!ownerPubkey) throw new Error("Wallet not connected");
          const destinationToken =
            vaultWithdrawTokenAccount || depositorTokenAccountRef.current || depositorTokenAccount;
          if (!destinationToken)
            throw new Error(
              "Destination token account is missing. Create a source account first.",
            );
          const destination = mustPubkey(
            "destination token account",
            destinationToken,
          );
          const amount = parsePositiveNumber(
            "Withdraw amount",
            vaultWithdrawAmount,
          );
          const txid = await adminWithdrawVaultV2(
            connection,
            wallet,
            destination,
            amount,
          );
          result = { txid, detail: `Recovered ${amount} payUSD from vault.` };
        }

        const txid = result?.txid || "";
        const detail = result?.detail || "Success";
        updateStep(nextStep.key, { status: "done", txid, detail });
        await loadState();

        return { ...nextStep, status: "done", txid, detail };
      } catch (e: any) {
        if (runId !== runIdRef.current) throw new Error("ABORTED"); // Abort if cancelled

        if (e?.message === "PAUSE_FOR_DEPOSIT") throw e;

        const msg = e?.message || "Step failed";
        updateStep(nextStep.key, { status: "failed", detail: msg });
        setError(msg);
        throw e;
      } finally {
        if (runId === runIdRef.current) {
          setBusy(false);
          setAgentExecuteBusy(false);
        }
      }
    }, [
      agentDraft,
      agentExecuteBusy,
      agentQueue,
      buildAgentExecutionQueue,
      connection,
      createWorkerDestinationAccountTask,
      createWorkerPayrollRecordTask,
      effectiveKeeperPubkey,
      employeeWallet,
      loadState,
      ownerPubkey,
      rotateAutomationWalletTask,
      settleIntervalSecs,
      streamIndexInput,
      wallet,
    ]);

  const draftWithAssistant = useCallback(async () => {
    const instruction = agentPrompt.trim();
    if (!instruction) {
      setError(
        'Type a payroll instruction first (for example: "Pay 30 per hour for 7 days").',
      );
      return;
    }
    setAgentBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          current: {
            employeeWallet,
            payPreset,
            payAmount,
            fixedTotalDays,
            salaryPerSecond,
            boundPresetPeriod,
          },
        }),
      });
      const json = (await response.json()) as
        | { ok: true; plan: AgentPlanDraft }
        | { ok: false; error?: string };

      if (!response.ok || !json.ok) {
        throw new Error(
          (json as { error?: string })?.error || "Failed to draft payroll plan",
        );
      }

      const draft = json.plan;
      setAgentDraft(draft);
      applyAgentDraft(draft);
      const confidencePct = Math.round((draft.confidence || 0) * 100);
      setMessage(
        `Assistant draft applied (${draft.source}, ${confidencePct}% confidence). Review Step 3 and click "Create Worker Payroll Record".`,
      );
    } catch (e: any) {
      setError(e?.message || "Assistant draft failed");
    } finally {
      setAgentBusy(false);
    }
  }, [
    agentPrompt,
    applyAgentDraft,
    boundPresetPeriod,
    employeeWallet,
    fixedTotalDays,
    payAmount,
    payPreset,
    salaryPerSecond,
  ]);

  const handleChatDraftPlan = useCallback(
    async (instruction: string, _current: Record<string, unknown>) => {
      try {
        const response = await fetch("/api/agent/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction,
            current: {
              employeeWallet,
              payPreset,
              payAmount,
              fixedTotalDays,
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
    [
      employeeWallet,
      payPreset,
      payAmount,
      fixedTotalDays,
      salaryPerSecond,
      boundPresetPeriod,
    ],
  );

  const handleChatApplyPlan = useCallback((plan: Record<string, unknown>) => {
    if (plan.employeeWallet && typeof plan.employeeWallet === "string") {
      if (plan.employeeWallet === "USE_MY_WALLET" && wallet.publicKey) {
        setEmployeeWallet(wallet.publicKey.toBase58());
      } else if (plan.employeeWallet !== "USE_MY_WALLET") {
        setEmployeeWallet(plan.employeeWallet);
      }
    }
    if (
      plan.payPreset &&
      typeof plan.payPreset === "string" &&
      isPayPreset(plan.payPreset)
    )
      setPayPreset(plan.payPreset);
    if (plan.payAmount && (typeof plan.payAmount === "string" || typeof plan.payAmount === "number"))
      setPayAmount(String(plan.payAmount));
    if (plan.fixedTotalDays && (typeof plan.fixedTotalDays === "string" || typeof plan.fixedTotalDays === "number"))
      setFixedTotalDays(String(plan.fixedTotalDays));
    if (plan.salaryPerSecond && (typeof plan.salaryPerSecond === "string" || typeof plan.salaryPerSecond === "number"))
      setSalaryPerSecond(String(plan.salaryPerSecond));
    setBoundPresetPeriod(typeof plan.boundPresetPeriod === "boolean" ? plan.boundPresetPeriod : true);
    if (typeof plan.streamIndex === "number" || typeof plan.streamIndex === "string")
      setStreamIndexInput(String(plan.streamIndex));
    if (plan.bonusAmount && (typeof plan.bonusAmount === "string" || typeof plan.bonusAmount === "number"))
      setBonusAmount(String(plan.bonusAmount));
    if (plan.depositAmount && (typeof plan.depositAmount === "string" || typeof plan.depositAmount === "number")) {
      setDepositAmount(String(plan.depositAmount));
      setHasConfirmedDeposit(true);
    }
    setAutoGrantDecrypt(typeof plan.autoGrantDecrypt === "boolean" ? plan.autoGrantDecrypt : true);
    setAutoGrantKeeperDecrypt(typeof plan.autoGrantKeeperDecrypt === "boolean" ? plan.autoGrantKeeperDecrypt : true);
    if (plan.recoverAmount && (typeof plan.recoverAmount === "string" || typeof plan.recoverAmount === "number"))
      setVaultWithdrawAmount(String(plan.recoverAmount));
    if (plan.intent && typeof plan.intent === "string") {
      setAgentDraft((prev) => ({ ...prev!, intent: plan.intent as string }));
    } else {
      // If applying a plan update (like a wallet paste or pay plan) without an explicit intent,
      // and we don't have a live stream yet, default to 'create_stream' to ensure the queue builds setup steps.
      setAgentDraft((prev) => {
        if (prev?.intent) return prev;
        const hasStream = streamStatus?.streamIndex !== undefined && streamStatus?.streamIndex !== null;
        return { ...prev!, intent: hasStream ? 'update_stream' : 'create_stream' };
      });
    }
  }, [depositorTokenAccount, wallet.publicKey]);

  const handleCancelBusy = useCallback(() => {
    runIdRef.current += 1; // Invalidate any pending execution promises
    setBusy(false);
    setAgentExecuteBusy(false);
    setAgentQueue(prev => prev.map(s => s.status === 'running' ? { ...s, status: 'pending' } : s));
    setError("Operation was manually cancelled by the user.");
  }, []);

  const handleChatExecute = useCallback(
    async (mode: "all" | "next" = "all") => {
      if (mode === "next") {
        return await executeNextAgentStep();
      }
      await executeAgentQueue();
      return null;
    },
    [executeAgentQueue, executeNextAgentStep],
  );

  return (
    <PageShell
      icon="◈"
      title="OnyxFii"
      subtitle={COPY.employer.subtitle}
      navItems={[
        { href: "/", label: COPY.nav.home },
        { href: "/employer", label: COPY.nav.company },
        { href: "/employee", label: COPY.nav.worker },
        { href: "/bridge", label: COPY.nav.bridge, advanced: true },
      ]}
    >
      <Head>
        <title>OnyxFii Agent | Real-time Agentic Private Payroll</title>
      </Head>

      <AgentChat
        walletConnected={!!wallet.connected}
        walletAddress={wallet.publicKey?.toBase58() || ''}
        businessExists={businessExists}
        vaultExists={vaultExists}
        configExists={v2ConfigExists}
        depositorBalance={depositorBalance}
        vaultBalance={vaultBalance}
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
        ready={initialDataLoaded}
        hydrated={agentRunHydrated}
        onCancelBusy={handleCancelBusy}
        onClearChat={() => {
          agentGreetedRef.current = false;
          setAgentDraft(null);
          setAgentQueue([]);
        }}
        autoGrantDecrypt={autoGrantDecrypt}
        setAutoGrantDecrypt={setAutoGrantDecrypt}
        autoGrantKeeperDecrypt={autoGrantKeeperDecrypt}
        setAutoGrantKeeperDecrypt={setAutoGrantKeeperDecrypt}
        boundPresetPeriod={boundPresetPeriod}
        setBoundPresetPeriod={setBoundPresetPeriod}
      />

      <button
        className="advanced-mode-toggle"
        onClick={() => setShowAdvancedMode((prev) => !prev)}
      >
        {showAdvancedMode
          ? "▲ Hide Advanced Mode"
          : "▼ Show Advanced Mode (Manual Controls)"}
      </button>

      {showAdvancedMode && (
        <>
          <section className="hero-card">
            <p className="hero-eyebrow">Advanced manual controls</p>
            <h1 className="hero-title">{COPY.employer.title}</h1>
            <p className="hero-subtitle">
              Manual step-by-step payroll setup. For power users who want full
              control.
            </p>

            <div className="mt-4 readiness-grid">
              <div className="readiness-item">
                <span className="readiness-label">Wallet connected</span>
                <span className="readiness-value">
                  {wallet.connected ? "Ready" : "Not connected"}
                </span>
              </div>
              <div className="readiness-item">
                <span className="readiness-label">Company setup</span>
                <span className="readiness-value">
                  {businessExists ? "Complete" : "Pending"}
                </span>
              </div>
              <div className="readiness-item">
                <span className="readiness-label">Payroll wallet funded</span>
                <span className="readiness-value">
                  {vaultExists ? "Ready" : "Pending"}
                </span>
              </div>
              <div className="readiness-item">
                <span className="readiness-label">Worker record</span>
                <span className="readiness-value">
                  {hasWorkerRecord ? "Ready" : "Pending"}
                </span>
              </div>
              <div className="readiness-item">
                <span className="readiness-label">High-speed mode</span>
                <span className="readiness-value">
                  {highSpeedOn ? "On" : "Off"}
                </span>
              </div>
              <div className="readiness-item">
                <span className="readiness-label">Automation service</span>
                <span className="readiness-value">{automationStatusLabel}</span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                disabled={!ownerPubkey}
                onClick={() => {
                  if (typeof window === "undefined" || !ownerPubkey) return;
                  const owner = ownerPubkey.toBase58();
                  const key = `expensee_employer_state_v2:${owner}`;
                  try {
                    window.localStorage.removeItem(key);
                  } catch {
                    // ignore
                  }
                  setVaultTokenAccount("");
                  setDepositorTokenAccount("");
                  setVaultWithdrawAmount("1");
                  setVaultWithdrawTokenAccount("");
                  setEmployeeWallet("");
                  setEmployeeTokenAccount("");
                  setSalaryPerSecond("0.0001");
                  setStreamIndexInput("0");
                  setAgentPrompt("");
                  setAgentDraft(null);
                  setAgentQueue([]);
                  void fetchWithTimeout(
                    `/api/agent/run-state?owner=${encodeURIComponent(owner)}&scope=employer`,
                    { method: "DELETE" },
                  ).catch(() => {
                    // ignore
                  });
                  setMessage("Cleared saved form values.");
                }}
                className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
              >
                Clear saved form
              </button>
              <button
                disabled={!ownerPubkey}
                onClick={() => {
                  if (!ownerPubkey) return;
                  const next =
                    DEFAULT_AUTOMATION_WALLET || ownerPubkey.toBase58();
                  setKeeperPubkey(next);
                  setMessage(
                    DEFAULT_AUTOMATION_WALLET
                      ? "Automation service wallet reset to default keeper."
                      : "Automation service wallet set to your current wallet for demo.",
                  );
                }}
                className="rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50"
              >
                {DEFAULT_AUTOMATION_WALLET
                  ? "Use default automation wallet"
                  : "Use this wallet for automation (demo)"}
              </button>
            </div>

            {busy ? (
              <ActionResult kind="info">
                In progress: {busyAction || "Waiting for wallet approval..."}
              </ActionResult>
            ) : null}
            {message ? (
              <ActionResult kind="success">{message}</ActionResult>
            ) : null}
            {error ? <ActionResult kind="error">{error}</ActionResult> : null}
            {automationMismatch ? (
              <ActionResult kind="warning">
                Automation service wallet mismatch detected. Rotate Step 3 once
                so payouts never get stuck with `keeper_not_authorized`.
              </ActionResult>
            ) : null}
            {lastTx ? (
              <p className="mt-3 text-sm text-gray-700">
                Last action ({lastTx.label}):{" "}
                <a
                  href={explorerTxUrl(lastTx.sig)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[#005B96] underline"
                >
                  {lastTx.sig}
                </a>
              </p>
            ) : null}

            <AdvancedDetails title="Advanced details">
              <div className="grid gap-1 text-sm">
                <div>payUSD mint: {PAYUSD_MINT.toBase58()}</div>
                {derived ? (
                  <>
                    <div>
                      Company account ID: {derived.businessPDA.toBase58()}
                    </div>
                    <div>Payroll vault ID: {derived.vaultPDA.toBase58()}</div>
                  </>
                ) : null}
                {vaultTokenAccount ? (
                  <div>Payroll vault token account: {vaultTokenAccount}</div>
                ) : null}
                {v2Config ? (
                  <>
                    <div>Automation service wallet: {v2Config.keeper}</div>
                    <div>
                      Settlement interval: {v2Config.settleIntervalSecs}s
                    </div>
                    <div>
                      Paused:{" "}
                      {v2Config.isPaused
                        ? `yes (reason ${v2Config.pauseReason})`
                        : "no"}
                    </div>
                    <div>Next payroll record: {v2Config.nextStreamIndex}</div>
                  </>
                ) : null}
              </div>
            </AdvancedDetails>
          </section>

          {!wallet.connected ? (
            <section className="panel-card">
              <p className="text-sm text-gray-700">
                Connect a wallet to continue.
              </p>
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
                    onClick={() =>
                      run("Create company profile", async () => {
                        await registerBusiness(connection, wallet);
                      })
                    }
                    className="w-full rounded-lg bg-[#2D2D2A] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Create Company Profile
                  </button>
                  <button
                    disabled={busy || !ownerPubkey}
                    onClick={() =>
                      run("Create payroll wallet", async () => {
                        if (!ownerPubkey)
                          throw new Error("Wallet not connected");
                        const [businessPDA] = getBusinessPDA(ownerPubkey);
                        const [vaultPDA] = getVaultPDA(businessPDA);
                        const { txid, tokenAccount } =
                          await createVaultTokenAccount(
                            connection,
                            wallet,
                            vaultPDA,
                            PAYUSD_MINT,
                          );
                        setVaultTokenAccount(tokenAccount.toBase58());
                        return txid;
                      })
                    }
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
                  onClick={() =>
                    run("Initialize payroll wallet", async () => {
                      const token = mustPubkey(
                        "payroll wallet token account",
                        vaultTokenAccount,
                      );
                      await initVault(connection, wallet, token, PAYUSD_MINT);
                    })
                  }
                  className="mt-3 w-full rounded-lg bg-[#3E6B48] px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Initialize Payroll Wallet
                </button>

                <InlineHelp>
                  If you already used an older mint, click “Fix payroll wallet
                  mint” in Advanced details below.
                </InlineHelp>

                <AdvancedDetails title="Advanced details">
                  <button
                    disabled={
                      busy ||
                      !businessExists ||
                      !vaultExists ||
                      !vaultTokenAccount
                    }
                    onClick={() =>
                      run("Fix payroll wallet mint", async () => {
                        const token = mustPubkey(
                          "payroll wallet token account",
                          vaultTokenAccount,
                        );
                        return rotateVaultTokenAccount(
                          connection,
                          wallet,
                          token,
                          PAYUSD_MINT,
                        );
                      })
                    }
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
                    onClick={() =>
                      run("Create company source account", async () => {
                        if (!wallet.publicKey)
                          throw new Error("Wallet not connected");
                        const { txid, tokenAccount } =
                          await createIncoTokenAccount(
                            connection,
                            wallet,
                            wallet.publicKey,
                            PAYUSD_MINT,
                          );
                        setDepositorTokenAccount(tokenAccount.toBase58());
                        setVaultWithdrawTokenAccount(
                          (prev) => prev || tokenAccount.toBase58(),
                        );
                        return txid;
                      })
                    }
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Create Company Source Account
                  </button>

                  <div>
                    <button
                      disabled={busy || !wallet.publicKey || !depositorTokenAccount}
                      onClick={() =>
                        run("Get demo payroll tokens", async () => {
                          if (!wallet.publicKey) throw new Error("Wallet not connected");
                          if (!depositorTokenAccount) throw new Error("Create your company source account first");
                          const resp = await fetch('/api/faucet/mint-payusd', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userConfidentialTokenAccount: depositorTokenAccount }),
                          });
                          const json = await resp.json();
                          if (!resp.ok || !json?.ok) throw new Error(json?.error || 'Faucet failed');
                          return `Minted 1,000 PAYUSD! tx: ${json.tx}`;
                        })
                      }
                      className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                    >
                      Get 1,000 Demo Tokens
                    </button>
                    <p className="mt-1 text-[11px] text-gray-500 leading-tight">
                      Devnet demo faucet: adds test payroll tokens to your company source account.
                    </p>
                  </div>

                  <button
                    disabled={
                      busy ||
                      !businessExists ||
                      !vaultExists ||
                      !depositorTokenAccount
                    }
                    onClick={() =>
                      run("Add payroll funds", async () => {
                        if (!ownerPubkey)
                          throw new Error("Wallet not connected");
                        const business = await getBusinessAccount(
                          connection,
                          ownerPubkey,
                        );
                        if (!business) throw new Error("Business not found");
                        const vault = await getVaultAccount(
                          connection,
                          business.address,
                        );
                        if (!vault) throw new Error("Vault not found");
                        const depositorToken = mustPubkey(
                          "source token account",
                          depositorTokenAccount,
                        );
                        await deposit(
                          connection,
                          wallet,
                          depositorToken,
                          vault.tokenAccount,
                          Number(depositAmount),
                        );
                      })
                    }
                    className="w-full md:col-span-2 rounded-lg bg-[#005B96] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                  >
                    Add Funds to Payroll Wallet
                  </button>
                </div>

                <InlineHelp>
                  Fund the company source token account first, then add funds to payroll wallet.
                </InlineHelp>

                <AdvancedDetails title="Advanced details">
                  <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <div className="text-xs font-medium text-gray-700">
                      Recover unused payroll funds (owner)
                    </div>
                    <input
                      value={vaultWithdrawAmount}
                      onChange={(e) => setVaultWithdrawAmount(e.target.value)}
                      placeholder="Amount to recover"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    <input
                      value={vaultWithdrawTokenAccount}
                      onChange={(e) =>
                        setVaultWithdrawTokenAccount(e.target.value)
                      }
                      placeholder="Destination token account"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    <button
                      disabled={
                        busy ||
                        !businessExists ||
                        !vaultExists ||
                        !vaultWithdrawTokenAccount
                      }
                      onClick={() =>
                        run("Recover unused payroll funds", async () => {
                          const destination = mustPubkey(
                            "destination token account",
                            vaultWithdrawTokenAccount,
                          );
                          const amount = parsePositiveNumber(
                            "Withdraw amount",
                            vaultWithdrawAmount,
                          );
                          return adminWithdrawVaultV2(
                            connection,
                            wallet,
                            destination,
                            amount,
                          );
                        })
                      }
                      className="w-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 disabled:opacity-50"
                    >
                      Recover Unused Funds
                    </button>
                    <button
                      disabled={busy || !depositorTokenAccount}
                      onClick={() =>
                        setVaultWithdrawTokenAccount(depositorTokenAccount)
                      }
                      className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Recover Funds
                    </button>

                    <div className="mt-4 pt-4 border-t border-gray-200">
                      <div className="text-xs font-medium text-gray-700 mb-2">
                        Need to use real USDC?
                      </div>
                      <Link href="/bridge" className="block w-full text-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                        Open the PAYUSD Bridge
                      </Link>
                    </div>
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
                    onClick={() =>
                      run("Initialize automation service", async () => {
                        const keeper = mustPubkey(
                          "automation service wallet",
                          effectiveKeeperPubkey,
                        );
                        await initStreamConfigV2(
                          connection,
                          wallet,
                          keeper,
                          Number(settleIntervalSecs),
                        );
                      })
                    }
                    className="w-full rounded-lg bg-[#E85D04] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Initialize Automation Service
                  </button>
                  <button
                    disabled={busy || !businessExists || !v2ConfigExists}
                    onClick={() =>
                      run(
                        "Rotate automation service wallet",
                        rotateAutomationWalletTask,
                      )
                    }
                    className="w-full rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm text-orange-900 disabled:opacity-50"
                  >
                    Rotate Automation Wallet
                  </button>
                </div>
                {DEFAULT_AUTOMATION_WALLET ? (
                  <p className="mt-2 text-xs text-gray-500">
                    Default automation wallet is active for all new company
                    setups: {DEFAULT_AUTOMATION_WALLET}
                  </p>
                ) : null}
                {automationMismatch ? (
                  <button
                    disabled={busy || !businessExists || !v2ConfigExists}
                    onClick={() =>
                      run(
                        "Auto-fix automation wallet",
                        rotateAutomationWalletTask,
                      )
                    }
                    className="mt-2 w-full rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-xs text-orange-900 disabled:opacity-50"
                  >
                    Auto-fix Now: Use Active Automation Wallet
                  </button>
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
                    onClick={() =>
                      run(
                        "Create worker destination account",
                        createWorkerDestinationAccountTask,
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
                  >
                    Create Worker Destination Account
                  </button>
                </div>

                <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="mb-2 text-xs font-medium text-gray-700">
                    Pay plan
                  </div>
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
                        <option value="fixed_total">
                          Fixed total over N days
                        </option>
                      </select>
                    </label>
                    <label className="text-xs text-gray-700">
                      {payPreset === "fixed_total"
                        ? "Total amount"
                        : "Amount per period"}
                      <input
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        disabled={busy || payPreset === "per_second"}
                        placeholder={
                          payPreset === "fixed_total" ? "e.g. 5000" : "e.g. 30"
                        }
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                      />
                    </label>
                  </div>
                  {payPreset === "fixed_total" && (
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
                  {payPreset !== "per_second" &&
                    payPreset !== "fixed_total" && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={boundPresetPeriod}
                          onChange={(e) =>
                            setBoundPresetPeriod(e.target.checked)
                          }
                          disabled={busy}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        Stop automatically at end of this period
                      </label>
                    )}

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
                      onChange={(e) =>
                        setAutoGrantKeeperDecrypt(e.target.checked)
                      }
                      disabled={busy}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    Allow automation service to process confidential payout automatically
                  </label>

                  <div className="mt-2 text-xs text-gray-700">
                    Computed per-second rate:{" "}
                    <span className="font-mono">
                      {computedRatePreview === null
                        ? "-"
                        : computedRatePreview.toFixed(9)}
                    </span>
                  </div>
                </div>

                <input
                  value={salaryPerSecond}
                  onChange={(e) => setSalaryPerSecond(e.target.value)}
                  placeholder="Salary per second"
                  disabled={busy || payPreset !== "per_second"}
                  className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
                />

                {/* Worker record options are now configured via the agent chat */}

                <button
                  disabled={busy || !v2ConfigExists}
                  onClick={() =>
                    run(
                      "Create worker payroll record",
                      createWorkerPayrollRecordTask,
                    )
                  }
                  className="mt-3 w-full rounded-lg bg-[#1D3557] px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Create Worker Payroll Record
                </button>

                <InlineHelp>
                  Success means the worker can now open Worker Portal and load
                  this payroll record number.
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
                    onClick={() =>
                      run("Enable high-speed mode", async () => {
                        if (!ownerPubkey || streamIndex === null)
                          throw new Error("Invalid payroll record number");
                        return delegateStreamV2(
                          connection,
                          wallet,
                          ownerPubkey,
                          streamIndex,
                        );
                      })
                    }
                    className="w-full rounded-lg bg-[#6A4C93] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Enable High-Speed Mode
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run("Refresh payroll status", async () => {
                        await loadState();
                      })
                    }
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm"
                  >
                    Refresh Payroll Status
                  </button>
                </div>
                <InlineHelp>
                  High-speed mode is optional. It improves delegated lifecycle
                  behavior for live demos.
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
                    <StatusPill
                      tone={v2Config?.isPaused ? "warning" : "success"}
                    >
                      {v2Config?.isPaused ? "Paused" : "Live"}
                    </StatusPill>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                    <span>Worker payroll record</span>
                    <StatusPill tone={streamStatus ? "success" : "neutral"}>
                      {streamStatus
                        ? `#${streamStatus.streamIndex}`
                        : "Not created"}
                    </StatusPill>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                    <span>High-speed mode</span>
                    <StatusPill tone={highSpeedOn ? "success" : "warning"}>
                      {highSpeedOn ? "On" : "Off"}
                    </StatusPill>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <button
                    disabled={busy || !v2ConfigExists}
                    onClick={() =>
                      run("Pause payroll", async () => {
                        if (!ownerPubkey)
                          throw new Error("Wallet not connected");
                        await pauseStreamV2(connection, wallet, ownerPubkey, 1);
                      })
                    }
                    className="w-full rounded-lg bg-[#8C2F39] px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    Pause Payroll
                  </button>
                  <button
                    disabled={busy || !v2ConfigExists}
                    onClick={() =>
                      run("Resume payroll", async () => {
                        await resumeStreamV2(connection, wallet);
                      })
                    }
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
                          Stream address:{" "}
                          <a
                            href={explorerAddressUrl(streamStatus.address)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 underline"
                          >
                            {streamStatus.address}
                          </a>
                        </div>
                        <div>
                          Destination token account:{" "}
                          {streamStatus.employeeTokenAccount}
                        </div>
                        <div>
                          Active: {streamStatus.isActive ? "yes" : "no"}
                        </div>
                        <div>
                          Delegated (base read):{" "}
                          {streamStatus.isDelegated ? "yes" : "no"}
                        </div>
                        <div>
                          Delegated (router):{" "}
                          {streamRoute?.delegated === null
                            ? "unknown"
                            : streamRoute?.delegated
                              ? "yes"
                              : "no"}
                        </div>
                        <div>Account owner: {streamStatus.owner}</div>
                        <div>
                          Expected delegation owner:{" "}
                          {MAGICBLOCK_DELEGATION_PROGRAM.toBase58()}
                        </div>
                        <div>
                          Last accrual time: {streamStatus.lastAccrualTime}
                        </div>
                        <div>
                          Last settle time: {streamStatus.lastSettleTime}
                        </div>
                        <div>
                          Encrypted accrued handle: {streamStatus.accruedHandle}
                        </div>
                      </>
                    ) : (
                      <p>No payroll record found for the selected number.</p>
                    )}
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <button
                      disabled={
                        busy ||
                        !v2ConfigExists ||
                        streamIndex === null ||
                        !employeeWallet
                      }
                      onClick={() =>
                        run("Grant worker view access", async () => {
                          if (!ownerPubkey || streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          const employee = mustPubkey(
                            "worker wallet",
                            employeeWallet,
                          );
                          return grantEmployeeViewAccessV2(
                            connection,
                            wallet,
                            ownerPubkey,
                            streamIndex,
                            employee,
                          );
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Grant Worker View Access
                    </button>
                    <button
                      disabled={busy || !v2ConfigExists || streamIndex === null}
                      onClick={() =>
                        run("Grant automation decrypt access", async () => {
                          if (!ownerPubkey || streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          const keeperKey =
                            v2Config?.keeper || effectiveKeeperPubkey;
                          if (!keeperKey)
                            throw new Error("Automation wallet missing");
                          const keeper = mustPubkey(
                            "automation wallet",
                            keeperKey,
                          );
                          return grantKeeperViewAccessV2(
                            connection,
                            wallet,
                            ownerPubkey,
                            streamIndex,
                            keeper,
                          );
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Grant Automation Decrypt Access
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-gray-700">
                        Private raise (advanced)
                      </div>
                      <input
                        value={raiseSalaryPerSecond}
                        onChange={(e) =>
                          setRaiseSalaryPerSecond(e.target.value)
                        }
                        placeholder="New salary per second"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                      <button
                        disabled={
                          busy || !v2ConfigExists || streamIndex === null
                        }
                        onClick={() =>
                          run("Apply private raise", async () => {
                            if (streamIndex === null)
                              throw new Error("Invalid payroll record number");
                            const txid = await updateSalaryRateV2(
                              connection,
                              wallet,
                              streamIndex,
                              Number(raiseSalaryPerSecond),
                            );
                            try {
                              if (ownerPubkey && employeeWallet) {
                                const employee = mustPubkey(
                                  "worker wallet",
                                  employeeWallet,
                                );
                                await grantEmployeeViewAccessV2(
                                  connection,
                                  wallet,
                                  ownerPubkey,
                                  streamIndex,
                                  employee,
                                );
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
                      <div className="text-xs font-medium text-gray-700">
                        Private bonus (advanced)
                      </div>
                      <input
                        value={bonusAmount}
                        onChange={(e) => setBonusAmount(e.target.value)}
                        placeholder="Bonus amount"
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                      <button
                        disabled={
                          busy || !v2ConfigExists || streamIndex === null
                        }
                        onClick={() =>
                          run("Apply private bonus", async () => {
                            if (streamIndex === null)
                              throw new Error("Invalid payroll record number");
                            const txid = await grantBonusV2(
                              connection,
                              wallet,
                              streamIndex,
                              Number(bonusAmount),
                            );
                            try {
                              if (ownerPubkey && employeeWallet) {
                                const employee = mustPubkey(
                                  "worker wallet",
                                  employeeWallet,
                                );
                                await grantEmployeeViewAccessV2(
                                  connection,
                                  wallet,
                                  ownerPubkey,
                                  streamIndex,
                                  employee,
                                );
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
                        run("Initialize rate history", async () => {
                          if (streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          const { txid } = await initRateHistoryV2(
                            connection,
                            wallet,
                            streamIndex,
                          );
                          return txid;
                        })
                      }
                      className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Initialize Rate History
                    </button>
                    <button
                      disabled={
                        busy ||
                        !v2ConfigExists ||
                        streamIndex === null ||
                        !streamStatus?.isActive
                      }
                      onClick={() =>
                        run("Deactivate stream", async () => {
                          if (streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          if (streamStatus?.isDelegated)
                            throw new Error(
                              "Undelegate stream before deactivation",
                            );
                          return deactivateStreamV2(
                            connection,
                            wallet,
                            streamIndex,
                          );
                        })
                      }
                      className="w-full rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900 disabled:opacity-50"
                    >
                      Deactivate Stream
                    </button>
                    <button
                      disabled={busy || !v2ConfigExists || !v2Config}
                      onClick={() =>
                        run("Backfill automation decrypt access", async () => {
                          if (!ownerPubkey || !v2Config)
                            throw new Error("Missing config");
                          const keeperKey =
                            v2Config.keeper || effectiveKeeperPubkey;
                          if (!keeperKey)
                            throw new Error("Automation wallet missing");
                          const keeper = mustPubkey(
                            "automation wallet",
                            keeperKey,
                          );
                          const total = v2Config.nextStreamIndex;
                          let granted = 0;
                          let failed = 0;
                          for (let i = 0; i < total; i++) {
                            try {
                              await grantKeeperViewAccessV2(
                                connection,
                                wallet,
                                ownerPubkey,
                                i,
                                keeper,
                              );
                              granted++;
                            } catch (e: any) {
                              const msg = e?.message || "";
                              if (
                                msg.includes("not found") ||
                                msg.includes("Account does not exist")
                              )
                                continue;
                              failed++;
                            }
                          }
                          return `Backfill complete: ${granted} granted, ${failed} failed out of ${total}`;
                        })
                      }
                      className="w-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Backfill Automation Decrypt Access
                    </button>
                  </div>
                </AdvancedDetails>
              </StepCard>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
