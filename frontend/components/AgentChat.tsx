import { useCallback, useEffect, useRef, useState } from 'react';

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
    autoGrantDecrypt?: boolean;
    setAutoGrantDecrypt?: (val: boolean) => void;
    autoGrantKeeperDecrypt?: boolean;
    setAutoGrantKeeperDecrypt?: (val: boolean) => void;
    boundPresetPeriod?: boolean;
    setBoundPresetPeriod?: (val: boolean) => void;
};

const GO_COMMANDS = [
    '**"go"**',
    '**"execute"**',
    '**"let\'s go"**',
    '**"run"**',
    '**"next"**',
    '**"proceed"**',
    '**"do it"**',
    '**"let\'s go"** 🚀',
    '**"run"** ⚡',
    '**"execute"** 🔥',
    '**"next"** →',
    '**"go"** 💨',
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
    autoGrantDecrypt,
    setAutoGrantDecrypt,
    autoGrantKeeperDecrypt,
    setAutoGrantKeeperDecrypt,
    boundPresetPeriod,
    setBoundPresetPeriod,
}: AgentChatProps) {
    const [input, setInput] = useState('');
    const [pendingPlan, setPendingPlan] = useState<ParsedPlan | null>(null);
    const [thinking, setThinking] = useState(false);
    const [optionStep, setOptionStep] = useState(0);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const hasGreeted = useRef(false);
    const isSending = useRef(false);

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
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
                        currentlyActiveStep: executionSteps.find(s => s.status === 'pending'),
                        depositorBalance,
                        vaultBalance,
                        depositorTokenAccount,
                        employeeWallet,
                        payPreset,
                        payAmount,
                        streamIndex,
                        autoGrantDecrypt,
                        autoGrantKeeperDecrypt,
                        boundPresetPeriod
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
    }, [messages, businessExists, vaultExists, configExists, depositorBalance, vaultBalance, depositorTokenAccount, employeeWallet, payPreset, payAmount, streamIndex, executionSteps, phase, autoGrantDecrypt, autoGrantKeeperDecrypt, boundPresetPeriod]);

    const handleSend = useCallback(async () => {
        const text = input.trim();

        // 🚨 EMERGENCY BAILOUT: If the wallet was closed and the promise hung, let the user force a reset
        if ((busy || phase === 'executing') && /\b(cancel|reset|stop|abort)\b/i.test(text)) {
            if (onCancelBusy) onCancelBusy();
            addAgentMsg(`⏸️ I've forcefully cancelled the waiting operation. Type ${randomGoCmd()} when you are ready to try again.`);
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

                const isGoContent = /\b(?:go|continue|yes|skip|proceed)\b/i.test(text);
                const numMatch = text.match(/\b\d+(\.\d+)?\b/);

                if (numMatch) {
                    const amount = numMatch[0];
                    setDepositAmount(amount);
                    addAgentMsg(`✅ Got it! Moving **${amount} PayUSD** to your payroll vault.\n\n*Automatically proceeding to execute funding steps... Please approve the next transactions in your wallet.*`);

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

            const lower = text.toLowerCase();
            const isStatusCommand = /\b(status|checklist|tasks|where\s*am\s*i|progress|steps|show\s*steps)\b/i.test(lower);
            const isGoCommand = /\b(setup|start|yes|go|continue|execute|run|do\s*it|next|proceed|lets\s*go|let's\s*go)\b/i.test(lower);
            const isEditKeyword = /\b(edit|change|no|update|modify)\b/i.test(lower);
            const isOptionsKeyword = /\b(option|options|settings|permissions|access|auto.?stop)\b/i.test(lower);
            const hasNumber = /\d/.test(text);

            // ---- CHECKLIST / STATUS COMMAND ----
            // Points user to the visual checklist below — no text duplication
            if (isStatusCommand && !isGoCommand) {
                const nextPending = executionSteps.find(s => s.status === 'pending' && s.key !== 'refresh-state');
                const total = executionSteps.length;

                if (total === 0) {
                    addAgentMsg(`📋 **No execution steps yet.**\n\nType **"setup"** to start the onboarding flow, or paste a worker's wallet address.`);
                } else if (!nextPending) {
                    addAgentMsg(`✅ **All done!** Check the checklist below — everything is green. Paste a new worker wallet to add another, or ask me anything.`);
                } else {
                    const nextIdx = executionSteps.findIndex(s => s.key === nextPending.key) + 1;
                    addAgentMsg(`👇 **Check the checklist below.** You're on **Step ${nextIdx}: ${nextPending.label}**.\n\nType ${randomGoCmd()} to execute it!`);
                }
                return;
            }

            // ---- "USE MY WALLET" SHORTCUT ----
            const isUseMyWallet = /\b(use\s+my\s+wallet|demo\s+mode|my\s+wallet|use\s+this\s+wallet)\b/i.test(text);
            if (isUseMyWallet && walletAddress) {
                onApplyPlan({ employeeWallet: walletAddress, intent: 'create_stream' } as any);
                addAgentMsg(`✅ **Using your wallet as the worker wallet!**\n\n\`${walletAddress}\`\n\nThe next step is to **Create Worker Destination Account**. Type ${randomGoCmd()} when you're ready and approve the transaction in your wallet.`);
                return;
            }

            // ---- SOLANA ADDRESS DETECTION ----
            const solanaAddrMatch = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
            if (solanaAddrMatch && !isGoCommand) {
                const addr = solanaAddrMatch[1];
                const isJustAddress = text.trim().length < 60;
                if (isJustAddress) {
                    onApplyPlan({ employeeWallet: addr, intent: 'create_stream' } as any);
                    addAgentMsg(`✅ **Worker wallet set!**\n\n\`${addr}\`\n\nThe next step is to **Create Worker Destination Account**. Type ${randomGoCmd()} when you're ready and approve the transaction in your wallet.`);
                    return;
                }
            }

            const hasWorkToDo = !businessExists || !vaultExists || !configExists;
            const hasPendingSteps = executionSteps.some(s => s.status === 'pending' && s.key !== 'refresh-state');

            // ---- GO COMMAND EXECUTION ----
            // ALWAYS try to execute when the user says "go" — the backend (executeNextAgentStep)
            // rebuilds the queue from blockchain state, so it has the freshest truth.
            if (isGoCommand && !isEditKeyword) {
                setPhase('executing');
                setThinking(true);

                const nextStep = executionSteps.find(s => s.status === 'pending' && s.key !== 'refresh-state');
                const stepCount = executionSteps.length;
                const nextIdx = executionSteps.findIndex(s => s.key === nextStep?.key) + 1;

                if (nextStep) {
                    addAgentMsg(`🚀 **Executing Step ${nextIdx}/${stepCount}: ${nextStep.label}...**\n\n*Please approve the transaction in your wallet to proceed...*`);
                } else {
                    addAgentMsg(`🚀 **Checking for remaining steps...**\n\n*Please approve the transaction in your wallet to proceed...*`);
                }

                try {
                    // Start execution — the backend will rebuild the queue and run the real next step
                    const step = await onExecutePlan('next');

                    // Use a local check for the NEXT pending step instead of relying on stale props
                    const nextStepExists = executionSteps.some(s => s.status === 'pending' && s.key !== 'refresh-state' && s.key !== step?.key);

                    if (!step && !nextStepExists) {
                        addAgentMsg(`✅ **All steps completed successfully!** Your payroll setup is now live and fully operational.`);
                        setPhase('done');
                        return;
                    }

                    if (step?.status === 'done') {
                        const proof = step.txid ? `\n\n**🔗 Transaction Proof:**\n[View on Solscan](https://solscan.io/tx/${step.txid}?cluster=devnet)` : '';

                        if (step.key === 'init-vault') {
                            addAgentMsg(`🎊 **Step 4 (Vault Custody) is over!** Your company profile and payroll vault are fully initialized.${proof}\n\nType ${randomGoCmd()} to create your **Company Source Account (Step 5)**.`);
                            setPhase('executing');
                        } else if (step.key === 'deposit-funds') {
                            addAgentMsg(`🎉 **Step 6 (Funding) is complete!** Funds have been successfully deposited into the payroll vault.${proof}\n\nType ${randomGoCmd()} to move to **Step 7 (Initialize automation service)**.`);
                        } else if (step.key === 'create-worker-record') {
                            // Check if high-speed mode step exists and is pending
                            const hsStep = executionSteps.find(s => s.key === 'enable-high-speed');
                            if (hsStep && hsStep.status === 'pending') {
                                addAgentMsg(`🎉 **Step 11 (Worker Record) created!** The worker can now open the **Worker Portal** and view their live earnings.${proof}\n\n*Worker view access and automation decrypt were already handled in options.*\n\nType ${randomGoCmd()} to continue with **Enable High-speed Mode**, or you're all set!`);
                                setPhase('confirm_plan');
                            } else {
                                addAgentMsg(`🎉 **Step 11 (Worker Record) created!** The worker can now open the **Worker Portal** and view their live earnings.${proof}\n\n*Worker view access and automation decrypt were already handled in options.*\n\n🎉 **Setup is complete!** The worker can now open the **Worker Portal** at /employee.`);
                                setPhase('done');
                            }
                        } else if (step.key === 'enable-high-speed') {
                            addAgentMsg(`⚡ **Step 8 (High-speed mode) enabled!** Your payroll stream is now delegated to MagicBlock TEE for real-time salary accrual.${proof}\n\n🎉 **Setup is complete!** The worker can now open the **Worker Portal** at /employee to view their live earnings and request withdrawals.`);
                            setPhase('done');
                        } else if (step.key === 'create-depositor-token') {
                            addAgentMsg(`✅ **Step 5 (Company source account) created!** ${proof}\n\n**How much payroll funds** do you want to deposit into the vault for Step 6? (e.g. type "10" or "fund 100")`);
                            setPhase('ask_funding');
                            return;
                        } else if (step.key === 'init-automation') {
                            addAgentMsg(`✅ **Step 7: Automation service initialized!**${proof}\n\nNow let's add a worker. 👷 Please paste the **worker's Solana wallet address** or say **"use my wallet"** to test with your own wallet.`);
                            setPhase('ask_wallet');
                        } else if (step.key === 'create-worker-token') {
                            addAgentMsg(`✅ **Step 9: Worker destination account created!**${proof}\n\nNow let's set up the pay plan. Here are your options:\n\n💰 **Hourly** — e.g. "pay 25 per hour" (great for contractors)\n💰 **Weekly** — e.g. "pay 500 per week" (standard for part-time)\n💰 **Monthly (30d)** — e.g. "pay 3000 per month" (standard salary)\n💰 **Fixed Total** — e.g. "pay 5000 over 30 days" (project-based)\n💰 **Per-second** — e.g. "pay 0.0001 per second" (advanced)\n\nJust tell me how you'd like to pay!`);
                            setPhase('ask_pay');
                        } else if (step.key === 'configure-worker-options') {
                            addAgentMsg(`✅ **Step 10: Pay plan configured!** Now let's set up your worker record preferences.\n\n👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`);
                            setOptionStep(0);
                            setPhase('ask_options');
                        } else {
                            addAgentMsg(`✅ **Step Complete: ${step.label}**\nReasoning: ${step.detail || 'The operation was successful.'}${proof}\n\nType ${randomGoCmd()} to move to the next step, or ask me any questions.`);
                        }
                        // Only keep 'executing' phase for steps that don't set their own phase
                        const stepsWithOwnPhase = ['init-automation', 'create-worker-token', 'configure-worker-options', 'create-depositor-token', 'create-worker-record', 'enable-high-speed'];
                        if (!stepsWithOwnPhase.includes(step.key)) setPhase('confirm_plan');
                    }
                } catch (e: any) {
                    const msg = e?.message || 'Transaction rejected';
                    if (msg === 'ABORTED') return;
                    addAgentMsg(`❌ **Step failed:** ${msg}\n\nYou can type **"go"** to retry, or ask me what happened.`);
                    setPhase('ask_setup');
                } finally {
                    setThinking(false);
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
                            `👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`,
                            `🤖 **Should the automation service be allowed to process confidential payouts automatically?** (yes/no)`,
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
                    setAutoGrantDecrypt?.(isYes);
                    addAgentMsg(isYes ? `✅ **Worker view access granted.**\n\n` : `⬜ **Manual view only.**\n\n`);
                    addAgentMsg(`🤖 **Allow automation service to process payouts confidentiallly?** (yes/no)`);
                    setOptionStep(1);
                } else if (optionStep === 1) {
                    setAutoGrantKeeperDecrypt?.(isYes);
                    addAgentMsg(isYes ? `✅ **Automation enabled.**\n\n` : `⬜ **Manual settlement only.**\n\n`);
                    addAgentMsg(`⏱️ **Stop payroll automatically at the end of period?** (yes/no)`);
                    setOptionStep(2);
                } else if (optionStep === 2) {
                    setBoundPresetPeriod?.(isYes);
                    addAgentMsg(isYes ? `✅ **Auto-stop active.**\n\n` : `⬜ **Continuous streaming.**\n\n`);
                    addAgentMsg(`🎯 **All options configured!** Type ${randomGoCmd()} to move to **Step 11: Create worker payroll record**.`);
                    setPhase('confirm_plan');
                }
                return;
            }

            // ---- EDIT / MODIFY PLAN HANDLER ----
            if (hasNumber || isEditKeyword || isOptionsKeyword) {
                if (isOptionsKeyword) {
                    addAgentMsg(`Sure! Let's re-configure options.\n\n👁️ **Allow worker view access?** (yes/no)`);
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
                        addAgentMsg(`✅ **Pay plan updated!**\n\n${details.join('\n')}\n\nType ${randomGoCmd()} to proceed.`);
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
                addAgentMsg(reply);
                if (action?.type === 'set_phase') setPhase(action.phase);
                if (action?.type === 'apply_plan') onApplyPlan(action.plan);
            } catch {
                addAgentMsg(`I'm sorry, I'm having trouble. Try "go" to continue.`);
            } finally {
                setThinking(false);
            }
        } finally {
            isSending.current = false;
        }
    }, [
        input, thinking, busy, ready, hydrated, phase, pendingPlan,
        businessExists, vaultExists, configExists, addAgentMsg, addUserMsg,
        askGrok, executionSteps, onDraftPlan, onExecutePlan, onApplyPlan,
        setInput, walletAddress, setDepositAmount, setOptionStep, optionStep,
        setAutoGrantDecrypt, setAutoGrantKeeperDecrypt, setBoundPresetPeriod
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

    return (
        <section className="agent-chat-container">
            <div className="agent-chat-header">
                <div className="agent-chat-header-icon">🤖</div>
                <div>
                    <div className="agent-chat-header-title">OnyxFii Agent</div>
                    <div className="agent-chat-header-subtitle">
                        {phase === 'executing'
                            ? 'Executing transactions...'
                            : !ready || !hydrated
                                ? 'Synchronizing with ledger...'
                                : thinking
                                    ? 'Thinking...'
                                    : 'Real-time · Private · Agentic Payroll'}
                    </div>
                </div>
                <div className="agent-chat-header-status">
                    <span
                        className={`agent-status-dot ${phase === 'executing' ? 'dot-executing' : !ready || !hydrated || thinking ? 'dot-thinking' : 'dot-ready'
                            }`}
                    />
                    {phase === 'executing' ? 'Working' : !ready || !hydrated ? 'Syncing' : thinking ? 'Thinking' : 'Online'}
                    {messages.length > 0 && (
                        <button
                            className="agent-clear-btn"
                            onClick={handleClearChat}
                            title="Clear chat"
                            disabled={busy || phase === 'executing'}
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>

            <div className="agent-chat-messages">
                {(!ready || !hydrated) && walletConnected && (
                    <div className="agent-sync-overlay">
                        <div className="agent-sync-spinner" />
                        <div className="agent-sync-text">Synchronizing with OnyxFii Ledger...</div>
                    </div>
                )}
                {!walletConnected && (
                    <div className="agent-msg">
                        <div className="agent-msg-bubble">
                            👋 Connect your wallet to get started with OnyxFii.
                        </div>
                    </div>
                )}
                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={msg.role === 'agent' ? 'agent-msg' : 'user-msg'}
                    >
                        <div
                            className={
                                msg.role === 'agent' ? 'agent-msg-bubble' : 'user-msg-bubble'
                            }
                        >
                            {msg.text.split('\n').map((line, i) => (
                                <span key={i}>
                                    {line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, j) =>
                                        part.startsWith('**') && part.endsWith('**') ? (
                                            <strong key={j}>{part.slice(2, -2)}</strong>
                                        ) : part.startsWith('`') && part.endsWith('`') ? (
                                            <code key={j} className="agent-inline-code">{part.slice(1, -1)}</code>
                                        ) : part.startsWith('[') && part.includes('](') && part.endsWith(')') ? (
                                            <a key={j} href={part.match(/\]\(([^)]+)\)/)?.[1] || '#'} target="_blank" rel="noopener noreferrer" className="agent-link">
                                                {part.match(/\[([^\]]+)\]/)?.[1] || 'Link'}
                                            </a>
                                        ) : (
                                            <span key={j}>{part}</span>
                                        )
                                    )}
                                    {i < msg.text.split('\n').length - 1 && <br />}
                                </span>
                            ))}
                        </div>
                    </div>
                ))}

                {thinking && (
                    <div className="agent-msg">
                        <div className="agent-msg-bubble agent-thinking">
                            <span className="dot-anim" />
                            <span className="dot-anim" />
                            <span className="dot-anim" />
                        </div>
                    </div>
                )}

                {executionSteps.length > 0 && (
                    <div className="agent-msg">
                        <div className="agent-msg-bubble agent-execution-log">
                            {executionSteps.map((step, idx) => (
                                <div key={step.key} className="agent-exec-step">
                                    <span className="agent-exec-icon">
                                        {step.status === 'done'
                                            ? '✅'
                                            : step.status === 'running'
                                                ? '⏳'
                                                : step.status === 'failed'
                                                    ? '❌'
                                                    : '⬜'}
                                    </span>
                                    <span className="agent-exec-label">
                                        {idx + 1}. {step.label}
                                    </span>
                                    {step.detail && (
                                        <span className="agent-exec-detail">{step.detail}</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <div ref={bottomRef} />
            </div>

            <div className="agent-chat-input-row">
                <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!walletConnected || (thinking && phase !== 'executing') || !ready || !hydrated}
                    placeholder={
                        !walletConnected
                            ? 'Connect wallet first...'
                            : !ready || !hydrated
                                ? 'Synchronizing...'
                                : busy
                                    ? 'Type "cancel" to stop waiting...'
                                    : phase === 'ask_setup'
                                        ? 'Type "setup" to initialize company...'
                                        : phase === 'ask_wallet'
                                            ? 'Paste a Solana wallet address...'
                                            : phase === 'ask_pay'
                                                ? 'e.g. "50 per hour" or "4000 per month"'
                                                : phase === 'ask_options'
                                                    ? 'Type "yes" or "no"...'
                                                    : phase === 'confirm_plan'
                                                        ? 'Type "go" to execute or "edit" to change...'
                                                        : phase === 'executing'
                                                            ? 'Waiting for transactions...'
                                                            : phase === 'done'
                                                                ? 'Ask me anything or paste a new worker wallet...'
                                                                : 'Paste a wallet address or describe a pay plan...'
                    }
                    className="agent-chat-input"
                />
                {(thinking && (busy || phase === 'executing')) ? (
                    <button
                        onClick={() => {
                            if (onCancelBusy) onCancelBusy();
                            setPhase('ask_setup');
                            setThinking(false);
                            isSending.current = false;
                        }}
                        className="agent-chat-send"
                        style={{ background: '#dc3545', marginRight: 4 }}
                    >
                        Cancel
                    </button>
                ) : (
                    // Show "Run Next Step" button if there are pending steps and we're not busy
                    executionSteps.some(s => s.status === 'pending' && s.key !== 'refresh-state') &&
                    !thinking &&
                    !busy &&
                    walletConnected &&
                    phase !== 'executing' && (
                        <button
                            onClick={() => {
                                setInput('execute');
                                setTimeout(() => handleSend(), 0);
                            }}
                            className="agent-chat-send"
                            style={{ background: '#10b981', marginRight: 4, whiteSpace: 'nowrap' }}
                        >
                            ▶ Run Next Step
                        </button>
                    )
                )}
                <button
                    id="agent-send-btn"
                    onClick={() => void handleSend()}
                    disabled={!walletConnected || !input.trim() || (thinking && phase !== 'executing') || !ready || !hydrated}
                    className="agent-chat-send"
                >
                    {(thinking && (busy || phase === 'executing')) ? 'Retry' : 'Send'}
                </button>
            </div>
        </section>
    );
}
