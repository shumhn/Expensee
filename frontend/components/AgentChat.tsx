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
    }, [messages, businessExists, vaultExists, configExists, depositorBalance, vaultBalance, depositorTokenAccount, employeeWallet, payPreset, payAmount, streamIndex, executionSteps, phase, autoGrantKeeperDecrypt, boundPresetPeriod]);

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
                                addAgentMsg(`🎉 **Step 11 (Worker Record) created!** The employee can now open the **Employee Portal**.${proof}\n\n*Automation decrypt handling was configured in options. For earnings reveal, use keeper relay grant from Employee Portal if needed.*\n\nType ${randomGoCmd()} to continue with **Enable High-speed Mode**, or you're all set!`);
                                setPhase('confirm_plan');
                            } else {
                                addAgentMsg(`🎉 **Step 11 (Worker Record) created!** The employee can now open the **Employee Portal**.${proof}\n\n*Automation decrypt handling was configured in options. For earnings reveal, use keeper relay grant from Employee Portal if needed.*\n\n🎉 **Setup is complete!** The employee can now open the **Employee Portal** at /employee.`);
                                setPhase('done');
                            }
                        } else if (step.key === 'enable-high-speed') {
                            addAgentMsg(`⚡ **Step 8 (High-speed mode) enabled!** Your payroll stream is now delegated to MagicBlock for faster delegated execution.${proof}\n\n🎉 **Setup is complete!** The employee can now open the **Employee Portal** at /employee for earnings and withdrawals.`);
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
                    setAutoGrantKeeperDecrypt?.(isYes);
                    addAgentMsg(isYes ? `✅ **Automation enabled.**\n\n` : `⬜ **Manual settlement only.**\n\n`);
                    addAgentMsg(`⏱️ **Stop payroll automatically at the end of period?** (yes/no)`);
                    setOptionStep(1);
                } else if (optionStep === 1) {
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
                    addAgentMsg(`Sure! Let's re-configure options.\n\n🤖 **Allow automation service decrypt access?** (yes/no)`);
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
        setAutoGrantKeeperDecrypt, setBoundPresetPeriod
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
        <section className="premium-agent-container glass overflow-hidden border border-slate-200/50 shadow-2xl rounded-3xl flex flex-col h-[500px] bg-slate-50/20 backdrop-blur-xl transition-all duration-500 hover:shadow-indigo-500/10 hover:border-indigo-500/30">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-200/50 bg-white/40 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-2xl shadow-lg ring-4 ring-indigo-500/10">
                            🤖
                        </div>
                        <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white shadow-sm ${phase === 'executing' ? 'bg-amber-500' : !ready || !hydrated || thinking ? 'bg-indigo-400 animate-pulse' : 'bg-emerald-500'
                            }`} />
                    </div>
                    <div>
                        <h2 className="text-sm font-bold text-slate-900 tracking-tight">OnyxFii Intelligence</h2>
                        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mt-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                            {phase === 'executing' ? 'Processor Active' : thinking ? 'Analyzing Engine' : 'Hybrid AI Online'}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {messages.length > 0 && (
                        <button
                            onClick={handleClearChat}
                            className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 transition-all"
                            title="Reset Terminal"
                            disabled={busy || phase === 'executing'}
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-hide">
                {(!ready || !hydrated) && walletConnected && (
                    <div className="flex flex-col items-center justify-center py-12">
                        <div className="w-10 h-10 border-2 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-4" />
                        <p className="text-xs font-bold text-indigo-500/60 uppercase tracking-widest">Quantum Link Synchronizing...</p>
                    </div>
                )}

                {!walletConnected && (
                    <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center text-3xl mb-4 text-slate-400">
                            🔌
                        </div>
                        <h3 className="text-sm font-bold text-slate-700 mb-1">Authorization Missing</h3>
                        <p className="text-xs text-slate-400 max-w-[200px]">Connect your secure wallet to authorize AI command access.</p>
                    </div>
                )}

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.role === 'agent' ? 'justify-start' : 'justify-end'}`}
                    >
                        <div className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm shadow-sm transition-all duration-300 ${msg.role === 'agent'
                            ? 'bg-white border border-slate-100 text-slate-700'
                            : 'bg-slate-900 text-white font-medium shadow-xl shadow-slate-900/10'
                            }`}>
                            {msg.text.split('\n').map((line, i) => (
                                <span key={i} className="block mb-1 last:mb-0">
                                    {line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, j) =>
                                        part.startsWith('**') && part.endsWith('**') ? (
                                            <strong key={j} className="text-indigo-600 font-extrabold">{part.slice(2, -2)}</strong>
                                        ) : part.startsWith('`') && part.endsWith('`') ? (
                                            <code key={j} className="bg-slate-100 text-indigo-600 px-1.5 py-0.5 rounded-md text-[12px] font-mono mx-0.5 border border-slate-200">{part.slice(1, -1)}</code>
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
                        <div className="bg-white border border-slate-100 rounded-2xl px-5 py-4 flex gap-1.5 shadow-sm">
                            <div className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                    </div>
                )}

                {executionSteps.length > 0 && (
                    <div className="mt-8 border-t border-slate-100 pt-6">
                        <div className="flex items-center gap-2 mb-4 px-2">
                            <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-pulse"></div>
                            <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest italic">Blockchain Real-time Execution Log</span>
                        </div>
                        <div className="space-y-3 px-2">
                            {executionSteps.map((step, idx) => (
                                <div key={step.key} className="flex items-start gap-4 group">
                                    <div className="flex flex-col items-center">
                                        <div className={`w-6 h-6 rounded-lg flex items-center justify-center text-[10px] font-bold border-2 transition-all ${step.status === 'done' ? 'bg-emerald-500 border-emerald-500 text-white' :
                                            step.status === 'running' ? 'bg-white border-indigo-500 text-indigo-500 animate-pulse ring-4 ring-indigo-500/10' :
                                                step.status === 'failed' ? 'bg-red-500 border-red-500 text-white' :
                                                    'bg-white border-slate-200 text-slate-400'
                                            }`}>
                                            {step.status === 'done' ? '✓' : idx + 1}
                                        </div>
                                        {idx !== executionSteps.length - 1 && (
                                            <div className="w-0.5 h-4 bg-slate-100 group-hover:bg-slate-200 transition-colors" />
                                        )}
                                    </div>
                                    <div className="flex-1 pt-0.5">
                                        <div className={`text-xs font-bold transition-colors ${step.status === 'done' ? 'text-slate-900 line-through' :
                                            step.status === 'running' ? 'text-indigo-600' : 'text-slate-400'
                                            }`}>
                                            {step.label}
                                        </div>
                                        {step.detail && (
                                            <div className="text-[10px] text-slate-400 font-medium mt-0.5 italic">{step.detail}</div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div ref={bottomRef} className="h-4" />
            </div>

            {/* Input Area */}
            <div className="p-5 border-t border-slate-200/50 bg-white/40 backdrop-blur-md">
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
                        className="w-full pl-5 pr-32 py-4 rounded-2xl border border-slate-200/60 bg-white/80 shadow-inner outline-none transition-all focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 font-medium text-sm text-slate-700"
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
                            className="w-12 h-full bg-slate-900 hover:bg-black text-white rounded-xl flex items-center justify-center transition-all disabled:opacity-20 active:scale-90 shadow-xl"
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
                            <div className="w-1 h-1 rounded-full bg-slate-400"></div>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">L3 Verified Node</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-1 h-1 rounded-full bg-slate-400"></div>
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">End-to-End Encrypted</span>
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
