import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Logo } from './Logo';

type ChatMessage = {
    id: string;
    role: 'agent' | 'user';
    text: string;
    timestamp: number;
};

type AgentChatPhase =
    | 'greeting'
    | 'ask_setup'
    | 'ask_funding'
    | 'ask_wallet'
    | 'ask_pay'
    | 'ask_options'
    | 'confirm_plan'
    | 'executing'
    | 'done'
    | 'error';

type ParsedPlan = {
    intent?: string;
    employeeWallet?: string;
    payPreset?: string;
    payAmount?: string;
    fixedTotalDays?: string;
    salaryPerSecond?: string;
    boundPresetPeriod?: boolean;
    streamIndex?: number;
    bonusAmount?: string;
    summary?: string;
    confidence?: number;
    source?: string;
};

type AgentProofSummary = {
    routePrivate: boolean | null;
    encryptedHandlePresent: boolean;
    keeperDecryptReady: boolean;
    magicBlockDelegated: boolean | null;
    streamAddress?: string;
    encryptedReference?: string;
    txProofs: { label: string; txid: string; url?: string }[];
};

type AgentChatProps = {
    walletConnected: boolean;
    walletAddress: string;
    businessExists: boolean;
    vaultExists: boolean;
    configExists: boolean;
    depositorBalance: string | null;
    vaultBalance: string | null;
    depositorTokenAccount: string;
    employeeWallet: string;
    payPreset: string;
    payAmount: string;
    depositAmount: string;
    setDepositAmount: (amount: string) => void;
    streamIndex: number | null;
    onDraftPlan: (instruction: string, current: Record<string, unknown>) => Promise<ParsedPlan | null>;
    onExecutePlan: (mode?: 'all' | 'next') => Promise<{ key: string; label: string; status: string; txid?: string; detail?: string } | null>;
    onApplyPlan: (plan: ParsedPlan) => void;
    executionSteps: { key: string; label: string; status: string; detail?: string; txid?: string }[];
    busy: boolean;
    messages: ChatMessage[];
    setMessages: (msgs: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
    phase: AgentChatPhase;
    setPhase: (phase: AgentChatPhase) => void;
    ready: boolean;
    hydrated: boolean;
    onCancelBusy?: () => void;
    onClearChat?: () => void;
    autoGrantKeeperDecrypt?: boolean;
    setAutoGrantKeeperDecrypt?: (val: boolean) => void;
    boundPresetPeriod?: boolean;
    setBoundPresetPeriod?: (val: boolean) => void;
    proofSummary?: AgentProofSummary;
};

const GO_COMMANDS = [
    '**"go"**',
    '**"execute"**',
    '**"let\'s go"**',
    '**"run"**',
    '**"next"**',
    '**"proceed"**',
    '**"do it"**',
    '**"let\'s go"** ',
    '**"run"** ',
    '**"execute"** ',
    '**"next"** ',
    '**"go"** ',
];

function randomGoCmd(): string {
    return GO_COMMANDS[Math.floor(Math.random() * GO_COMMANDS.length)];
}

function msgId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AgentChat({
    walletConnected,
    walletAddress,
    businessExists,
    vaultExists,
    configExists,
    depositorBalance,
    vaultBalance,
    depositorTokenAccount,
    employeeWallet,
    payPreset,
    payAmount,
    depositAmount,
    setDepositAmount,
    streamIndex,
    onDraftPlan,
    onExecutePlan,
    onApplyPlan,
    messages,
    setMessages,
    phase,
    setPhase,
    ready,
    hydrated,
    executionSteps,
    busy,
    onCancelBusy,
    onClearChat,
    autoGrantKeeperDecrypt,
    setAutoGrantKeeperDecrypt,
    boundPresetPeriod,
    setBoundPresetPeriod,
    proofSummary,
}: AgentChatProps) {
    const [input, setInput] = useState('');
    const [pendingPlan, setPendingPlan] = useState<ParsedPlan | null>(null);
    const [thinking, setThinking] = useState(false);
    const [optionStep, setOptionStep] = useState(0);
    const [showExecutionLog, setShowExecutionLog] = useState(false);
    const messagesRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const hasGreeted = useRef(false);
    const isSending = useRef(false);
    const actionableSteps = useMemo(
        () => executionSteps.filter((s) => s.key !== 'refresh-state'),
        [executionSteps]
    );
    const activeStep = useMemo(
        () =>
            actionableSteps.find((s) => s.status === 'running') ||
            actionableSteps.find((s) => s.status === 'pending') ||
            null,
        [actionableSteps]
    );
    const activeStepIndex = useMemo(
        () => (activeStep ? actionableSteps.findIndex((s) => s.key === activeStep.key) + 1 : null),
        [actionableSteps, activeStep]
    );
    const completedStepCount = useMemo(
        () => actionableSteps.filter((s) => s.status === 'done').length,
        [actionableSteps]
    );
    const progressPercent = useMemo(
        () =>
            actionableSteps.length > 0
                ? Math.round((completedStepCount / actionableSteps.length) * 100)
                : 0,
        [actionableSteps.length, completedStepCount]
    );

    const handleClearChat = useCallback(() => {
        setMessages([]);
        setPhase('greeting');
        hasGreeted.current = false;
        onClearChat?.();
    }, [setMessages, setPhase, onClearChat]);

    const addAgentMsg = useCallback((text: string) => {
        setMessages((prev) => [
            ...prev,
            { id: msgId(), role: 'agent', text, timestamp: Date.now() },
        ]);
    }, [setMessages]);

    const addUserMsg = useCallback((text: string) => {
        setMessages((prev) => [
            ...prev,
            { id: msgId(), role: 'user', text, timestamp: Date.now() },
        ]);
    }, [setMessages]);

    // Auto-scroll to bottom
    useEffect(() => {
        const container = messagesRef.current;
        if (!container) return;
        container.scrollTo({
            top: container.scrollHeight,
            behavior: 'smooth',
        });
    }, [messages, executionSteps, thinking]);

    // Route a message through Grok LLM for conversational responses
    const askGrok = useCallback(async (userText: string): Promise<{ reply: string; action?: any }> => {
        try {
            const resp = await fetch('/api/agent/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: userText,
                    history: messages.slice(-10),
                    accountStatus: {
                        businessExists,
                        vaultExists,
                        configExists,
                        executionSteps,
                        currentlyActiveStep:
                            executionSteps.find(s => s.status === 'running' && s.key !== 'refresh-state') ||
                            executionSteps.find(s => s.status === 'pending' && s.key !== 'refresh-state'),
                        depositorBalance,
                        vaultBalance,
                        depositorTokenAccount,
                        employeeWallet,
                        payPreset,
                        payAmount,
                        streamIndex,
                        autoGrantKeeperDecrypt,
                        boundPresetPeriod,
                        proofSummary
                    },
                    phase,
                }),
            });
            const json = await resp.json();
            if (json.ok) return { reply: json.reply, action: json.action };
            return { reply: `I'm having trouble right now. What would you like to do?` };
        } catch (err) {
            console.error('[AgentChat] askGrok fetch error:', err);
            return { reply: `I couldn't reach my brain. Please try again.` };
        }
    }, [messages, businessExists, vaultExists, configExists, depositorBalance, vaultBalance, depositorTokenAccount, employeeWallet, payPreset, payAmount, streamIndex, executionSteps, phase, autoGrantKeeperDecrypt, boundPresetPeriod, proofSummary]);

    const handleSend = useCallback(async () => {
        const text = input.trim();

        // 🚨 EMERGENCY BAILOUT: If the wallet was closed and the promise hung, let the user force a reset
        if ((busy || phase === 'executing') && /\b(cancel|reset|stop|abort)\b/i.test(text)) {
            if (onCancelBusy) onCancelBusy();
            addAgentMsg(`️ I've forcefully cancelled the waiting operation. Type ${randomGoCmd()} when you are ready to try again.`);
            setPhase('ask_setup');
            setInput('');
            isSending.current = false;
            return;
        }

        if (!text || thinking || busy || !ready || !hydrated || isSending.current) return;
        isSending.current = true;

        try {
            setInput('');
            addUserMsg(text);

            const lower = text.toLowerCase();
            const normalized = lower.replace(/\s+/g, ' ').trim();
            const isHelpCommand = /^\/?(help|commands?|cmd)$/.test(normalized);
            const isWhereCommand =
                /^\/?(where|status|progress|current)$/.test(normalized) ||
                /^where\s*am\s*i$/.test(normalized);
            const isStepsCommand = /^\/?(steps|checklist|tasks|plan)$/.test(normalized);
            const isProofCommand = /^\/?(proof|verify|trust)$/.test(normalized);

            if (isHelpCommand) {
                addAgentMsg(
                    ` **Quick commands**\n\n` +
                    `• \`/where\` — show your current step\n` +
                    `• \`/steps\` — show full checklist status\n` +
                    `• \`/proof\` — show privacy/security proof\n` +
                    `• \`/run\` (or \`go\`) — execute next pending step\n` +
                    `• \`/step N\` — jump focus to step number`
                );
                return;
            }

            if (isWhereCommand) {
                if (!actionableSteps.length) {
                    addAgentMsg(` **No execution checklist yet.** Type **setup** to initialize the workflow.`);
                } else if (!activeStep || !activeStepIndex) {
                    addAgentMsg(` **All setup steps are complete.** Paste a worker wallet to start a new payroll flow.`);
                } else {
                    addAgentMsg(` **You are on Step ${activeStepIndex}/${actionableSteps.length}: ${activeStep.label}**\n\nType ${randomGoCmd()} to execute it.`);
                }
                return;
            }

            if (isStepsCommand) {
                if (!actionableSteps.length) {
                    addAgentMsg(` **No checklist available yet.** Type **setup** to generate onboarding steps.`);
                } else {
                    setShowExecutionLog(true);
                    const lines = actionableSteps.map((s, i) => {
                        const marker = s.status === 'done' ? '✅' : s.status === 'running' ? '▶' : '•';
                        return `${marker} Step ${i + 1}: ${s.label}`;
                    });
                    addAgentMsg(` **Execution Checklist**\n\n${lines.join('\n')}\n\nType \`/where\` to see your active step, then type ${randomGoCmd()} to execute.`);
                }
                return;
            }

            if (isProofCommand) {
                if (!proofSummary) {
                    addAgentMsg(` **Proof data is not available yet.** Run setup steps first, then try \`/proof\` again.`);
                    return;
                }
                const refShort = proofSummary.encryptedReference
                    ? `${proofSummary.encryptedReference.slice(0, 16)}...`
                    : 'Unavailable';
                const streamShort = proofSummary.streamAddress
                    ? `${proofSummary.streamAddress.slice(0, 8)}...${proofSummary.streamAddress.slice(-6)}`
                    : 'Not created yet';
                const routeLine = proofSummary.routePrivate === null
                    ? `⏳ Route privacy pending (stream not created yet)`
                    : proofSummary.routePrivate
                        ? `✅ Private route enforced (no fixed destination)`
                        : `⚠️ Route privacy check failed`;
                const encLine = proofSummary.encryptedHandlePresent
                    ? `✅ Inco encrypted reference present (\`${refShort}\`)`
                    : `⚠️ Encrypted reference missing`;
                const keeperLine = proofSummary.keeperDecryptReady
                    ? `✅ Automation decrypt access configured`
                    : `⚠️ Automation decrypt access pending`;
                const mbLine = proofSummary.magicBlockDelegated === null
                    ? `⏳ MagicBlock delegation not applicable yet`
                    : proofSummary.magicBlockDelegated
                        ? `✅ MagicBlock high-speed delegation active`
                        : `⚠️ MagicBlock delegation not active`;
                const txLines = proofSummary.txProofs.length
                    ? proofSummary.txProofs
                        .slice(0, 6)
                        .map((tx) => `• ${tx.label}: [View tx](${tx.url || `https://explorer.solana.com/tx/${tx.txid}?cluster=devnet`})`)
                        .join('\n')
                    : '• No transaction proofs captured yet';
                addAgentMsg(
                    ` **Privacy & Security Proof**\n\n` +
                    `${routeLine}\n` +
                    `${encLine}\n` +
                    `${keeperLine}\n` +
                    `${mbLine}\n\n` +
                    `**Stream Account:** \`${streamShort}\`\n\n` +
                    `**Transaction Proofs**\n${txLines}`
                );
                return;
            }

            // Fallback for error state
            if (phase === 'error') {
                addAgentMsg(`Something went wrong previously. Type **"reset"** or **"start"** to recover.`);
                if (/\b(start|reset|go)\b/i.test(text)) setPhase('greeting');
                return;
            }

            // ---- ASK FUNDING HANDLER ----
            if (phase === 'ask_funding') {
                if (/\b(cancel|reset|stop|abort|back)\b/i.test(text)) {
                    setPhase('ask_setup');
                    addAgentMsg('Okay, I cancelled the funding step. Let me know when you are ready to continue!');
                    return;
                }

                const isGoContent = /\b(?:go|continue|yes|skip|proceed|run|execute|next)\b/i.test(text) ||
                    /^\/(?:go|run|next|execute)$/.test(normalized);
                const numMatch = text.match(/\b\d+(\.\d+)?\b/);

                if (numMatch) {
                    const amount = numMatch[0];
                    setDepositAmount(amount);
                    addAgentMsg(` Got it! Moving **${amount} PayUSD** to your payroll vault.\n\n*Automatically proceeding to execute funding steps... Please approve the next transactions in your wallet.*`);

                    setPhase('executing');
                    setThinking(true);
                    setTimeout(() => {
                        setInput('execute');
                        isSending.current = false;
                        void handleSend();
                    }, 500);
                } else if (isGoContent) {
                    setPhase('executing');
                    setThinking(true);
                    setTimeout(() => {
                        setInput('execute');
                        isSending.current = false;
                        void handleSend();
                    }, 500);
                } else {
                    addAgentMsg(`Please provide a number (e.g., "100") or type **"go"** to skip. If you want to chat normally, click **Cancel** first.`);
                }
                return;
            }

            // ---- ASK_OPTIONS HANDLER ----
            if (phase === 'ask_options') {
                const isYes = /\b(yes|yeah|yep|sure|ok|okay|yea|y|enable|on|allow|grant)\b/i.test(text);
                const isNo = /\b(no|nah|nope|n|skip|disable|off|deny|don't|dont)\b/i.test(text);

                if (!isYes && !isNo) {
                    setThinking(true);
                    try {
                        const { reply } = await askGrok(text);
                        const questions = [
                            ` **Should the automation service be allowed to process confidential payouts automatically?** (yes/no)`,
                            `⏱️ **Should the payroll stop automatically at the end of this pay period?** (yes/no)`,
                        ];
                        addAgentMsg(reply + `\n\n` + questions[optionStep]);
                    } catch {
                        addAgentMsg(`I had trouble understanding. Please respond with **"yes"** or **"no"**.`);
                    } finally {
                        setThinking(false);
                    }
                    return;
                }

                if (optionStep === 0) {
                    setAutoGrantKeeperDecrypt?.(isYes);
                    addAgentMsg(isYes ? ` **Automation enabled.**\n\n` : `⬜ **Manual settlement only.**\n\n`);
                    addAgentMsg(`⏱️ **Stop payroll automatically at the end of period?** (yes/no)`);
                    setOptionStep(1);
                } else if (optionStep === 1) {
                    setBoundPresetPeriod?.(isYes);
                    addAgentMsg(isYes ? ` **Auto-stop active.**\n\n` : `⬜ **Continuous streaming.**\n\n`);
                    addAgentMsg(`🎯 **All options configured!** Type ${randomGoCmd()} to move to the next setup step.`);
                    setPhase('confirm_plan');
                }
                return;
            }
            const isStatusCommand = /\b(status|checklist|tasks|where\s*am\s*i|progress|steps|show\s*steps)\b/i.test(lower);
            const isGoCommand = /\b(setup|start|go|continue|execute|run|do\s*it|next|proceed|lets\s*go|let's\s*go)\b/i.test(lower);
            const isEditKeyword = /\b(edit|change|no|update|modify)\b/i.test(lower);
            const isOptionsKeyword = /\b(option|options|settings|permissions|access|auto.?stop)\b/i.test(lower);
            const hasNumber = /\d/.test(text);
            const isExplicitPlanIntent = /\b(pay|salary|amount|rate|bonus|raise|plan|stream|per\s*(hour|week|month|second)|hourly|weekly|monthly|fixed)\b/i.test(lower);
            const shouldParsePlanChange =
                isOptionsKeyword || ((isEditKeyword || hasNumber) && isExplicitPlanIntent);
            const gotoMatch = normalized.match(/^\/(?:step|goto)\s+(\d{1,2})$/);

            let forceExecuteCurrent = false;
            if (gotoMatch) {
                const target = Number(gotoMatch[1]);
                if (!actionableSteps.length) {
                    addAgentMsg(` **No checklist available yet.** Type **setup** first.`);
                    return;
                }
                const targetStep = actionableSteps[target - 1];
                if (!targetStep) {
                    addAgentMsg(`That step doesn't exist. Choose a step between **1** and **${actionableSteps.length}**.`);
                    return;
                }
                if (targetStep.status === 'done') {
                    addAgentMsg(`Step **${target} (${targetStep.label})** is already complete. Type \`/where\` to see your current step.`);
                    return;
                }
                if (!activeStepIndex || target !== activeStepIndex) {
                    addAgentMsg(`I can't skip ahead to Step **${target}**.\n\nCurrent executable step is **${activeStepIndex || 1}: ${activeStep?.label || actionableSteps[0].label}**. Type ${randomGoCmd()} to continue.`);
                    return;
                }
                forceExecuteCurrent = true;
            }

            // ---- CHECKLIST / STATUS COMMAND ----
            // Points user to the visual checklist below — no text duplication
            if (isStatusCommand && !isGoCommand) {
                const nextPending = activeStep;
                const total = actionableSteps.length;

                if (total === 0) {
                    addAgentMsg(` **No execution steps yet.**\n\nType **"setup"** to start the onboarding flow, or paste a worker's wallet address.`);
                } else if (!nextPending) {
                    addAgentMsg(` **All done!** Check the checklist below — everything is green. Paste a new worker wallet to add another, or ask me anything.`);
                } else {
                    const nextIdx = activeStepIndex ?? 1;
                    addAgentMsg(` **Check the checklist below.** You're on **Step ${nextIdx}: ${nextPending.label}**.\n\nType ${randomGoCmd()} to execute it!`);
                }
                return;
            }

            // ---- "USE MY WALLET" SHORTCUT ----
            const isUseMyWallet = /\b(use\s+my\s+wallet|demo\s+mode|my\s+wallet|use\s+this\s+wallet)\b/i.test(text);
            if (isUseMyWallet && walletAddress) {
                onApplyPlan({ employeeWallet: walletAddress, intent: 'create_stream' } as any);
                addAgentMsg(` **Using your wallet as the worker wallet!**\n\n\`${walletAddress}\`\n\nType ${randomGoCmd()} and I'll continue with the next pending setup step.`);
                return;
            }

            // ---- SOLANA ADDRESS DETECTION ----
            const solanaAddrMatch = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
            if (solanaAddrMatch && !isGoCommand) {
                const addr = solanaAddrMatch[1];
                const isJustAddress = text.trim().length < 60;
                if (isJustAddress) {
                    onApplyPlan({ employeeWallet: addr, intent: 'create_stream' } as any);
                    addAgentMsg(` **Worker wallet set!**\n\n\`${addr}\`\n\nType ${randomGoCmd()} and I'll continue with the next pending setup step.`);
                    return;
                }
            }

            // ---- GO COMMAND EXECUTION ----
            // ALWAYS try to execute when the user says "go" — the backend (executeNextAgentStep)
            // rebuilds the queue from blockchain state, so it has the freshest truth.
            if ((isGoCommand || forceExecuteCurrent) && !isEditKeyword) {
                setShowExecutionLog(true);
                setPhase('executing');
                setThinking(true);

                const nextStep = actionableSteps.find(s => s.status === 'pending' || s.status === 'running');
                const stepCount = actionableSteps.length;
                const nextIdx = actionableSteps.findIndex(s => s.key === nextStep?.key) + 1;

                if (nextStep) {
                    addAgentMsg(` **Executing Step ${nextIdx}/${stepCount}: ${nextStep.label}...**\n\n*Please approve the transaction in your wallet to proceed...*`);
                } else {
                    addAgentMsg(` **Checking for remaining steps...**\n\n*Please approve the transaction in your wallet to proceed...*`);
                }

                try {
                    // Start execution — the backend will rebuild the queue and run the real next step
                    const step = await onExecutePlan('next');

                    // Use a local check for the NEXT pending step instead of relying on stale props
                    const nextStepExists = actionableSteps.some(s => s.status === 'pending' && s.key !== step?.key);

                    if (!step && !nextStepExists) {
                        addAgentMsg(` **All steps completed successfully!** Your payroll setup is now live and fully operational.`);
                        setPhase('done');
                        return;
                    }

                    if (step?.status === 'done') {
                        const proof = step.txid ? `\n\n**🔗 Transaction Proof:**\n[View on Solscan](https://solscan.io/tx/${step.txid}?cluster=devnet)` : '';

                        if (step.key === 'init-vault') {
                            addAgentMsg(` **Vault custody is complete!** Your company profile and payroll vault are fully initialized.${proof}\n\nType ${randomGoCmd()} to continue with the next checklist step.`);
                            setPhase('executing');
                        } else if (step.key === 'deposit-funds') {
                            addAgentMsg(` **Funding is complete!** Funds have been successfully deposited into the payroll vault.${proof}\n\nType ${randomGoCmd()} to continue with the next checklist step.`);
                        } else if (step.key === 'create-worker-record') {
                            // Check if high-speed mode step exists and is pending
                            const hsStep = executionSteps.find(s => s.key === 'enable-high-speed');
                            if (hsStep && hsStep.status === 'pending') {
                                addAgentMsg(` **Private payroll record created!** The employee can now open the **Employee Portal**.${proof}\n\n*Automation decrypt handling was configured in options. For earnings reveal, use keeper relay grant from Employee Portal if needed.*\n\nType \`/proof\` to see privacy verification, then ${randomGoCmd()} to continue with high-speed mode.`);
                                setPhase('confirm_plan');
                            } else {
                                addAgentMsg(` **Private payroll record created!** The employee can now open the **Employee Portal**.${proof}\n\n*Automation decrypt handling was configured in options. For earnings reveal, use keeper relay grant from Employee Portal if needed.*\n\n **Setup is complete!** The employee can now open the **Employee Portal** at /employee.\nType \`/proof\` any time to see encryption/delegation verification.`);
                                setPhase('done');
                            }
                        } else if (step.key === 'enable-high-speed') {
                            addAgentMsg(` **High-speed mode enabled!** Your payroll stream is now delegated to MagicBlock for faster delegated execution.${proof}\n\n **Setup is complete!** The employee can now open the **Employee Portal** at /employee for earnings and withdrawals.\nType \`/proof\` to review security proof with tx links.`);
                            setPhase('done');
                        } else if (step.key === 'create-depositor-token') {
                            addAgentMsg(` **Company source account created!** ${proof}\n\n**How much payroll funds** do you want to deposit into the vault? (e.g. type "10" or "fund 100")`);
                            setPhase('ask_funding');
                            return;
                        } else if (step.key === 'init-automation') {
                            addAgentMsg(` **Automation service initialized!**${proof}\n\nNow let's add a worker. Please paste the **worker's Solana wallet address** or say **"use my wallet"** to test with your own wallet.`);
                            setPhase('ask_wallet');
                        } else if (step.key === 'create-worker-token') {
                            addAgentMsg(` **Privacy route confirmed.** No fixed destination account is required in this mode.${proof}\n\nNow let's configure worker options and finalize the private payroll record.`);
                            setOptionStep(0);
                            setPhase('ask_options');
                        } else if (step.key === 'configure-worker-options') {
                            addAgentMsg(` **Worker options configured!** Now let's set up your worker record preferences.\n\n **Would you like the worker to be able to view their earnings automatically?** (yes/no)`);
                            setOptionStep(0);
                            setPhase('ask_options');
                        } else {
                            addAgentMsg(` **Step Complete: ${step.label}**\nReasoning: ${step.detail || 'The operation was successful.'}${proof}\n\nType ${randomGoCmd()} to move to the next step, or ask me any questions.`);
                        }
                        // Only keep 'executing' phase for steps that don't set their own phase
                        const stepsWithOwnPhase = ['init-automation', 'create-worker-token', 'configure-worker-options', 'create-depositor-token', 'create-worker-record', 'enable-high-speed'];
                        if (!stepsWithOwnPhase.includes(step.key)) setPhase('confirm_plan');
                    }
                } catch (e: any) {
                    const msg = e?.message || 'Transaction rejected';
                    if (msg === 'ABORTED') return;
                    addAgentMsg(`❌ **Step failed:** ${msg}\n\nYou can type **"go"** to retry, or ask me what happened.`);
                    setPhase('confirm_plan');
                } finally {
                    setThinking(false);
                }
                return;
            }

            // ---- EDIT / MODIFY PLAN HANDLER ----
            if (shouldParsePlanChange) {
                if (isOptionsKeyword) {
                    addAgentMsg(`Sure! Let's re-configure options.\n\n **Allow automation service decrypt access?** (yes/no)`);
                    setOptionStep(0);
                    setPhase('ask_options');
                    return;
                }

                setThinking(true);
                try {
                    const plan = await onDraftPlan(text, {});
                    if (plan && (plan.payPreset || plan.salaryPerSecond || plan.payAmount)) {
                        setPendingPlan(plan);
                        onApplyPlan(plan);
                        const details: string[] = [];
                        if (plan.payPreset) details.push(`Pay: **${plan.payPreset}**`);
                        if (plan.payAmount) details.push(`Amount: **${plan.payAmount}**`);
                        addAgentMsg(` **Pay plan updated!**\n\n${details.join('\n')}\n\nType ${randomGoCmd()} to proceed.`);
                        setPhase('confirm_plan');
                    } else if (isEditKeyword) {
                        addAgentMsg(`Tell me the new plan, e.g. "500 per month".`);
                        setPhase('ask_pay');
                    } else {
                        const { reply } = await askGrok(text);
                        addAgentMsg(reply);
                    }
                } catch {
                    addAgentMsg(`I couldn't parse that. Try "500 per month".`);
                } finally {
                    setThinking(false);
                }
                return;
            }

            setThinking(true);
            try {
                const { reply, action } = await askGrok(text);
                const canApplyAiAction =
                    isGoCommand ||
                    isStatusCommand ||
                    shouldParsePlanChange ||
                    isUseMyWallet ||
                    !!solanaAddrMatch ||
                    /\b(setup|start|reset|cancel|abort|stop)\b/i.test(lower);

                const contextHint =
                    activeStep && activeStepIndex
                        ? `\n\nCurrent focus: **Step ${activeStepIndex}: ${activeStep.label}**. Type ${randomGoCmd()} to continue.`
                        : '';

                if (!canApplyAiAction && activeStep) {
                    addAgentMsg(`${reply}${contextHint}`);
                } else {
                    addAgentMsg(reply);
                }

                if (canApplyAiAction && action?.type === 'set_phase') setPhase(action.phase);
                if (canApplyAiAction && action?.type === 'apply_plan') onApplyPlan(action.plan);
            } catch {
                addAgentMsg(`I'm sorry, I'm having trouble. Try "go" to continue.`);
            } finally {
                setThinking(false);
            }
        } finally {
            isSending.current = false;
        }
    }, [
        input, thinking, busy, ready, hydrated, phase,
        businessExists, vaultExists, configExists, addAgentMsg, addUserMsg,
        askGrok, executionSteps, onDraftPlan, onExecutePlan, onApplyPlan, actionableSteps, activeStep, activeStepIndex,
        setInput, walletAddress, setDepositAmount, setOptionStep, optionStep,
        setAutoGrantKeeperDecrypt, setBoundPresetPeriod, onCancelBusy, setPhase, proofSummary
    ]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
            }
        },
        [handleSend]
    );

    const triggerQuickCommand = useCallback(
        (command: string) => {
            if (!walletConnected || thinking || busy || !ready || !hydrated) return;
            setInput(command);
            setTimeout(() => {
                void handleSend();
            }, 0);
        },
        [walletConnected, thinking, busy, ready, hydrated, handleSend]
    );

    const timelineSteps = actionableSteps.filter((step) => {
        const label = (step.label || '').toLowerCase();
        const detail = (step.detail || '').toLowerCase();
        if (label.includes('not needed')) return false;
        if (detail.startsWith('skipped:')) return false;
        return true;
    });

    return (
        <section className="premium-agent-container glass overflow-hidden border border-[var(--app-border)] shadow-2xl rounded-3xl flex flex-col h-[680px] max-h-[82vh] bg-[var(--app-surface)] backdrop-blur-xl transition-all duration-500 hover:shadow-cyan-500/5 hover:border-cyan-400">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--app-border)] bg-[var(--app-surface-alt)] backdrop-blur-md">
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#bff2ff] via-[#8fe8ff] to-[#6fdcff] flex items-center justify-center shadow-lg ring-2 ring-cyan-300/20">
                            <Logo className="w-5 h-5 text-[#05334a]" />
                        </div>
                        <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[var(--app-surface)] shadow-sm ${phase === 'executing' ? 'bg-amber-500' : !ready || !hydrated || thinking ? 'bg-cyan-400 animate-pulse' : 'bg-emerald-500'
                            }`} />
                    </div>
                    <div>
                        <h2 className="text-[17px] font-bold text-[var(--app-ink)] tracking-tight leading-tight">OnyxFii Intelligence</h2>
                        <p className="text-[11px] font-semibold text-[var(--app-muted)] uppercase tracking-[0.14em] flex items-center gap-1.5 mt-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                            {phase === 'executing' ? 'Active' : thinking ? 'Thinking' : 'Ready'}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {messages.length > 0 && (
                        <button
                            onClick={handleClearChat}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-1.5 text-[10px] font-bold text-[var(--app-muted)] hover:text-[var(--app-ink)] hover:border-cyan-300/40 hover:bg-[var(--app-surface-alt)] transition-all"
                            title="Clear Chat"
                            disabled={busy || phase === 'executing'}
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            <span>Clear Chat</span>
                        </button>
                    )}
                </div>
            </div>

            {walletConnected && actionableSteps.length > 0 && (
                <div className="px-3 py-1.5 border-b border-[var(--app-border)] bg-[var(--app-surface)]/70 backdrop-blur-md">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-cyan-300 whitespace-nowrap">
                            {activeStep && activeStepIndex
                                ? `Step ${activeStepIndex}/${actionableSteps.length}`
                                : 'Completed'}
                        </span>
                        <span className="text-[10px] font-semibold text-[var(--app-ink)] truncate flex-1">
                            {activeStep ? activeStep.label : 'All setup steps completed'}
                        </span>
                        <button
                            onClick={() => triggerQuickCommand('/run')}
                            disabled={!activeStep || phase === 'executing' || thinking || busy}
                            className="px-2 py-0.5 rounded-md border border-cyan-400/40 bg-cyan-500/10 text-[9px] font-bold uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40"
                        >
                            Run
                        </button>
                    </div>
                    <div className="mt-1 h-0.5 rounded-full bg-[var(--app-surface-alt)] overflow-hidden border border-[var(--app-border)]">
                        <div
                            className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-500"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Messages Area */}
            <div ref={messagesRef} className="chat-scrollbar flex-1 overflow-y-auto p-6 space-y-6">
                {(!ready || !hydrated) && walletConnected && (
                    <div className="flex flex-col items-center justify-center py-12">
                        <div className="w-10 h-10 border-2 border-cyan-400/25 border-t-cyan-300 rounded-full animate-spin mb-4" />
                        <p className="text-xs font-bold text-cyan-300/80 uppercase tracking-widest">Agent Wallet Synchronizing...</p>
                    </div>
                )}

                {!walletConnected && (
                    <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                        <div className="w-16 h-16 rounded-3xl bg-[var(--app-surface-alt)] flex items-center justify-center text-3xl mb-4 text-[var(--app-muted)]">
                            <Logo className="w-10 h-10" />
                        </div>
                        <h3 className="text-sm font-bold text-[var(--app-ink)] mb-1">Authorization Missing</h3>
                        <p className="text-xs text-[var(--app-muted)] max-w-[200px]">Connect your secure wallet to authorize AI command access.</p>
                    </div>
                )}

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.role === 'agent' ? 'justify-start' : 'justify-end'}`}
                    >
                        <div className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm shadow-sm transition-all duration-300 ${msg.role === 'agent'
                            ? 'bg-[var(--app-surface-alt)] border border-[var(--app-border)] text-[var(--app-ink)]'
                            : 'bg-cyan-600 text-white font-medium shadow-xl shadow-black/20'
                            }`}>
                            {msg.text.split('\n').map((line, i) => (
                                <span key={i} className="block mb-1 last:mb-0">
                                    {line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, j) =>
                                        part.startsWith('**') && part.endsWith('**') ? (
                                            <strong key={j} className="text-cyan-500 dark:text-cyan-400 font-extrabold">{part.slice(2, -2)}</strong>
                                        ) : part.startsWith('`') && part.endsWith('`') ? (
                                            <code key={j} className="bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 px-1.5 py-0.5 rounded-md text-[12px] font-mono mx-0.5 border border-[var(--app-border)]">{part.slice(1, -1)}</code>
                                        ) : part.startsWith('[') && part.includes('](') && part.endsWith(')') ? (
                                            <a key={j} href={part.match(/\]\(([^)]+)\)/)?.[1] || '#'} target="_blank" rel="noopener noreferrer" className="text-indigo-500 underline decoration-indigo-500/30 hover:decoration-indigo-500 transition-all font-bold">
                                                {part.match(/\[([^\]]+)\]/)?.[1] || 'Link'}
                                            </a>
                                        ) : (
                                            <span key={j}>{part}</span>
                                        )
                                    )}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}

                {thinking && (
                    <div className="flex justify-start">
                        <div className="bg-[var(--app-surface-alt)] border border-[var(--app-border)] rounded-2xl px-5 py-4 flex gap-1.5 shadow-sm">
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--app-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--app-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-1.5 h-1.5 rounded-full bg-[var(--app-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                    </div>
                )}

                {timelineSteps.length > 0 && (
                    <div className="mt-8 border-t border-[var(--app-border)] pt-6">
                        <div className="flex items-center justify-between mb-4 px-2">
                            <div className="flex items-center gap-2">
                                <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse"></div>
                                <span className="text-[10px] font-extrabold text-[var(--app-muted)] uppercase tracking-widest italic">Blockchain Real-time Execution Log</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowExecutionLog((prev) => !prev)}
                                className="rounded-full border border-[var(--app-border)] bg-[var(--app-surface-alt)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--app-muted)] hover:text-cyan-200 hover:border-cyan-400/40 transition"
                            >
                                {showExecutionLog ? 'Hide' : 'Show'}
                            </button>
                        </div>
                        {showExecutionLog && (
                            <div className="space-y-3 px-2">
                                {timelineSteps.map((step, idx) => (
                                    <div key={step.key} className="flex items-start gap-4 group">
                                        <div className="flex flex-col items-center">
                                            <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold border-2 transition-all ${step.status === 'done' ? 'bg-emerald-500 border-emerald-500 text-white' :
                                                step.status === 'running' ? 'bg-cyan-500/10 border-cyan-400 text-cyan-500 dark:text-cyan-400 animate-pulse ring-4 ring-indigo-500/10' :
                                                    step.status === 'failed' ? 'bg-red-500 border-red-500 text-white' :
                                                        'bg-[var(--app-surface-alt)] border-[var(--app-border)] text-[var(--app-muted)]'
                                                }`}>
                                                {step.status === 'done' ? '✓' : idx + 1}
                                            </div>
                                            {idx !== timelineSteps.length - 1 && (
                                                <div className="w-0.5 h-4 bg-[var(--app-border)] group-hover:bg-[var(--app-muted)] transition-colors" />
                                            )}
                                        </div>
                                        <div className="flex-1 pt-0.5">
                                            <div className={`text-xs font-bold transition-colors ${step.status === 'done' ? 'text-[var(--app-ink)] line-through' :
                                                step.status === 'running' ? 'text-cyan-500 dark:text-cyan-400' : 'text-[var(--app-muted)]'
                                                }`}>
                                                {step.label}
                                            </div>
                                            {step.detail && (
                                                <div className="text-[10px] text-[var(--app-muted)] font-medium mt-0.5 italic">{step.detail}</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="h-4" />
            </div>

            {/* Input Area */}
            <div className="p-5 border-t border-[var(--app-border)] bg-[var(--app-surface-alt)] backdrop-blur-md">
                {walletConnected && ready && hydrated && (
                    <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--app-muted)]">Try</span>
                        {['/run', '/steps', '/proof', '/where', '/help'].map((cmd) => (
                            <button
                                key={cmd}
                                type="button"
                                onClick={() => triggerQuickCommand(cmd)}
                                disabled={thinking || busy || phase === 'executing'}
                                className="rounded-full border border-cyan-500/25 bg-cyan-500/8 px-2 py-0.5 text-[9px] font-bold tracking-wide text-cyan-200 hover:bg-cyan-500/15 disabled:opacity-40 transition"
                            >
                                {cmd}
                            </button>
                        ))}
                    </div>
                )}
                <div className="relative group">
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={!walletConnected || (thinking && phase !== 'executing') || !ready || !hydrated}
                        placeholder={
                            !walletConnected ? 'Authorize wallet access...' :
                                thinking ? 'Synchronizing brain...' :
                                    'Type a command or ask me about setup...'
                        }
                        className="w-full pl-5 pr-32 py-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)] shadow-sm outline-none transition-all focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/20 font-medium text-sm text-[var(--app-ink)]"
                    />

                    <div className="absolute right-2 top-2 bottom-2 flex gap-2">
                        {executionSteps.some(s => s.status === 'pending' && s.key !== 'refresh-state') &&
                            !thinking && !busy && walletConnected && phase !== 'executing' && (
                                <button
                                    onClick={() => { setInput('execute'); setTimeout(() => handleSend(), 0); }}
                                    className="px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-bold uppercase tracking-wider shadow-lg shadow-emerald-500/20 transition-all active:scale-95"
                                >
                                    Run Next
                                </button>
                            )}
                        <button
                            id="agent-send-btn"
                            onClick={() => void handleSend()}
                            disabled={!walletConnected || !input.trim() || (thinking && phase !== 'executing') || !ready || !hydrated}
                            className="w-12 h-full bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl flex items-center justify-center transition-all disabled:opacity-20 active:scale-90 shadow-xl"
                        >
                            {(thinking && (busy || phase === 'executing')) ? '...' : (
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                                </svg>
                            )}
                        </button>
                    </div>
                </div>
                <div className="mt-3 flex items-center justify-between px-2">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-[var(--app-border)]"></div>
                            <span className="text-[9px] font-bold text-[var(--app-muted)] uppercase tracking-widest whitespace-nowrap">Verified</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-[var(--app-border)]"></div>
                            <span className="text-[9px] font-bold text-[var(--app-muted)] uppercase tracking-widest whitespace-nowrap">Encrypted</span>
                        </div>
                    </div>
                    {busy && (
                        <button
                            onClick={() => { if (onCancelBusy) onCancelBusy(); setPhase('ask_setup'); setThinking(false); isSending.current = false; }}
                            className="text-[9px] font-extrabold text-red-500 uppercase tracking-tighter hover:underline"
                        >
                            Emergency Force Cancel
                        </button>
                    )}
                </div>
            </div>
        </section>
    );
}
