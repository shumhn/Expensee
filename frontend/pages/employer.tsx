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
  commitAndUndelegateStreamV2,
  deactivateStreamV2,
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
  getMagicblockValidatorForRegion,
  updateKeeperV2,
  initVault,
  pauseStreamV2,
  registerBusiness,
  redelegateStreamV2,
  resumeStreamV2,
  updateSalaryRateV2,
  revokeViewAccessV2,
  grantAuditorViewAccessV2,
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
type DestinationRouteMode = "private_shield";
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
  agentQueueContextKey?: string;
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

function trimAgentMessages(raw: any[]): any[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-40)
    .map((item) => ({
      id:
        typeof item?.id === "string"
          ? item.id.slice(0, 80)
          : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: item?.role === "user" ? "user" : "agent",
      text:
        typeof item?.text === "string"
          ? item.text.slice(0, 1200)
          : "",
      timestamp:
        typeof item?.timestamp === "number" ? item.timestamp : Date.now(),
    }))
    .filter((m) => m.text.trim().length > 0);
}

function trimAgentQueue(raw: AgentExecutionStep[]): AgentExecutionStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((step) => ({
    ...step,
    detail: typeof step.detail === "string" ? step.detail.slice(0, 220) : undefined,
    txid: typeof step.txid === "string" ? step.txid.slice(0, 120) : undefined,
  }));
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
  const [vaultFundingObserved, setVaultFundingObserved] = useState(false);
  const [depositorTokenAccount, setDepositorTokenAccount] = useState("");
  const depositorTokenAccountRef = useRef(depositorTokenAccount);
  useEffect(() => { depositorTokenAccountRef.current = depositorTokenAccount; }, [depositorTokenAccount]);
  const [vaultWithdrawAmount, setVaultWithdrawAmount] = useState("1");
  const [vaultWithdrawTokenAccount, setVaultWithdrawTokenAccount] =
    useState("");

  const [employeeWallet, setEmployeeWallet] = useState("");
  const [employeeTokenAccount, setEmployeeTokenAccount] = useState("");
  const [destinationRouteMode, setDestinationRouteMode] =
    useState<DestinationRouteMode>("private_shield");
  const [salaryPerSecond, setSalaryPerSecond] = useState("0.0001");
  const [payPreset, setPayPreset] = useState<PayPreset>("per_second");
  const [payAmount, setPayAmount] = useState("100"); // amount per hour/week/month or total amount (fixed_total)
  const [fixedTotalDays, setFixedTotalDays] = useState("30"); // used only when payPreset === 'fixed_total'
  const [boundPresetPeriod, setBoundPresetPeriod] = useState(true);
  const [autoGrantKeeperDecrypt, setAutoGrantKeeperDecrypt] = useState(true);
  const [autoEnableHighSpeedOnCreate, setAutoEnableHighSpeedOnCreate] =
    useState(false);

  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDraft, setAgentDraft] = useState<AgentPlanDraft | null>(null);
  const [agentQueue, setAgentQueue] = useState<AgentExecutionStep[]>([]);
  const [agentQueueContextKey, setAgentQueueContextKey] = useState("");
  const [agentExecuteBusy, setAgentExecuteBusy] = useState(false);
  const [agentEnableHighSpeed, setAgentEnableHighSpeed] = useState(true);
  const [agentApprovalMode, setAgentApprovalMode] =
    useState<AgentApprovalMode>("high_risk_only");
  const [agentRunHydrated, setAgentRunHydrated] = useState(false);
  const [showAdvancedMode, setShowAdvancedMode] = useState(false);
  const [showPrivacyProof, setShowPrivacyProof] = useState(true);
  const [proofToast, setProofToast] = useState("");
  const [proofToastVisible, setProofToastVisible] = useState(false);
  const proofToastTimerRef = useRef<number | null>(null);
  const proofTxCountRef = useRef(0);
  const proofInitRef = useRef(false);

  const [raiseSalaryPerSecond, setRaiseSalaryPerSecond] = useState("0.0001");
  const [bonusAmount, setBonusAmount] = useState("1");

  const [streamIndexInput, setStreamIndexInput] = useState("0");

  const [businessExists, setBusinessExists] = useState(false);
  const [vaultExists, setVaultExists] = useState(false);
  const [v2ConfigExists, setV2ConfigExists] = useState(false);
  const [vaultMintMismatch, setVaultMintMismatch] = useState(false);
  const [fixingVaultMint, setFixingVaultMint] = useState(false);

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
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [statusCheckedAt, setStatusCheckedAt] = useState<number | null>(null);
  const agentGreetedRef = useRef(false);

  const [streamStatus, setStreamStatus] = useState<{
    address: string;
    streamIndex: number;
    hasFixedDestination: boolean;
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

  const activeAgentIntent = useMemo(() => {
    const hasWorkerDraft =
      !!employeeWallet ||
      !!agentDraft?.employeeWallet ||
      !!agentDraft?.payPreset;
    const hasStreamIndex =
      (streamStatus?.streamIndex !== undefined &&
        streamStatus?.streamIndex !== null) ||
      (agentDraft?.streamIndex !== undefined &&
        agentDraft?.streamIndex !== null);
    let intent = (agentDraft && agentDraft.intent) ? agentDraft.intent : "create_stream";
    if (!intent || intent === "unknown" || intent === "none") {
      intent = "create_stream";
    }
    if (hasWorkerDraft && !hasStreamIndex && intent !== "create_stream") {
      intent = "create_stream";
    }
    return intent;
  }, [agentDraft, employeeWallet, streamStatus?.streamIndex]);

  const computedQueueContextKey = useMemo(() => {
    const walletTarget = (
      (agentDraft?.employeeWallet || employeeWallet || "").trim() || "none"
    );
    const streamTarget =
      agentDraft?.streamIndex ??
      streamStatus?.streamIndex ??
      streamIndexInput ??
      "none";
    return [
      `intent:${activeAgentIntent}`,
      `wallet:${walletTarget}`,
      `stream:${String(streamTarget)}`,
      `hs:${agentEnableHighSpeed ? "1" : "0"}`,
      `keeper:${autoGrantKeeperDecrypt ? "1" : "0"}`,
      `bound:${boundPresetPeriod ? "1" : "0"}`,
    ].join("|");
  }, [
    activeAgentIntent,
    agentDraft?.employeeWallet,
    agentDraft?.streamIndex,
    employeeWallet,
    streamStatus?.streamIndex,
    streamIndexInput,
    agentEnableHighSpeed,
    autoGrantKeeperDecrypt,
    boundPresetPeriod,
  ]);

  const hasWorkerRecord = Boolean(streamStatus);
  const hasProgressedPastFunding = v2ConfigExists || hasWorkerRecord;
  const hasVaultFundingSignal = vaultFundingObserved || hasProgressedPastFunding;
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
    vaultFunded: hasVaultFundingSignal,
    configReady: v2ConfigExists,
    hasWorkerRecord,
    highSpeedOn,
  });

  const proofTxs = useMemo(() => {
    const keyOrder = [
      "register-business",
      "create-vault-pda-token",
      "init-vault",
      "create-depositor-token",
      "deposit-funds",
      "init-automation",
      "create-worker-record",
      "grant-keeper-access",
      "enable-high-speed",
    ];
    const labelByKey: Record<string, string> = {
      "register-business": "Register company",
      "create-vault-pda-token": "Create encrypted vault account",
      "init-vault": "Initialize vault custody",
      "create-depositor-token": "Create source account",
      "deposit-funds": "Deposit payroll funds",
      "init-automation": "Initialize automation",
      "create-worker-record": "Create private payroll record",
      "grant-keeper-access": "Grant automation decrypt access",
      "enable-high-speed": "Enable high-speed mode",
    };
    const byKey = new Map(
      agentQueue
        .filter((s) => s.status === "done" && typeof s.txid === "string" && !!s.txid)
        .map((s) => [s.key, s] as const),
    );
    const seen = new Set<string>();
    const rows: { label: string; txid: string; url: string }[] = [];
    for (const key of keyOrder) {
      const step = byKey.get(key);
      if (!step?.txid || seen.has(step.txid)) continue;
      seen.add(step.txid);
      rows.push({
        label: labelByKey[key] || step.label,
        txid: step.txid,
        url: explorerTxUrl(step.txid),
      });
    }
    for (const step of agentQueue) {
      if (step.status !== "done" || !step.txid || seen.has(step.txid)) continue;
      seen.add(step.txid);
      rows.push({
        label: step.label,
        txid: step.txid,
        url: explorerTxUrl(step.txid),
      });
    }
    if (lastTx?.sig && !seen.has(lastTx.sig)) {
      rows.unshift({
        label: lastTx.label || "Latest transaction",
        txid: lastTx.sig,
        url: explorerTxUrl(lastTx.sig),
      });
    }
    return rows.slice(0, 8);
  }, [agentQueue, explorerTxUrl, lastTx]);

  const privacyProof = useMemo(() => {
    const routePrivate =
      streamStatus?.streamIndex !== undefined && streamStatus?.streamIndex !== null
        ? !streamStatus.hasFixedDestination
        : null;
    const plannedPrivateRoute = destinationRouteMode === "private_shield";
    const encryptedHandlePresent = Boolean(streamStatus?.accruedHandle?.trim());
    const keeperGrantDone = agentQueue.some(
      (s) => s.key === "grant-keeper-access" && s.status === "done",
    );
    const privateRecordStep = agentQueue.find(
      (s) => s.key === "create-worker-record" && s.status === "done",
    );
    const privateRecordDone = Boolean(privateRecordStep);
    const privateRecordDetail = (privateRecordStep?.detail || "").toLowerCase();
    const keeperGrantFailed =
      privateRecordDetail.includes("automation decrypt grant failed");
    const keeperGrantSkipped =
      privateRecordDetail.includes("automation decrypt skipped");
    const hasStreamRecord =
      streamStatus?.streamIndex !== undefined && streamStatus?.streamIndex !== null;
    const keeperDecryptReady = Boolean(
      v2ConfigExists &&
      (
        keeperGrantDone ||
        (
          autoGrantKeeperDecrypt &&
          (hasStreamRecord || privateRecordDone) &&
          !keeperGrantFailed &&
          !keeperGrantSkipped
        )
      ),
    );
    const keeperDecryptMode: "manual" | "enforced" | "failed" | "pending" =
      keeperGrantDone
        ? "manual"
        : autoGrantKeeperDecrypt
          ? keeperGrantFailed
            ? "failed"
            : hasStreamRecord || privateRecordDone
              ? "enforced"
              : "pending"
          : "manual";
    const magicBlockDelegated =
      streamStatus?.streamIndex !== undefined && streamStatus?.streamIndex !== null
        ? Boolean(streamStatus.isDelegated || streamRoute?.delegated)
        : null;
    const checks = [routePrivate, encryptedHandlePresent, keeperDecryptReady, magicBlockDelegated];
    const passed = checks.filter((v) => v === true).length;
    const total = checks.length;
    return {
      routePrivate,
      plannedPrivateRoute,
      encryptedHandlePresent,
      keeperDecryptReady,
      keeperDecryptMode,
      magicBlockDelegated,
      streamAddress: streamStatus?.address,
      encryptedReference: streamStatus?.accruedHandle,
      txProofs: proofTxs,
      passed,
      total,
    };
  }, [
    streamStatus,
    destinationRouteMode,
    agentQueue,
    v2ConfigExists,
    autoGrantKeeperDecrypt,
    streamRoute?.delegated,
    proofTxs,
  ]);

  const showProofToastMessage = useCallback((text: string) => {
    setProofToast(text);
    setProofToastVisible(true);
    if (proofToastTimerRef.current) window.clearTimeout(proofToastTimerRef.current);
    proofToastTimerRef.current = window.setTimeout(() => {
      setProofToastVisible(false);
    }, 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (proofToastTimerRef.current) window.clearTimeout(proofToastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const count = privacyProof.txProofs.length;
    if (!proofInitRef.current) {
      proofInitRef.current = true;
      proofTxCountRef.current = count;
      return;
    }
    if (count > proofTxCountRef.current) {
      showProofToastMessage(`Proof refreshed from on-chain tx (${count} records).`);
    }
    proofTxCountRef.current = count;
  }, [privacyProof.txProofs.length, showProofToastMessage]);

  const handleCopyProofTxs = useCallback(async () => {
    if (!privacyProof.txProofs.length) {
      showProofToastMessage("No transaction proofs to copy yet.");
      return;
    }
    const text = privacyProof.txProofs
      .map((tx, i) => `${i + 1}. ${tx.label}\n${tx.url}`)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      showProofToastMessage("Transaction proofs copied.");
    } catch {
      showProofToastMessage("Clipboard blocked. Copy failed.");
    }
  }, [privacyProof.txProofs, showProofToastMessage]);

  const handleDownloadProofReceipt = useCallback(() => {
    const payload = {
      generatedAt: new Date().toISOString(),
      wallet: ownerPubkey?.toBase58() || null,
      checks: {
        routePrivate: privacyProof.routePrivate,
        plannedPrivateRoute: privacyProof.plannedPrivateRoute,
        encryptedHandlePresent: privacyProof.encryptedHandlePresent,
        keeperDecryptReady: privacyProof.keeperDecryptReady,
        magicBlockDelegated: privacyProof.magicBlockDelegated,
      },
      streamAccount: privacyProof.streamAddress || null,
      encryptedReference: privacyProof.encryptedReference || null,
      passed: privacyProof.passed,
      total: privacyProof.total,
      transactions: privacyProof.txProofs.map((tx) => ({
        label: tx.label,
        txid: tx.txid,
        url: tx.url,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `expensee-proof-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showProofToastMessage("Proof receipt downloaded.");
  }, [ownerPubkey, privacyProof, showProofToastMessage]);

  const handleExportProofPdf = useCallback(() => {
    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const lines = [
      `Generated: ${new Date().toLocaleString()}`,
      `Wallet: ${ownerPubkey?.toBase58() || "N/A"}`,
      `Checks Passed: ${privacyProof.passed}/${privacyProof.total}`,
      `Route Privacy: ${privacyProof.routePrivate === null ? "Pending" : privacyProof.routePrivate ? "Pass" : "Fail"}`,
      `Encrypted Ref: ${privacyProof.encryptedHandlePresent ? "Pass" : "Pending"}`,
      `Keeper Decrypt: ${privacyProof.keeperDecryptReady ? "Pass" : "Pending"}`,
      `MagicBlock Delegation: ${privacyProof.magicBlockDelegated === null ? "Pending" : privacyProof.magicBlockDelegated ? "Pass" : "Optional"}`,
      `Stream Account: ${privacyProof.streamAddress || "Not created"}`,
      "",
      "Transaction Proofs:",
      ...(
        privacyProof.txProofs.length
          ? privacyProof.txProofs.map((tx, i) => `${i + 1}. ${tx.label}\n${tx.url}`)
          : ["No transaction proofs captured yet."]
      ),
    ];
    const html = `<!doctype html><html><head><title>Expensee Proof Receipt</title><style>body{font-family:Arial,sans-serif;background:#07090f;color:#fff;padding:24px}h1{font-size:24px;margin:0 0 12px;color:#6fe8ff}pre{white-space:pre-wrap;line-height:1.5;font-size:13px;background:#0d111b;border:1px solid #1d2738;border-radius:10px;padding:16px}</style></head><body><h1>Expensee Privacy Proof Receipt</h1><pre>${escapeHtml(lines.join("\n"))}</pre></body></html>`;
    const win = window.open("", "_blank", "noopener,noreferrer,width=860,height=780");
    if (!win) {
      showProofToastMessage("Popup blocked. Unable to export PDF.");
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    showProofToastMessage("Print dialog opened. Save as PDF.");
  }, [ownerPubkey, privacyProof, showProofToastMessage]);

  const infraStatuses = useMemo(
    () => [
      {
        key: "wallet",
        label: "Wallet",
        ready: Boolean(wallet.connected),
        readyLabel: "Connected",
        pendingLabel: "Disconnected",
        activeClass:
          "bg-emerald-500/10 border-emerald-500/25 text-emerald-400",
        dotClass:
          "bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.65)]",
      },
      {
        key: "business",
        label: "Business",
        ready: businessExists,
        readyLabel: "Registered",
        pendingLabel: "Missing",
        activeClass: "bg-cyan-500/10 border-cyan-500/25 text-cyan-300",
        dotClass: "bg-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.65)]",
      },
      {
        key: "vault",
        label: "Vault",
        ready: vaultExists,
        readyLabel: "Ready",
        pendingLabel: "Missing",
        activeClass:
          "bg-purple-500/10 border-purple-500/25 text-purple-300",
        dotClass:
          "bg-purple-400 shadow-[0_0_10px_rgba(168,85,247,0.65)]",
      },
      {
        key: "worker",
        label: "Worker",
        ready: hasWorkerRecord,
        readyLabel: "Linked",
        pendingLabel: "Not linked",
        activeClass: "bg-blue-500/10 border-blue-500/25 text-blue-300",
        dotClass: "bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.65)]",
      },
      {
        key: "turbo",
        label: "Fast Mode",
        ready: highSpeedOn,
        readyLabel: "Enabled",
        pendingLabel: "Disabled",
        activeClass:
          "bg-orange-500/10 border-orange-500/25 text-orange-300",
        dotClass:
          "bg-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.65)]",
      },
      {
        key: "agent",
        label: "Agent",
        ready: v2ConfigExists,
        readyLabel: "Configured",
        pendingLabel: "Pending",
        activeClass:
          "bg-indigo-500/10 border-indigo-500/25 text-indigo-300",
        dotClass:
          "bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.65)]",
      },
    ],
    [
      wallet.connected,
      businessExists,
      vaultExists,
      hasWorkerRecord,
      highSpeedOn,
      v2ConfigExists,
    ],
  );

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
      setDestinationRouteMode("private_shield");
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
      setAutoGrantKeeperDecrypt(true);
      setAutoEnableHighSpeedOnCreate(
        typeof parsed?.autoEnableHighSpeedOnCreate === "boolean"
          ? parsed.autoEnableHighSpeedOnCreate
          : false,
      );
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
      if (typeof parsed?.vaultFundingObserved === "boolean")
        setVaultFundingObserved(parsed.vaultFundingObserved);
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
      setAgentDraft(null);
      setAgentQueue([]);
      setAgentQueueContextKey("");
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
        if (typeof remote.agentQueueContextKey === "string") {
          setAgentQueueContextKey(remote.agentQueueContextKey);
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
    const payload: AgentRunStatePayload = {
      agentPrompt: agentPrompt.slice(0, 1000),
      agentDraft,
      agentQueue: trimAgentQueue(agentQueue),
      agentQueueContextKey: agentQueueContextKey || computedQueueContextKey,
      agentEnableHighSpeed,
      agentApprovalMode,
      agentMessages: trimAgentMessages(agentMessages),
      agentPhase,
    };
    const timer = window.setTimeout(() => {
      void saveAgentRunState(owner, payload);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    agentApprovalMode,
    agentDraft,
    agentEnableHighSpeed,
    agentPrompt,
    agentQueue,
    agentQueueContextKey,
    computedQueueContextKey,
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
              `🤖 Welcome back to OnyxFii! I've synchronized with the blockchain. \n\n` +
              `📊 Your account status:\n✅ Company registered\n✅ Payroll vault ready\n✅ Automation configured\n\n` +
              `Everything is set up. Paste an **employee auth wallet address** to begin a new payment stream.`,
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
              `🔄 **Chain Sync Notice:** I noticed your on-chain data doesn't match our previous conversation (possibly a new wallet or network reset).\n\n` +
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
    else statusParts.push("⚠️ Company not yet registered");
    if (vaultExists) statusParts.push("✅ Payroll vault ready");
    else statusParts.push("⚠️ Payroll vault needed");
    if (v2ConfigExists) statusParts.push("✅ Automation configured");
    else statusParts.push("⚠️ Automation needed");

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
            `🤖 Welcome back to OnyxFii! I've synchronized with the blockchain. \n\n` +
            `📊 Your account status:\n${statusParts.join("\n")}\n\n` +
            `The company is fully initialized. Ready to set up a new payment stream? Paste an **employee auth wallet address** to begin.`,
          timestamp: Date.now(),
        },
      ]);
      setAgentPhase("ask_wallet");
    } else {
      const stepMsg = nextPending
        ? `🧭 Pending task: **${nextPending.label}**.\n\nType **"go"** and I'll execute it with you.`
        : `It looks like your company setup is incomplete. Type **"setup"** and I'll guide you through the missing initialization steps.`;

      setAgentMessages([
        {
          id: msgId,
          role: "agent",
          text:
            `🤖 Welcome to OnyxFii! I'm your autonomous payroll agent. \n\n` +
            `📊 Your account status:\n${statusParts.join("\n")}\n\n` +
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
          destinationRouteMode,
          salaryPerSecond,
          payPreset,
          payAmount,
          fixedTotalDays,
          boundPresetPeriod,
          autoGrantKeeperDecrypt,
          autoEnableHighSpeedOnCreate,
          streamIndexInput,
          agentApprovalMode,
          hasConfirmedDeposit,
          vaultFundingObserved,
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
    destinationRouteMode,
    keeperPubkey,
    ownerPubkey,
    salaryPerSecond,
    payPreset,
    payAmount,
    fixedTotalDays,
    boundPresetPeriod,
    autoGrantKeeperDecrypt,
    autoEnableHighSpeedOnCreate,
    agentApprovalMode,
    settleIntervalSecs,
    streamIndexInput,
    vaultTokenAccount,
    hasConfirmedDeposit,
    vaultFundingObserved,
  ]);

  const loadState = useCallback(async () => {
    setStatusRefreshing(true);
    if (!ownerPubkey) {
      setBusinessExists(false);
      setVaultExists(false);
      setV2ConfigExists(false);
      setV2Config(null);
      setStreamStatus(null);
      setStatusCheckedAt(Date.now());
      setStatusRefreshing(false);
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
        // Strict mint validation: check vault mint matches platform canonical PAYUSD_MINT
        setVaultMintMismatch(!vault.mint.equals(PAYUSD_MINT));
      } else {
        setVaultMintMismatch(false);
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
            hasFixedDestination: stream.hasFixedDestination,
            employeeTokenAccount: stream.hasFixedDestination
              ? stream.employeeTokenAccount.toBase58()
              : "",
            isActive: stream.isActive,
            isDelegated: stream.isDelegated,
            owner: stream.owner.toBase58(),
            lastAccrualTime: stream.lastAccrualTime,
            lastSettleTime: stream.lastSettleTime,
            accruedHandle: accrued.toString(),
          });

        }
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
    } finally {
      setStatusRefreshing(false);
      setStatusCheckedAt(Date.now());
    }
  }, [connection, ownerPubkey, streamIndex]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!ownerPubkey) return;
    const poll = window.setInterval(() => {
      void loadState();
    }, 20_000);
    return () => window.clearInterval(poll);
  }, [ownerPubkey, loadState]);

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

  const grantAutomationDecryptAccessTask = useCallback(
    async (targetStreamIndex: number) => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      const keeperKey = v2Config?.keeper || effectiveKeeperPubkey;
      if (!keeperKey) throw new Error("Automation wallet missing");
      const keeper = mustPubkey("automation wallet", keeperKey);

      const txid = await grantKeeperViewAccessV2(
        connection,
        wallet,
        ownerPubkey,
        targetStreamIndex,
        keeper,
      );
      const relayTxid = await grantAuditorViewAccessV2(
        connection,
        wallet,
        ownerPubkey,
        targetStreamIndex,
        keeper,
      );
      return {
        txid: relayTxid,
        message: "Automation decrypt + keeper relay reveal access granted.",
      };
    },
    [connection, effectiveKeeperPubkey, ownerPubkey, v2Config?.keeper, wallet],
  );

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
    setAutoGrantKeeperDecrypt(true);
    if (draft.depositAmount) setDepositAmount(draft.depositAmount);
    if (draft.recoverAmount) setVaultWithdrawAmount(draft.recoverAmount);
    if (draft.bonusAmount) setBonusAmount(draft.bonusAmount);
    if (typeof draft.streamIndex === "number")
      setStreamIndexInput(String(draft.streamIndex));
    if (draft.intent) setAgentDraft((prev) => ({ ...prev!, intent: draft.intent }));
  }, []);

  const createWorkerDestinationAccountTask = useCallback(async () => {
    if (!ownerPubkey) throw new Error("Wallet not connected");
    const { txid, tokenAccount } = await createIncoTokenAccount(
      connection,
      wallet,
      ownerPubkey,
      PAYUSD_MINT,
    );
    setEmployeeTokenAccount(tokenAccount.toBase58());
    return { txid, tokenAccount: tokenAccount.toBase58() };
  }, [connection, ownerPubkey, wallet]);

  const createWorkerPayrollRecordTask = useCallback(
    async (
      overrideTokenAccount?: string,
      options?: {
        autoEnableHighSpeed?: boolean;
      },
    ) => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      const employee = mustPubkey("employee auth wallet", employeeWallet);
      const destinationRouteCommitment = PublicKey.default;
      const ratePerSecond = computePerSecondRate();
      const { periodStart, periodEnd } = computePeriodBounds();
      const result = await addEmployeeStreamV2(
        connection,
        wallet,
        employee,
        destinationRouteCommitment,
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

      const decryptMessage = "auth wallet decrypt disabled (privacy mode)";

      let keeperMessage = "automation decrypt skipped";
      if (autoGrantKeeperDecrypt) {
        try {
          const grantRes = await grantAutomationDecryptAccessTask(
            result.streamIndex,
          );
          keeperMessage = grantRes.message;
        } catch (keeperError: any) {
          const reason = keeperError?.message || "unknown error";
          keeperMessage = `automation decrypt grant failed (${reason})`;
        }
      }

      let highSpeedMessage = "high-speed mode remains off";
      if (options?.autoEnableHighSpeed) {
        try {
          const validator = getMagicblockValidatorForRegion("eu");
          await delegateStreamV2(
            connection,
            wallet,
            ownerPubkey,
            result.streamIndex,
            validator,
          );
          highSpeedMessage = "high-speed mode enabled";
        } catch (delegateError: any) {
          const reason = delegateError?.message || "unknown error";
          highSpeedMessage = `high-speed enable failed (${reason})`;
        }
      }

      return {
        txid: result.txid,
        streamIndex: result.streamIndex,
        message: `Private payroll record #${result.streamIndex} created: ${historyMessage}; ${decryptMessage}; ${keeperMessage}; ${highSpeedMessage}.`,
      };
    },
    [
      autoGrantKeeperDecrypt,
      computePeriodBounds,
      connection,
      effectiveKeeperPubkey,
      employeeWallet,
      grantAutomationDecryptAccessTask,
      ownerPubkey,
      getMagicblockValidatorForRegion,
      v2Config?.keeper,
      wallet,
    ],
  );

  const waitForStreamDelegationState = useCallback(
    async (
      businessPda: PublicKey,
      index: number,
      delegated: boolean,
      attempts = 45,
      delayMs = 1000,
    ): Promise<boolean> => {
      for (let i = 0; i < attempts; i += 1) {
        const stream = await getEmployeeStreamV2Account(
          connection,
          businessPda,
          index,
        );
        if (stream && stream.isDelegated === delegated) return true;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return false;
    },
    [connection],
  );

  const runStreamMutationWithHighSpeedRecovery = useCallback(
    async (
      index: number,
      label: string,
      mutate: () => Promise<string>,
      opts?: { forceHighSpeedAfter?: boolean },
    ) => {
      if (!ownerPubkey) throw new Error("Wallet not connected");

      const business = await getBusinessAccount(connection, ownerPubkey);
      if (!business) throw new Error("Business not found");

      const streamBefore = await getEmployeeStreamV2Account(
        connection,
        business.address,
        index,
      );
      if (!streamBefore) throw new Error(`Payroll record #${index} not found`);

      const wasDelegated = streamBefore.isDelegated;
      let didUndelegate = false;
      if (wasDelegated) {
        await commitAndUndelegateStreamV2(connection, wallet, ownerPubkey, index);
        const undelegated = await waitForStreamDelegationState(
          business.address,
          index,
          false,
        );
        if (!undelegated) {
          throw new Error(
            "Undelegation callback is still pending. Retry in a few seconds.",
          );
        }
        didUndelegate = true;
      }

      const txid = await mutate();

      const shouldEnableHighSpeedAfter =
        opts?.forceHighSpeedAfter === true || wasDelegated;
      let didRedelegate = false;
      if (shouldEnableHighSpeedAfter) {
        const streamAfter = await getEmployeeStreamV2Account(
          connection,
          business.address,
          index,
        );
        if (streamAfter?.isActive && !streamAfter.isDelegated) {
          const validator = getMagicblockValidatorForRegion("eu");
          await redelegateStreamV2(
            connection,
            wallet,
            ownerPubkey,
            index,
            validator,
          );
          didRedelegate = true;
        }
      }

      const message =
        didUndelegate && didRedelegate
          ? `${label} applied; temporarily switched to base layer, then re-enabled high-speed mode.`
          : didUndelegate
            ? `${label} applied after temporary base-layer commit+undelegate.`
            : didRedelegate
              ? `${label} applied; high-speed mode re-enabled for this payroll record.`
              : `${label} applied.`;

      return { txid, message };
    },
    [
      connection,
      getMagicblockValidatorForRegion,
      ownerPubkey,
      waitForStreamDelegationState,
      wallet,
    ],
  );

  const ensureHighSpeedForStream = useCallback(
    async (index: number): Promise<boolean> => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      const business = await getBusinessAccount(connection, ownerPubkey);
      if (!business) throw new Error("Business not found");

      const stream = await getEmployeeStreamV2Account(
        connection,
        business.address,
        index,
      );
      if (!stream || !stream.isActive || stream.isDelegated) return false;

      const validator = getMagicblockValidatorForRegion("eu");
      await delegateStreamV2(connection, wallet, ownerPubkey, index, validator);
      return true;
    },
    [connection, getMagicblockValidatorForRegion, ownerPubkey, wallet],
  );

  const deactivateStreamSafelyTask = useCallback(
    async (index: number) => {
      if (!ownerPubkey) throw new Error("Wallet not connected");
      const business = await getBusinessAccount(connection, ownerPubkey);
      if (!business) throw new Error("Business not found");
      const stream = await getEmployeeStreamV2Account(
        connection,
        business.address,
        index,
      );
      if (!stream) throw new Error(`Payroll record #${index} not found`);

      let undelegated = false;
      if (stream.isDelegated) {
        await commitAndUndelegateStreamV2(connection, wallet, ownerPubkey, index);
        const settled = await waitForStreamDelegationState(
          business.address,
          index,
          false,
        );
        if (!settled) {
          throw new Error(
            "Undelegation callback is still pending. Retry in a few seconds.",
          );
        }
        undelegated = true;
      }

      const txid = await deactivateStreamV2(connection, wallet, index);
      return {
        txid,
        message: undelegated
          ? "Stream was delegated, so it was first committed+undelegated, then deactivated."
          : "Stream deactivated.",
      };
    },
    [connection, ownerPubkey, waitForStreamDelegationState, wallet],
  );

  const buildAgentExecutionQueue = useCallback((): AgentExecutionStep[] => {
    const steps: AgentExecutionStep[] = [];
    const intent = activeAgentIntent;

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

    // In privacy mode, avoid plain RPC balance checks. Funding completion is inferred
    // from successful deposit actions or progression to downstream setup steps.
    const hasProgressedPastFunding =
      !!v2ConfigExists || !!employeeTokenAccount.trim();
    const hasVaultFunds = vaultFundingObserved || hasProgressedPastFunding;
    const hasObtainedTokens = hasConfirmedDeposit || hasVaultFunds;
    steps.push({
      key: "mint-demo-tokens",
      label: "Get 1,000 test tokens",
      status: hasObtainedTokens ? "done" : "pending",
      required: true,
      risk: "safe",
      requiresSignature: false,
    });

    steps.push({
      key: "configure-deposit-amount",
      label: "Confirm deposit amount",
      status: hasConfirmedDeposit || hasVaultFunds ? "done" : "pending",
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
        label: "No fixed destination needed (privacy mode)",
        status: "done",
        required: false,
        risk: "safe",
        requiresSignature: false,
      });

      steps.push({
        key: "configure-worker-options",
        label: "Configure auth and privacy options",
        status: "pending",
        required: true,
        risk: "safe",
        requiresSignature: false,
      });

      steps.push({
        key: "create-worker-record",
        label: "Create private payroll record",
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
    agentEnableHighSpeed,
    activeAgentIntent,
    businessExists,
    vaultExists,
    depositorTokenAccount,
    v2ConfigExists,
    effectiveKeeperPubkey,
    v2Config?.keeper,
    employeeTokenAccount,
    destinationRouteMode,
    hasConfirmedDeposit,
    vaultFundingObserved,
  ]);

  // Self-heal the agent queue if the code introduces new steps that aren't in localStorage.
  useEffect(() => {
    if (agentQueue.length > 0) {
      const freshQueue = buildAgentExecutionQueue();
      const currentKeys = agentQueue.map(s => s.key).join(',');
      const freshKeys = freshQueue.map(s => s.key).join(',');
      const sameContext = agentQueueContextKey === computedQueueContextKey;
      if (!sameContext) {
        setAgentQueue(freshQueue);
        setAgentQueueContextKey(computedQueueContextKey);
        return;
      }
      if (currentKeys !== freshKeys) {
        const mergedQueue = freshQueue.map(step => {
          const existing = agentQueue.find(s => s.key === step.key);
          return existing && (existing.status === 'done' || existing.status === 'running')
            ? { ...step, status: existing.status as AgentExecutionStatus, txid: existing.txid, detail: existing.detail }
            : step;
        });
        setAgentQueue(mergedQueue);
        setAgentQueueContextKey(computedQueueContextKey);
      }
    }
  }, [agentQueue, buildAgentExecutionQueue, agentQueueContextKey, computedQueueContextKey]);

  const previewAgentExecution = useCallback(() => {
    const workerWallet = employeeWallet.trim();
    if (!workerWallet) {
      setError(
        "Add an employee auth wallet first (or ask the assistant to include one).",
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
    setAgentQueueContextKey(computedQueueContextKey);
    setMessage("Execution preview ready. Review and run.");
  }, [buildAgentExecutionQueue, employeeWallet, computedQueueContextKey]);

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
    setAgentQueueContextKey(computedQueueContextKey);
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
            setHasConfirmedDeposit(true);
            setVaultFundingObserved(true);

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
            updateStep(step.key, {
              status: "done",
              detail: "Skipped: privacy mode uses claim-time destination.",
            });
            continue;
          }

          if (step.key === "create-worker-record") {
            const workerWallet = employeeWallet.trim();
            if (!workerWallet)
              throw new Error(
                "Employee auth wallet address is missing. Please provide one.",
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
            const validator = getMagicblockValidatorForRegion("eu");
            const txid = await delegateStreamV2(
              connection,
              wallet,
              ownerPubkey,
              validIndex,
              validator,
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
            let detail = "Payroll resumed.";
            if (streamIndex !== null) {
              try {
                const reenabled = await ensureHighSpeedForStream(streamIndex);
                if (reenabled) {
                  detail =
                    "Payroll resumed and high-speed mode re-enabled for the selected payroll record.";
                }
              } catch (resumeHighSpeedError: any) {
                const reason =
                  resumeHighSpeedError?.message || "high-speed re-enable failed";
                detail = `Payroll resumed; high-speed re-enable failed (${reason}).`;
              }
            }
            updateStep(step.key, { status: "done", txid, detail });
            continue;
          }

          if (step.key === "apply-raise") {
            const index = Number(streamIndexInput);
            const rate = Number(agentDraft?.salaryPerSecond || salaryPerSecond);
            const result = await runStreamMutationWithHighSpeedRecovery(
              index,
              "Salary rate update",
              async () =>
                updateSalaryRateV2(
                  connection,
                  wallet,
                  index,
                  rate,
                ),
            );
            updateStep(step.key, {
              status: "done",
              txid: result.txid,
              detail: result.message,
            });
            continue;
          }

          if (step.key === "apply-bonus") {
            const index = Number(streamIndexInput);
            const amount = Number(agentDraft?.bonusAmount || bonusAmount);
            const result = await runStreamMutationWithHighSpeedRecovery(
              index,
              "Bonus grant",
              async () => grantBonusV2(connection, wallet, index, amount),
            );
            updateStep(step.key, {
              status: "done",
              txid: result.txid,
              detail: result.message,
            });
            continue;
          }

          if (step.key === "deactivate-stream") {
            const index = Number(streamIndexInput);
            const result = await deactivateStreamSafelyTask(index);
            updateStep(step.key, {
              status: "done",
              txid: result.txid,
              detail: result.message,
            });
            continue;
          }

          if (step.key === "grant-keeper-access") {
            const index = Number(streamIndexInput);
            const grantRes = await grantAutomationDecryptAccessTask(index);
            updateStep(step.key, {
              status: "done",
              txid: grantRes.txid,
              detail: grantRes.message,
            });
            continue;
          }
        } catch (stepError: any) {
          const stepMessage = stepError?.message || "step failed";
          updateStep(step.key, { status: "failed", detail: stepMessage });
          throw new Error(`${step.label}: ${stepMessage}`);
        }
      }

      setMessage(
        "Assistant execution completed. Review Step 5 and Employee Portal.",
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
    createWorkerPayrollRecordTask,
    deactivateStreamSafelyTask,
    effectiveKeeperPubkey,
    employeeWallet,
    ensureHighSpeedForStream,
    grantAutomationDecryptAccessTask,
    loadState,
    ownerPubkey,
    rotateAutomationWalletTask,
    runStreamMutationWithHighSpeedRecovery,
    settleIntervalSecs,
    computedQueueContextKey,
    streamStatus?.streamIndex,
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
      const sameContext = agentQueueContextKey === computedQueueContextKey;

      // Merge status from existing agentQueue to preserve "done" or "running" status for this session
      const mergedQueue = freshQueue.map((step): AgentExecutionStep => {
        if (!sameContext) return step;
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
      setAgentQueueContextKey(computedQueueContextKey);
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
          result = { txid: json.tx, detail: "Minted 1,000 test PAYUSD." };
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
          setHasConfirmedDeposit(true);
          setVaultFundingObserved(true);

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
          result = {
            txid: "",
            detail: "Skipped: privacy mode uses claim-time destination.",
          };
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
              "Employee auth wallet address is missing. Please provide one.",
            );
          const workerRecordRes = await createWorkerPayrollRecordTask();
          result = {
            txid: workerRecordRes.txid,
            detail: workerRecordRes.message || "Private payroll record created successfully.",
          };
        } else if (nextStep.key === "enable-high-speed") {
          const index = Number(streamIndexInput);
          const validator = getMagicblockValidatorForRegion("eu");
          const txid = await delegateStreamV2(
            connection,
            wallet,
            ownerPubkey,
            index,
            validator,
          );
          result = { txid, detail: "High-speed mode enabled." };
        } else if (nextStep.key === "pause-stream") {
          const txid = await pauseStreamV2(connection, wallet, ownerPubkey, 1);
          result = { txid, detail: "Payroll paused." };
        } else if (nextStep.key === "resume-stream") {
          const txid = await resumeStreamV2(connection, wallet);
          let detail = "Payroll stream resumed.";
          if (streamIndex !== null) {
            try {
              const reenabled = await ensureHighSpeedForStream(streamIndex);
              if (reenabled) {
                detail =
                  "Payroll stream resumed and high-speed mode re-enabled for the selected payroll record.";
              }
            } catch (resumeHighSpeedError: any) {
              const reason =
                resumeHighSpeedError?.message || "high-speed re-enable failed";
              detail = `Payroll stream resumed; high-speed re-enable failed (${reason}).`;
            }
          }
          result = { txid, detail };
        } else if (nextStep.key === "apply-raise") {
          const index = Number(streamIndexInput);
          const rate = Number(agentDraft?.salaryPerSecond || salaryPerSecond);
          const raiseRes = await runStreamMutationWithHighSpeedRecovery(
            index,
            "Salary rate update",
            async () =>
              updateSalaryRateV2(
                connection,
                wallet,
                index,
                rate,
              ),
          );
          result = { txid: raiseRes.txid, detail: raiseRes.message };
        } else if (nextStep.key === "apply-bonus") {
          const index = Number(streamIndexInput);
          const amount = Number(agentDraft?.bonusAmount || bonusAmount);
          const bonusRes = await runStreamMutationWithHighSpeedRecovery(
            index,
            "Bonus grant",
            async () => grantBonusV2(connection, wallet, index, amount),
          );
          result = { txid: bonusRes.txid, detail: bonusRes.message };
        } else if (nextStep.key === "deactivate-stream") {
          const index = Number(streamIndexInput);
          const deactivateRes = await deactivateStreamSafelyTask(index);
          result = {
            txid: deactivateRes.txid,
            detail: deactivateRes.message,
          };
        } else if (nextStep.key === "grant-keeper-access") {
          const index = Number(streamIndexInput);
          const grantRes = await grantAutomationDecryptAccessTask(index);
          result = {
            txid: grantRes.txid,
            detail: grantRes.message,
          };
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
      agentQueueContextKey,
      buildAgentExecutionQueue,
      computedQueueContextKey,
      connection,
      createWorkerPayrollRecordTask,
      deactivateStreamSafelyTask,
      destinationRouteMode,
      effectiveKeeperPubkey,
      employeeWallet,
      ensureHighSpeedForStream,
      grantAutomationDecryptAccessTask,
      loadState,
      ownerPubkey,
      rotateAutomationWalletTask,
      runStreamMutationWithHighSpeedRecovery,
      settleIntervalSecs,
      streamStatus?.streamIndex,
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
        `Assistant draft applied (${draft.source}, ${confidencePct}% confidence). Review Step 3 and click "Create Private Payroll Record".`,
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
    const keeperDecryptPref =
      typeof plan.autoGrantKeeperDecrypt === "boolean"
        ? plan.autoGrantKeeperDecrypt
        : typeof plan.autoGrantDecrypt === "boolean"
          ? plan.autoGrantDecrypt
          : undefined;
    if (typeof keeperDecryptPref === "boolean") {
      setAutoGrantKeeperDecrypt(keeperDecryptPref);
    }
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
  }, [streamStatus?.streamIndex, wallet.publicKey]);

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
      icon=""
      title="Expensee"
      subtitle={COPY.employer.subtitle}
      navItems={[
        { href: "/employee", label: COPY.nav.worker },
        { href: "/bridge", label: COPY.nav.bridge },
      ]}
    >
      <Head>
        <title>Expensee Payroll Console | Realtime Private Payroll</title>
      </Head>
      <div className="sticky top-[5.25rem] z-30 mb-8 px-6 py-4 bg-[var(--app-surface)]/95 backdrop-blur-xl rounded-3xl border border-[var(--app-border)] shadow-2xl overflow-x-auto">
        <div className="flex items-center gap-2 min-w-max whitespace-nowrap">
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--app-muted)] mr-2">Infrastructure Status</span>
          <span className="text-[9px] text-[var(--app-muted)] uppercase tracking-wider mr-1">
            {statusRefreshing
              ? "Checking..."
              : statusCheckedAt
                ? `Updated ${new Date(statusCheckedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
                : "Waiting"}
          </span>
          <button
            type="button"
            onClick={() => void loadState()}
            disabled={statusRefreshing}
            className="shrink-0 px-2 py-1 rounded-lg border border-[var(--app-border)] text-[9px] font-bold uppercase tracking-wider text-[var(--app-muted)] hover:border-cyan-400/50 hover:text-cyan-300 disabled:opacity-40"
          >
            {statusRefreshing ? "Refreshing" : "Refresh"}
          </button>
          {infraStatuses.map((item) => (
            <div
              key={item.key}
              className={`shrink-0 px-2.5 py-1 rounded-xl border flex items-center gap-1.5 transition-all duration-500 ${
                item.ready
                  ? item.activeClass
                  : "bg-[var(--app-surface-alt)] border-[var(--app-border)] text-[var(--app-muted)]"
              }`}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  item.ready ? item.dotClass : "bg-gray-600"
                }`}
              />
              <span className="text-[9px] font-bold uppercase tracking-[0.12em]">
                {item.label}
              </span>
              <span className="text-[9px] uppercase tracking-[0.1em] opacity-85">
                {item.ready ? item.readyLabel : item.pendingLabel}
              </span>
            </div>
          ))}
        </div>
      </div>

      <AgentChat
        walletConnected={!!wallet.connected}
        walletAddress={wallet.publicKey?.toBase58() || ''}
        businessExists={businessExists}
        vaultExists={vaultExists}
        configExists={v2ConfigExists}
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
        ready={initialDataLoaded}
        hydrated={agentRunHydrated}
        onCancelBusy={handleCancelBusy}
        onClearChat={() => {
          agentGreetedRef.current = false;
          setAgentDraft(null);
          setAgentQueue([]);
          setAgentQueueContextKey("");
        }}
        autoGrantKeeperDecrypt={autoGrantKeeperDecrypt}
        setAutoGrantKeeperDecrypt={setAutoGrantKeeperDecrypt}
        boundPresetPeriod={boundPresetPeriod}
        setBoundPresetPeriod={setBoundPresetPeriod}
        proofSummary={{
          routePrivate: privacyProof.routePrivate,
          encryptedHandlePresent: privacyProof.encryptedHandlePresent,
          keeperDecryptReady: privacyProof.keeperDecryptReady,
          magicBlockDelegated: privacyProof.magicBlockDelegated,
          streamAddress: privacyProof.streamAddress,
          encryptedReference: privacyProof.encryptedReference,
          txProofs: privacyProof.txProofs,
        }}
      />

      <section className="mt-6 mb-6 rounded-3xl border border-[var(--app-border)] bg-black/70 backdrop-blur-xl p-5 shadow-xl shadow-cyan-900/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-300">
              Privacy Proof
            </div>
            <h3 className="mt-1 text-xl font-bold text-[var(--app-ink)]">
              Inco Encryption + MagicBlock Verification
            </h3>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
              {privacyProof.passed}/{privacyProof.total} checks passed
            </div>
            <button
              type="button"
              onClick={() => void handleCopyProofTxs()}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[var(--app-ink)] hover:border-cyan-400/40 hover:text-cyan-200 transition"
            >
              Copy TXs
            </button>
            <button
              type="button"
              onClick={handleDownloadProofReceipt}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[var(--app-ink)] hover:border-cyan-400/40 hover:text-cyan-200 transition"
            >
              Download JSON
            </button>
            <button
              type="button"
              onClick={handleExportProofPdf}
              className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-[var(--app-ink)] hover:border-cyan-400/40 hover:text-cyan-200 transition"
            >
              Export PDF
            </button>
            <button
              type="button"
              onClick={() => setShowPrivacyProof((prev) => !prev)}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-cyan-200 hover:bg-cyan-500/15 transition"
              aria-expanded={showPrivacyProof}
              aria-controls="privacy-proof-body"
            >
              {showPrivacyProof ? "Hide Proof" : "Show Proof"}
              <span className={`transition-transform ${showPrivacyProof ? "rotate-180" : ""}`}>⌄</span>
            </button>
          </div>
        </div>
        {proofToastVisible && (
          <div className="mt-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200">
            {proofToast}
          </div>
        )}

        {showPrivacyProof && (
          <div id="privacy-proof-body">
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                  Route Privacy
                </div>
                <div className={`mt-1 text-sm font-bold ${privacyProof.routePrivate === null
                  ? "text-white"
                  : privacyProof.routePrivate
                    ? "text-emerald-400"
                    : "text-cyan-200"
                  }`}>
                  {privacyProof.routePrivate === null
                    ? `Pending: Stream not created yet (${privacyProof.plannedPrivateRoute ? "private shield selected" : "route not set"})`
                    : privacyProof.routePrivate
                      ? "PASS: No fixed destination pinned"
                      : "FAIL: Fixed destination detected"}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                  Encrypted Earnings Ref
                </div>
                <div className={`mt-1 text-sm font-bold ${privacyProof.encryptedHandlePresent ? "text-emerald-400" : "text-white"}`}>
                  {privacyProof.encryptedHandlePresent
                    ? `PASS: ${privacyProof.encryptedReference?.slice(0, 18)}...`
                    : "Pending: No encrypted handle yet"}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                  Automation Decrypt Access
                </div>
                <div className={`mt-1 text-sm font-bold ${privacyProof.keeperDecryptReady ? "text-emerald-400" : "text-white"}`}>
                  {privacyProof.keeperDecryptReady
                    ? privacyProof.keeperDecryptMode === "enforced"
                      ? "PASS: Enforced by private-mode default policy"
                      : "PASS: Keeper decrypt permissions active"
                    : privacyProof.keeperDecryptMode === "failed"
                      ? "Pending: Last keeper grant attempt failed"
                      : "Pending: Keeper decrypt access not confirmed"}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                  MagicBlock Delegation
                </div>
                <div className={`mt-1 text-sm font-bold ${privacyProof.magicBlockDelegated === null
                  ? "text-white"
                  : privacyProof.magicBlockDelegated
                    ? "text-emerald-400"
                    : "text-cyan-200"
                  }`}>
                  {privacyProof.magicBlockDelegated === null
                    ? "Pending: Stream not created yet"
                    : privacyProof.magicBlockDelegated
                      ? "PASS: High-speed delegated"
                      : "Optional: Not delegated"}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                On-chain Stream Account
              </div>
              <div className="mt-1 text-sm font-semibold text-[var(--app-ink)] break-all">
                {privacyProof.streamAddress ? (
                  <a
                    href={explorerAddressUrl(privacyProof.streamAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cyan-300 hover:text-cyan-200 underline decoration-cyan-500/40"
                  >
                    {privacyProof.streamAddress}
                  </a>
                ) : (
                  "Not created yet"
                )}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--app-muted)]">
                Transaction Proofs
              </div>
              {privacyProof.txProofs.length ? (
                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {privacyProof.txProofs.map((tx) => (
                    <a
                      key={tx.txid}
                      href={tx.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/10 transition"
                    >
                      <div className="font-bold">{tx.label}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-cyan-300/80">
                        {tx.txid.slice(0, 14)}...{tx.txid.slice(-8)}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--app-muted)]">
                  No proof transactions captured yet. Execute setup steps via chat and this will auto-populate.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <button
        className="advanced-mode-toggle"
        onClick={() => setShowAdvancedMode((prev) => !prev)}
      >
        {showAdvancedMode
          ? "Hide Expert Controls"
          : "Show Expert Controls"}
      </button>

      {showAdvancedMode && (
        <>
          <section className="hero-card setup-hero glass border-indigo-500/20 shadow-2xl transition-all duration-500">
            <div className="flex flex-col md:flex-row justify-between gap-6">
              <div className="flex-1">
                <p className="inline-block px-3 py-1 rounded-full bg-cyan-500/10 text-cyan-400 text-[10px] font-bold uppercase tracking-widest mb-3">
                  Config Command Center
                </p>
                <h1 className="font-sans text-[clamp(2rem,3.2vw,3rem)] font-bold tracking-[-0.01em] text-[var(--app-ink)] leading-[1.08]">
                  {COPY.employer.title}
                </h1>
                <p className="mt-4 text-[var(--app-muted)] font-medium max-w-xl">
                  Manual payroll controls for teams that want deeper setup and troubleshooting options.
                </p>
              </div>

              {/* ── Vault Mint Mismatch Warning ── */}
              {vaultMintMismatch && (
                <div className="mt-6 rounded-2xl border-2 border-amber-400/50 bg-gradient-to-r from-amber-50 to-orange-50 p-5 shadow-lg shadow-amber-500/10">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600 text-lg border border-amber-500/20">

                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-black text-amber-400 uppercase tracking-wider">Vault Mint Misconfigured</div>
                      <p className="mt-1 text-xs text-amber-700/80 leading-relaxed">
                        Your vault was initialized with a different token mint than the platform standard (<code className="text-[10px] font-mono bg-amber-100 px-1 py-0.5 rounded">PAYUSD</code>).
                        The automation service will reject all payouts until this is fixed.
                      </p>
                      <button
                        onClick={async () => {
                          if (!wallet.publicKey || !vaultTokenAccount) return;
                          setFixingVaultMint(true);
                          try {
                            const token = new PublicKey(vaultTokenAccount);
                            await rotateVaultTokenAccount(connection, wallet, token, PAYUSD_MINT);
                            setVaultMintMismatch(false);
                          } catch (e: any) {
                            console.error('Fix vault mint failed:', e);
                          } finally {
                            setFixingVaultMint(false);
                          }
                        }}
                        disabled={fixingVaultMint || !wallet.connected}
                        className="mt-3 rounded-lg bg-amber-500/100 px-5 py-2.5 text-xs font-black text-[var(--app-ink)] uppercase tracking-widest shadow-lg shadow-amber-500/30 transition-all hover:bg-amber-600 hover:translate-y-[-1px] active:translate-y-[1px] disabled:opacity-50"
                      >
                        {fixingVaultMint ? 'Fixing...' : 'Fix Vault Mint'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
                  setAgentQueueContextKey("");
                  void fetchWithTimeout(
                    `/api/agent/run-state?owner=${encodeURIComponent(owner)}&scope=employer`,
                    { method: "DELETE" },
                  ).catch(() => {
                    // ignore
                  });
                  setMessage("Cleared saved form values.");
                }}
                className="utility-btn disabled:opacity-50"
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
                      : "Automation service wallet set to your current wallet for local testing.",
                  );
                }}
                className="utility-btn disabled:opacity-50"
              >
                {DEFAULT_AUTOMATION_WALLET
                  ? "Use default automation wallet"
                  : "Use this wallet for automation (local test)"}
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
              <p className="mt-3 text-sm text-[var(--app-muted)]">
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
              <p className="text-sm text-[var(--app-muted)]">
                Connect a wallet to continue.
              </p>
            </section>
          ) : (
            <div className="setup-stack">
              <StepCard
                number={1}
                title={COPY.employer.step1.title}
                description={COPY.employer.step1.description}
                state={stepStates[1]}
              >
                <p className="step-subhead">Company and vault registration</p>
                <div className="grid gap-4 md:grid-cols-2">
                  <button
                    disabled={busy || businessExists}
                    onClick={() =>
                      run("Create company profile", async () => {
                        await registerBusiness(connection, wallet);
                      })
                    }
                    className="premium-btn premium-btn-primary shadow-indigo-500/20 shadow-lg hover:shadow-indigo-500/40 disabled:opacity-50"
                  >
                    Register Company Profile
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
                    className="premium-btn premium-btn-secondary hover:border-indigo-400/50 disabled:opacity-50"
                  >
                    Deploy Payroll Vault
                  </button>
                </div>

                <div className="mt-4">
                  <p className="step-subhead">Vault authorization</p>
                  <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                    Payroll Vault Address
                  </label>
                  <input
                    value={vaultTokenAccount}
                    onChange={(e) => setVaultTokenAccount(e.target.value)}
                    placeholder="Enter or deploy vault address"
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                  />
                </div>

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
                  className="mt-4 w-full premium-btn premium-btn-primary disabled:opacity-50"
                >
                  Authorize Vault for Payroll
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
                    className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-400 disabled:opacity-50"
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
                <p className="step-subhead">Funding inputs</p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      Funding Amount (PAYUSD)
                    </label>
                    <input
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      placeholder="e.g. 500"
                      className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      Company Source Account
                    </label>
                    <input
                      value={depositorTokenAccount}
                      onChange={(e) => setDepositorTokenAccount(e.target.value)}
                      placeholder="Address..."
                      className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                    />
                  </div>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <p className="step-subhead md:col-span-2">Source account and funding actions</p>
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
                    className="premium-btn premium-btn-secondary hover:border-indigo-400/50 disabled:opacity-50"
                  >
                    Setup Source Account
                  </button>

                  <div>
                      <button
                        disabled={busy || !wallet.publicKey || !depositorTokenAccount}
                        onClick={() =>
                          run("Get test payroll tokens", async () => {
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
                      className="w-full premium-btn premium-btn-secondary hover:border-indigo-400/50 disabled:opacity-90 disabled:text-[var(--app-ink)]"
                      >
                        Mint 1,000 Test Tokens
                      </button>
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
                        setHasConfirmedDeposit(true);
                        setVaultFundingObserved(true);
                      })
                    }
                    className="w-full md:col-span-2 premium-btn premium-btn-primary transition-all disabled:opacity-50"
                  >
                    Deposit Funds into Secure Vault
                  </button>
                </div>

                <InlineHelp>
                  Fund the company source token account first, then add funds to payroll wallet.
                </InlineHelp>

                <AdvancedDetails title="Advanced details">
                  <div className="space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-3">
                    <div className="text-xs font-medium text-[var(--app-muted)]">
                      Recover unused payroll funds (owner)
                    </div>
                    <input
                      value={vaultWithdrawAmount}
                      onChange={(e) => setVaultWithdrawAmount(e.target.value)}
                      placeholder="Amount to recover"
                      className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                    />
                    <input
                      value={vaultWithdrawTokenAccount}
                      onChange={(e) =>
                        setVaultWithdrawTokenAccount(e.target.value)
                      }
                      placeholder="Destination token account"
                      className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
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
                      className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-400 disabled:opacity-50"
                    >
                      Recover Unused Funds
                    </button>
                    <button
                      disabled={busy || !depositorTokenAccount}
                      onClick={() =>
                        setVaultWithdrawTokenAccount(depositorTokenAccount)
                      }
                      className="w-full rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Recover Funds
                    </button>

                    <div className="mt-4 pt-4 border-t border-[var(--app-border)]">
                      <div className="text-xs font-medium text-[var(--app-muted)] mb-2">
                        Need to use real USDC?
                      </div>
                      <Link href="/bridge" className="block w-full text-center rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-2 text-sm text-[var(--app-muted)] hover:bg-[var(--app-surface-alt)]">
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
                <p className="step-subhead">Automation configuration</p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      Automation Wallet
                    </label>
                    <input
                      value={keeperPubkey}
                      onChange={(e) => setKeeperPubkey(e.target.value)}
                      placeholder="Address..."
                      className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      Settle Interval (Secs)
                    </label>
                    <input
                      value={settleIntervalSecs}
                      onChange={(e) => setSettleIntervalSecs(e.target.value)}
                      placeholder="e.g. 60"
                      className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                    />
                  </div>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
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
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Activate Automation
                  </button>
                  <button
                    disabled={busy || !businessExists || !v2ConfigExists}
                    onClick={() =>
                      run(
                        "Rotate automation service wallet",
                        rotateAutomationWalletTask,
                      )
                    }
                    className="w-full rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm font-bold text-orange-900 disabled:opacity-50"
                  >
                    Rotate Automation Wallet
                  </button>
                </div>
                {DEFAULT_AUTOMATION_WALLET ? (
                  <p className="mt-2 text-xs text-[var(--app-muted)]">
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

                <div className="mt-6 border-t border-white/5 pt-6">
                  <h3 className="text-sm font-bold text-[var(--app-ink)] mb-4">Employee Identity Setup</h3>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                        Employee Auth Wallet
                      </label>
                      <input
                        value={employeeWallet}
                        onChange={(e) => setEmployeeWallet(e.target.value)}
                        placeholder="Address..."
                        className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        disabled={busy || !wallet.publicKey}
                        onClick={() => {
                          if (!wallet.publicKey) return;
                          setEmployeeWallet(wallet.publicKey.toBase58());
                        }}
                        className="w-full premium-btn premium-btn-secondary py-[11px] disabled:opacity-50"
                      >
                        Use Connected Wallet as Employee
                      </button>
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                        Destination Route Mode
                      </label>
                      <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-semibold text-[var(--app-ink)]">
                        Private shield route (enforced)
                      </div>
                      <p className="mt-1.5 text-xs text-[var(--app-muted)]">
                        Private shield route does not pin any employee destination
                        in stream state. Employee selects destination later from
                        the Employee Portal at claim time.
                      </p>
                      <p className="mt-1 text-xs text-[var(--app-muted)]">
                        No destination token account is needed during employer
                        onboarding.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-6 space-y-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="h-1.5 w-1.5 rounded-full bg-cyan-500"></div>
                    <span className="text-xs font-bold text-[var(--app-ink)] uppercase tracking-wider">Payroll Blueprint</span>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="block">
                      <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider ml-1">Frequency</span>
                      <select
                        value={payPreset}
                        onChange={(e) => setPayPreset(e.target.value as any)}
                        disabled={busy}
                        className="mt-1.5 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 outline-none transition-all"
                      >
                        <option value="per_second">Real-time (Per-second)</option>
                        <option value="hourly">Hourly</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly (30d)</option>
                        <option value="fixed_total">Fixed Milestone</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider ml-1">
                        {payPreset === "fixed_total" ? "Milestone Amount" : "Rate per Period"}
                      </span>
                      <input
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        disabled={busy || payPreset === "per_second"}
                        placeholder={payPreset === "fixed_total" ? "e.g. 5000" : "e.g. 30"}
                        className="mt-1.5 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 outline-none disabled:bg-[var(--app-surface-alt)] transition-all"
                      />
                    </label>
                  </div>

                  <div className="mt-4 flex flex-col gap-3">
                    <label className="grid grid-cols-[1.25rem_1fr] items-start gap-3 group cursor-default">
                      <input
                        type="checkbox"
                        checked={true}
                        disabled={true}
                        className="mt-1 h-5 w-5 shrink-0 rounded-md border-[var(--app-border)] text-cyan-400 focus:ring-cyan-500 transition-all"
                      />
                      <span className="text-sm font-medium leading-8 text-[var(--app-muted)]">
                        Automation (keeper) decrypt access is enforced in private mode
                      </span>
                    </label>
                    <label className="grid grid-cols-[1.25rem_1fr] items-start gap-3 group cursor-pointer">
                      <input
                        type="checkbox"
                        checked={boundPresetPeriod}
                        onChange={(e) => setBoundPresetPeriod(e.target.checked)}
                        disabled={busy}
                        className="mt-1 h-5 w-5 shrink-0 rounded-md border-[var(--app-border)] text-cyan-400 focus:ring-cyan-500 transition-all"
                      />
                      <span className="text-sm font-medium leading-8 text-[var(--app-muted)] group-hover:text-[var(--app-ink)] transition-colors">
                        Stop payroll automatically at end of period
                      </span>
                    </label>
                    <label className="grid grid-cols-[1.25rem_1fr] items-start gap-3 group cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoEnableHighSpeedOnCreate}
                        onChange={(e) =>
                          setAutoEnableHighSpeedOnCreate(e.target.checked)
                        }
                        disabled={busy}
                        className="mt-1 h-5 w-5 shrink-0 rounded-md border-[var(--app-border)] text-cyan-400 focus:ring-cyan-500 transition-all"
                      />
                      <span className="text-sm font-medium leading-8 text-[var(--app-muted)] group-hover:text-[var(--app-ink)] transition-colors">
                        Auto-enable high-speed mode after payroll record is
                        created (optional). Inco encrypted payroll amounts stay
                        private.
                      </span>
                    </label>
                  </div>

                  <div className="mt-4 flex items-center justify-between rounded-xl bg-cyan-500/5 px-4 py-3 border border-cyan-500/20">
                    <span className="text-xs font-bold text-cyan-400">Calculated Stream Force</span>
                    <span className="font-mono text-sm font-bold text-cyan-200">
                      {computedRatePreview === null ? "-" : computedRatePreview.toFixed(9)} units/sec
                    </span>
                  </div>

                  <button
                    disabled={busy || !v2ConfigExists}
                    onClick={() =>
                      run(
                        "Create private payroll record",
                        () =>
                          createWorkerPayrollRecordTask(undefined, {
                            autoEnableHighSpeed: autoEnableHighSpeedOnCreate,
                          }),
                      )
                    }
                    className="w-full premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Create Private Payroll Record
                  </button>
                </div>

                <InlineHelp>
                  Success means the employee can now open Employee Portal and load
                  this payroll record number.
                </InlineHelp>
              </StepCard>

              <StepCard
                number={4}
                title={COPY.employer.step4.title}
                description={COPY.employer.step4.description}
                state={stepStates[4]}
              >
                <p className="step-subhead">Execution mode controls</p>
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      Payroll Record Reference
                    </label>
                    <input
                      value={streamIndexInput}
                      onChange={(e) => setStreamIndexInput(e.target.value)}
                      placeholder="e.g. 0"
                      className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10 outline-none transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mb-1.5 ml-1">
                      High-Speed Route
                    </label>
                    <div className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-3 text-sm font-medium text-[var(--app-muted)]">
                      Automation-managed default route (no manual region selection)
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <button
                      disabled={busy || !v2ConfigExists || streamIndex === null}
                      onClick={() =>
                        run("Enable high-speed mode", async () => {
                          if (!ownerPubkey || streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          const validator = getMagicblockValidatorForRegion("eu");
                          return delegateStreamV2(
                            connection,
                            wallet,
                            ownerPubkey,
                            streamIndex,
                            validator,
                          );
                        })
                      }
                      className="premium-btn premium-btn-primary disabled:opacity-50"
                    >
                      Boost Execution
                    </button>
                    <button
                      disabled={busy || !v2ConfigExists || streamIndex === null}
                      onClick={() =>
                        run("Disable high-speed mode", async () => {
                          if (!ownerPubkey || streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          return commitAndUndelegateStreamV2(
                            connection,
                            wallet,
                            ownerPubkey,
                            streamIndex,
                          );
                        })
                      }
                      className="premium-btn bg-amber-500/100 hover:bg-amber-600 text-[var(--app-ink)] shadow-amber-500/20 shadow-lg disabled:opacity-50"
                    >
                      Base Layer
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        run("Refresh payroll status", async () => {
                          await loadState();
                        })
                      }
                      className="premium-btn premium-btn-secondary disabled:opacity-50"
                    >
                      Sync Latest Data
                    </button>
                  </div>
                </div>
                <InlineHelp>
                  High-speed mode controls MagicBlock delegation only. Inco encrypted amounts remain private.
                </InlineHelp>
              </StepCard>

              <StepCard
                number={5}
                title={COPY.employer.step5.title}
                description={COPY.employer.step5.description}
                state={stepStates[5]}
              >
                <p className="step-subhead">Live status and operations</p>
                <div className="grid gap-3 grid-cols-1 md:grid-cols-3">
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4 shadow-sm">
                    <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-widest mb-1">Payroll status</span>
                    <StatusPill tone={v2Config?.isPaused ? "warning" : "success"}>
                      {v2Config?.isPaused ? "PAUSED" : "LIVE"}
                    </StatusPill>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4 shadow-sm">
                    <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-widest mb-1">Payroll record</span>
                    <StatusPill tone={streamStatus ? "success" : "neutral"}>
                      {streamStatus ? `#${streamStatus.streamIndex}` : "NONE"}
                    </StatusPill>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-alt)] p-4 shadow-sm">
                    <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-widest mb-1">Execution mode</span>
                    <StatusPill tone={highSpeedOn ? "success" : "warning"}>
                      {highSpeedOn ? "FAST" : "BASE"}
                    </StatusPill>
                  </div>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  <button
                    disabled={busy || !v2ConfigExists}
                    onClick={() =>
                      run("Pause payroll", async () => {
                        if (!ownerPubkey)
                          throw new Error("Wallet not connected");
                        await pauseStreamV2(connection, wallet, ownerPubkey, 1);
                      })
                    }
                    className="premium-btn bg-[var(--app-surface-alt)] text-[var(--app-muted)] hover:bg-red-500/10 hover:text-red-700 hover:border-red-500/20 border border-transparent disabled:opacity-50"
                  >
                    Pause Payroll
                  </button>
                  <button
                    disabled={busy || !v2ConfigExists}
                    onClick={() =>
                      run("Resume payroll", async () => {
                        const txid = await resumeStreamV2(connection, wallet);
                        let message = "Resume payroll succeeded";
                        if (streamIndex !== null) {
                          try {
                            const reenabled = await ensureHighSpeedForStream(
                              streamIndex,
                            );
                            if (reenabled) {
                              message =
                                "Resume payroll succeeded; high-speed mode re-enabled for selected payroll record.";
                            }
                          } catch (resumeHighSpeedError: any) {
                            const reason =
                              resumeHighSpeedError?.message ||
                              "high-speed re-enable failed";
                            message = `Resume payroll succeeded; high-speed re-enable failed (${reason}).`;
                          }
                        }
                        return { txid, message };
                      })
                    }
                    className="premium-btn premium-btn-primary disabled:opacity-50"
                  >
                    Resume Payroll
                  </button>
                </div>

                <AdvancedDetails title="Technical details (optional)">
                  {streamStatus?.hasFixedDestination ? (
                    <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
                      Legacy fixed-destination payroll record detected. For strongest privacy, create new records with
                      private shield route only.
                    </div>
                  ) : null}
                  <div className="grid gap-2 text-sm text-[var(--app-muted)]">
                    {streamStatus ? (
                      <>
                        <div>
                          Payroll record address:{" "}
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
                          Payout route:{" "}
                          {streamStatus.hasFixedDestination
                            ? streamStatus.employeeTokenAccount
                            : "Claim-time destination only (no fixed on-chain route)"}
                        </div>
                        <div>
                          Record active: {streamStatus.isActive ? "yes" : "no"}
                        </div>
                        <div>
                          High-speed enabled (base read):{" "}
                          {streamStatus.isDelegated ? "yes" : "no"}
                        </div>
                        <div>
                          High-speed enabled (router):{" "}
                          {streamRoute?.delegated === null
                            ? "unknown"
                            : streamRoute?.delegated
                              ? "yes"
                              : "no"}
                        </div>
                        <div>Current account owner: {streamStatus.owner}</div>
                        <div>
                          Expected high-speed program owner:{" "}
                          {MAGICBLOCK_DELEGATION_PROGRAM.toBase58()}
                        </div>
                        <div>
                          Last earnings update (unix): {streamStatus.lastAccrualTime}
                        </div>
                        <div>
                          Last settle time (unix): {streamStatus.lastSettleTime}
                        </div>
                        <div>
                          Encrypted earnings reference: {streamStatus.accruedHandle}
                        </div>
                      </>
                    ) : (
                      <p>No payroll record found for this reference.</p>
                    )}
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-1">
                    <button
                      disabled={busy || !v2ConfigExists || streamIndex === null}
                      onClick={() =>
                        run("Grant automation decrypt access", async () => {
                          if (!ownerPubkey || streamIndex === null)
                            throw new Error("Invalid payroll record number");
                          return grantAutomationDecryptAccessTask(streamIndex);
                        })
                      }
                      className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Grant Keeper Decrypt Access
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-[var(--app-muted)]">
                        Private raise (expert)
                      </div>
                      <input
                        value={raiseSalaryPerSecond}
                        onChange={(e) =>
                          setRaiseSalaryPerSecond(e.target.value)
                        }
                        placeholder="New salary per second"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <button
                        disabled={
                          busy || !v2ConfigExists || streamIndex === null
                        }
                        onClick={() =>
                          run("Apply private raise", async () => {
                            if (streamIndex === null)
                              throw new Error("Invalid payroll record number");
                            const raiseResult =
                              await runStreamMutationWithHighSpeedRecovery(
                                streamIndex,
                                "Private raise",
                                async () =>
                                  updateSalaryRateV2(
                                    connection,
                                    wallet,
                                    streamIndex,
                                    Number(raiseSalaryPerSecond),
                                  ),
                              );
                            const txid = raiseResult.txid;
                            let message = raiseResult.message;
                            try {
                              if (ownerPubkey && autoGrantKeeperDecrypt) {
                                await grantAutomationDecryptAccessTask(
                                  streamIndex,
                                );
                                message = `${message} Automation decrypt access refreshed.`;
                              }
                            } catch {
                              // best-effort
                            }
                            return { txid, message };
                          })
                        }
                        className="w-full premium-btn premium-btn-primary disabled:opacity-50"
                      >
                        Apply Private Raise
                      </button>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-medium text-[var(--app-muted)]">
                        Private bonus (expert)
                      </div>
                      <input
                        value={bonusAmount}
                        onChange={(e) => setBonusAmount(e.target.value)}
                        placeholder="Bonus amount"
                        className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm"
                      />
                      <button
                        disabled={
                          busy || !v2ConfigExists || streamIndex === null
                        }
                        onClick={() =>
                          run("Apply private bonus", async () => {
                            if (streamIndex === null)
                              throw new Error("Invalid payroll record number");
                            const bonusResult =
                              await runStreamMutationWithHighSpeedRecovery(
                                streamIndex,
                                "Private bonus",
                                async () =>
                                  grantBonusV2(
                                    connection,
                                    wallet,
                                    streamIndex,
                                    Number(bonusAmount),
                                  ),
                              );
                            const txid = bonusResult.txid;
                            let message = bonusResult.message;
                            try {
                              if (ownerPubkey && autoGrantKeeperDecrypt) {
                                await grantAutomationDecryptAccessTask(
                                  streamIndex,
                                );
                                message = `${message} Automation decrypt access refreshed.`;
                              }
                            } catch {
                              // best-effort
                            }
                            return { txid, message };
                          })
                        }
                        className="w-full premium-btn premium-btn-primary disabled:opacity-50"
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
                      className="w-full rounded-lg border border-[var(--app-border)] px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Prepare Rate History (Legacy Support)
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
                          return deactivateStreamSafelyTask(streamIndex);
                        })
                      }
                      className="w-full rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 disabled:opacity-50"
                    >
                      Stop Payroll Record
                    </button>
                    <button
                      disabled={busy || !v2ConfigExists || !v2Config}
                      onClick={() =>
                        run("Backfill automation decrypt access", async () => {
                          if (!ownerPubkey || !v2Config)
                            throw new Error("Missing config");
                          const total = v2Config.nextStreamIndex;
                          let granted = 0;
                          let failed = 0;
                          for (let i = 0; i < total; i++) {
                            try {
                              await grantAutomationDecryptAccessTask(i);
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
                      className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm disabled:opacity-50"
                    >
                      Repair Keeper Access for Older Records
                    </button>

                    {/* Phase 2: Auditor Access */}
                    <div className="mt-4 pt-4 border-t border-[var(--app-border)]">
                      <div className="text-[10px] font-black text-violet-600 uppercase tracking-widest mb-2">
                        Viewer Permissions (Advanced)
                      </div>

                      <div className="flex gap-2 mt-2">
                        <input
                          type="text"
                          placeholder="Viewer wallet address"
                          id="auditor-wallet-input"
                          className="flex-1 rounded-lg border border-violet-500/20 bg-[var(--app-surface-alt)] px-3 py-2 text-xs font-mono"
                        />
                        <button
                          disabled={busy || !streamStatus}
                          onClick={() =>
                            run("Grant auditor view access", async () => {
                              if (!ownerPubkey || !streamStatus)
                                throw new Error("Missing config");
                              const input = (document.getElementById("auditor-wallet-input") as HTMLInputElement)?.value?.trim();
                              if (!input) throw new Error("Enter viewer wallet");
                              const auditor = new PublicKey(input);
                              await grantAuditorViewAccessV2(
                                connection, wallet, ownerPubkey,
                                streamStatus.streamIndex, auditor
                              );
                              return `View access granted to ${input.slice(0, 8)}...`;
                            })
                          }
                          className="rounded-lg bg-violet-500 px-4 py-2 text-xs font-bold text-[var(--app-ink)] whitespace-nowrap disabled:opacity-50"
                        >
                          Grant Viewer
                        </button>
                      </div>

                      <div className="flex gap-2 mt-2">
                        <input
                          type="text"
                          placeholder="Viewer wallet to remove"
                          id="revoke-wallet-input"
                          className="flex-1 rounded-lg border border-red-500/20 bg-[var(--app-surface-alt)] px-3 py-2 text-xs font-mono"
                        />
                        <button
                          disabled={busy || !streamStatus}
                          onClick={() =>
                            run("Revoke view access", async () => {
                              if (!ownerPubkey || !streamStatus)
                                throw new Error("Missing config");
                              const input = (document.getElementById("revoke-wallet-input") as HTMLInputElement)?.value?.trim();
                              if (!input) throw new Error("Enter wallet to revoke");
                              const target = new PublicKey(input);
                              await revokeViewAccessV2(
                                connection, wallet, ownerPubkey,
                                streamStatus.streamIndex, target
                              );
                              return `Access revoked for ${input.slice(0, 8)}...`;
                            })
                          }
                          className="rounded-lg bg-red-500/100 px-4 py-2 text-xs font-bold text-[var(--app-ink)] whitespace-nowrap disabled:opacity-50"
                        >
                          Revoke Access
                        </button>
                      </div>
                    </div>
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
