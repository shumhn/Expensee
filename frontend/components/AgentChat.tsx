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
    autoGrantDecrypt?: boolean;
    setAutoGrantDecrypt?: (val: boolean) => void;
    autoGrantKeeperDecrypt?: boolean;
    setAutoGrantKeeperDecrypt?: (val: boolean) => void;
    boundPresetPeriod?: boolean;
    setBoundPresetPeriod?: (val: boolean) => void;
};

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
    }, [setMessages, setPhase]);

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

    // Greeting on wallet connect logic removed (now managed by parent employer.tsx)

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
            addAgentMsg(`⏸️ I've forcefully cancelled the waiting operation. Type **"go"** when you are ready to try again.`);
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
                        // Simulate user typing 'go'
                        setInput('go');
                        isSending.current = false;
                        document.getElementById('agent-send-btn')?.click();
                    }, 500);
                } else if (isGoContent) {
                    // They just typed go without a number, proceed with the default amount
                    setPhase('executing');
                    setThinking(true);
                    setTimeout(() => {
                        setInput('go');
                        isSending.current = false;
                        document.getElementById('agent-send-btn')?.click();
                    }, 500);
                } else {
                    addAgentMsg(`Please provide a number (e.g., "100") or type **"go"** to skip. If you want to chat normally, click **Cancel** first.`);
                }
                return;
            }

            // ---- STRUCTURED HANDLERS (need direct control) ----

            // UNIVERSAL "GO" HANDLER: Intercept go/setup/start/continue/yes
            // The execution queue auto-builds inside onExecutePlan, so we don't need it pre-populated.
            // We just need to know there's WORK to do (on-chain state not complete, OR there are pending steps).
            const lower = text.toLowerCase();

            // ---- "USE MY WALLET" SHORTCUT ----
            const isUseMyWallet = /\b(use\s+my\s+wallet|demo\s+mode|my\s+wallet|use\s+this\s+wallet)\b/i.test(text);
            if (isUseMyWallet && walletAddress) {
                onApplyPlan({ employeeWallet: walletAddress } as any);
                addAgentMsg(`✅ **Using your wallet as the worker wallet!**\n\n\`${walletAddress}\`\n\nThe next step is to **Create Worker Destination Account**. Type **"go"** when you're ready and approve the transaction in your wallet.`);
                return;
            }
            if (isUseMyWallet && !walletAddress) {
                addAgentMsg(`⚠️ Your wallet is not connected. Please connect your wallet first, then say "use my wallet" again.`);
                return;
            }

            // ---- SOLANA ADDRESS DETECTION ----
            // If the user pastes a Solana pubkey (Base58, 32-44 chars), set it as the worker wallet
            const isGoCommand = /\b(setup|start|yes|go|continue|tasks|status|checklist)\b/i.test(text);
            const solanaAddrMatch = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
            if (solanaAddrMatch && !isGoCommand) {
                const addr = solanaAddrMatch[1];
                // Only auto-set if it looks like a standalone address message (not embedded in a question)
                const isJustAddress = text.trim().length < 60;
                if (isJustAddress) {
                    onApplyPlan({ employeeWallet: addr, intent: 'create_stream' } as any);
                    addAgentMsg(`✅ **Worker wallet set!**\n\n\`${addr}\`\n\nThe next step is to **Create Worker Destination Account**. Type **"go"** when you're ready and approve the transaction in your wallet.`);
                    return;
                }
            }

            const hasWorkToDo = !businessExists || !vaultExists || !configExists;
            const hasPendingSteps = executionSteps.some(s => s.status === 'pending' && s.key !== 'refresh-state');

            console.log('[AgentChat] handleSend debug:', {
                text, phase, businessExists, vaultExists, configExists,
                executionStepsCount: executionSteps.length,
                isGoCommand, hasWorkToDo, hasPendingSteps,
            });

            if (isGoCommand && (hasWorkToDo || hasPendingSteps)) {
                if (phase === 'ask_setup' || phase === 'greeting') setPhase('ask_setup');
                setPhase('executing');
                setThinking(true);
                addAgentMsg(`🚀 **Executing next setup step...**\n\n*Please approve the transaction in your wallet to proceed...*`);
                try {
                    const step = await onExecutePlan('next');
                    if (!step) {
                        addAgentMsg(`✅ **All steps completed successfully!** Your payroll setup is now live and fully operational.`);
                        setPhase('done');
                        return;
                    }

                    if (step.status === 'done') {
                        const currentIdx = executionSteps.findIndex(s => s.key === step.key);
                        const skippedCount = executionSteps.slice(0, currentIdx).filter(s => s.status === 'done').length;
                        const skipMsg = skippedCount > 0 ? `*(I verified ${skippedCount} previous steps are already complete on-chain, skipping those)*\n\n` : '';
                        const proof = step.txid ? `\n\n**🔗 Transaction Proof:**\n[View on Solscan](https://solscan.io/tx/${step.txid}?cluster=devnet)` : '';

                        if (step.key === 'init-vault') {
                            addAgentMsg(`${skipMsg}🎊 **Step 4 (Vault Custody) is over!** Your company profile and payroll vault are fully initialized.${proof}\n\nType **"go"** to create your **Company Source Account (Step 5)**.`);
                            setPhase('executing');
                        } else if (step.key === 'deposit-funds') {
                            addAgentMsg(`${skipMsg}🎉 **Step 6 (Funding) is complete!** Funds have been successfully deposited into the payroll vault.${proof}\n\nType **"go"** to move to **Step 7 (Initialize automation service)**.`);
                        } else if (step.key === 'create-worker-record') {
                            addAgentMsg(`${skipMsg}🎉 **Step 7 (Worker Record) created!** The worker can now open the **Worker Portal** and view their live earnings.${proof}\n\n*Worker view access and automation decrypt were automatically granted.*\n\nType **"go"** to continue with **Step 8 (Enable high-speed mode)**, or you're all set!`);
                        } else if (step.key === 'enable-high-speed') {
                            addAgentMsg(`${skipMsg}⚡ **Step 8 (High-speed mode) enabled!** Your payroll stream is now delegated to MagicBlock TEE for real-time salary accrual.${proof}\n\n🎉 **Setup is complete!** The worker can now open the **Worker Portal** at /employee to view their live earnings and request withdrawals.`);
                            setPhase('done');
                        } else if (step.key === 'create-depositor-token') {
                            addAgentMsg(`${skipMsg}✅ **Step 5 (Company source account) created!** ${proof}\n\n**How much payroll funds** do you want to deposit into the vault for Step 6? (e.g. type "10" or "fund 100")`);
                            setPhase('ask_funding');
                            return;
                        } else if (step.key === 'init-automation') {
                            addAgentMsg(`${skipMsg}✅ **Automation service initialized!**${proof}\n\nNow let's add a worker. 👷 Please paste the **worker's Solana wallet address** or say **"use my wallet"** to test with your own wallet.`);
                            setPhase('ask_wallet');
                        } else if (step.key === 'create-worker-token') {
                            addAgentMsg(`${skipMsg}✅ **Worker destination account created!**${proof}\n\nNow let's set up the pay plan. Here are your options:\n\n💰 **Hourly** — e.g. "pay 25 per hour" (great for contractors)\n💰 **Weekly** — e.g. "pay 500 per week" (standard for part-time)\n💰 **Monthly (30d)** — e.g. "pay 3000 per month" (standard salary)\n💰 **Fixed Total** — e.g. "pay 5000 over 30 days" (project-based)\n💰 **Per-second** — e.g. "pay 0.0001 per second" (advanced)\n\nJust tell me how you'd like to pay!`);
                            setPhase('ask_pay');
                        } else if (step.key === 'configure-worker-options') {
                            addAgentMsg(`${skipMsg}✅ **Pay plan configured!** Now let's set up your worker record preferences.\n\n👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`);
                            setOptionStep(0);
                            setPhase('ask_options');
                        } else {
                            addAgentMsg(`${skipMsg}✅ **Step Complete: ${step.label}**\nReasoning: ${step.detail || 'The operation was successful.'}${proof}\n\nType **"go"** to move to the next step, or ask me any questions.`);
                        }
                        if (step.key !== 'init-automation' && step.key !== 'create-worker-token' && step.key !== 'configure-worker-options') setPhase('executing');
                    }
                } catch (e: any) {
                    const msg = e?.message || 'Transaction rejected';
                    if (msg === 'ABORTED') return; // Silently ignore cancelled background promises
                    if (msg.includes('User rejected') || msg.includes('rejected the request') || msg.includes('cancelled')) {
                        addAgentMsg(`⏸️ Transaction was cancelled — no worries! Type **"go"** when you're ready to try again.`);
                    } else if (msg.includes('insufficient') || msg.includes('0x1') || msg.includes('not enough')) {
                        addAgentMsg(`💸 **Insufficient funds.** You may not have enough SOL for gas fees, or your vault balance is too low.\n\n• Check your SOL balance for transaction fees\n• Check your vault balance has enough payUSD\n\nFix the issue and type **"go"** to retry.`);
                    } else if (msg.includes('not found') || msg.includes('Account does not exist')) {
                        addAgentMsg(`🔍 **Account not found.** The payroll record may not exist yet, or the stream index might be wrong. Check Step 5's diagnostics panel for details.\n\nType **"go"** to retry or ask me for help.`);
                    } else {
                        addAgentMsg(`❌ **Step failed:** ${msg}\n\nYou can type **"go"** to retry, or ask me what happened.`);
                    }
                    setPhase('ask_setup');
                } finally {
                    setThinking(false);
                }
                return;
            }

            // ASK_OPTIONS: Conversational consent for worker record settings
            if (phase === 'ask_options') {
                const isYes = /\b(yes|yeah|yep|sure|ok|okay|yea|y|enable|on|allow|grant)\b/i.test(text);
                const isNo = /\b(no|nah|nope|n|skip|disable|off|deny|don't|dont)\b/i.test(text);

                if (!isYes && !isNo) {
                    // Conversational message — route to LLM, then re-ask current question
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
                    // Q1: Worker view access
                    setAutoGrantDecrypt?.(isYes);
                    addAgentMsg(
                        isYes
                            ? `✅ Got it — worker **will** be able to view their earnings.\n\n`
                            : `⬜ Understood — worker will **not** have automatic view access.\n\n`
                    );
                    addAgentMsg(`🤖 **Should the automation service be allowed to process confidential payouts automatically?**\n\n*(This enables the OnyxFii keeper to settle payments on your behalf)* (yes/no)`);
                    setOptionStep(1);
                    return;
                }

                if (optionStep === 1) {
                    // Q2: Automation/keeper access
                    setAutoGrantKeeperDecrypt?.(isYes);
                    addAgentMsg(
                        isYes
                            ? `✅ Got it — automation service **will** process payouts automatically.\n\n`
                            : `⬜ Understood — automation service will **not** have automatic access.\n\n`
                    );
                    addAgentMsg(`⏱️ **Should the payroll stop automatically at the end of this pay period?**\n\n*(If no, it will keep streaming until you manually pause or deactivate)* (yes/no)`);
                    setOptionStep(2);
                    return;
                }

                if (optionStep === 2) {
                    // Q3: Auto-stop at end of period
                    setBoundPresetPeriod?.(isYes);
                    addAgentMsg(
                        isYes
                            ? `✅ Got it — payroll **will** stop automatically at the end of the period.\n\n`
                            : `⬜ Understood — payroll will **stream continuously** until you stop it.\n\n`
                    );

                    // Move to confirm_plan
                    addAgentMsg(
                        `🎯 **All options configured!**\n\nType **"go"** to move to **Step 7 (Create worker payroll record)**, **"edit"** to change the pay plan, or **"edit options"** to change these settings.`
                    );
                    setPhase('confirm_plan');
                    return;
                }
            }

            // CONFIRM_PLAN: "edit" goes back, "go" is handled above
            // Also detect if user provides a new amount/plan directly (e.g. "amount is 500", "500", "500 per month")
            if (phase === 'confirm_plan') {
                const hasNumber = /\d/.test(text);
                const isEditKeyword = /\b(edit|change|no|update|modify)\b/i.test(text);
                const isExecuteKeyword = /\b(?:go|continue|yes|execute|start)\b/i.test(text);
                const isOptionsKeyword = /\b(option|options|settings|permissions|access|auto.?stop)\b/i.test(text);

                // If user wants to change options, restart the ask_options flow
                if (isOptionsKeyword) {
                    addAgentMsg(
                        `No problem! Let's go through the options again.\n\n` +
                        `👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`
                    );
                    setOptionStep(0);
                    setPhase('ask_options');
                    return;
                }

                // If user confirms the plan with "go", manually advance to executing
                if (isExecuteKeyword && !isEditKeyword && !hasNumber) {
                    setPhase('executing');
                    setThinking(true);
                    addAgentMsg(`🚀 **Executing payout setup...**\n\n*Please approve the transactions in your wallet to proceed...*`);
                    // Call the exact same execution logic as the main handler
                    onExecutePlan('next').then(step => {
                        if (!step) {
                            addAgentMsg(`✅ **All steps completed successfully!** Your payroll setup is now live and fully operational.`);
                            setPhase('done');
                        } else if (step.status === 'done') {
                            const currentIdx = executionSteps.findIndex(s => s.key === step.key);
                            const skippedCount = executionSteps.slice(0, currentIdx).filter(s => s.status === 'done').length;
                            const skipMsg = skippedCount > 0 ? `*(I verified ${skippedCount} previous steps are already complete on-chain, skipping those)*\n\n` : '';
                            const proof = step.txid ? `\n\n**🔗 Transaction Proof:**\n[View on Solscan](https://solscan.io/tx/${step.txid}?cluster=devnet)` : '';
                            if (step.key === 'configure-worker-options') {
                                addAgentMsg(`✅ **Pay plan configured!** Now let's set up your worker record preferences.\n\n👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`);
                                setOptionStep(0);
                                setPhase('ask_options');
                            } else {
                                addAgentMsg(`${skipMsg}✅ **Step Complete: ${step.label}**\nReasoning: ${step.detail || 'The operation was successful.'}${proof}\n\nType **"go"** to move to the next step, or ask me any questions.`);
                                setPhase('executing');
                            }
                        }
                    }).catch(e => {
                        const msg = e?.message || 'Transaction rejected';
                        if (msg === 'ABORTED') return; // Silently ignore cancelled background promises
                        addAgentMsg(`❌ **Step failed:** ${msg}\n\nYou can type **"go"** to retry, or ask me what happened.`);
                        setPhase('ask_setup');
                    }).finally(() => {
                        setThinking(false);
                    });
                    return;
                }

                // If the message contains a number OR an edit keyword, treat as plan modification
                if (hasNumber || isEditKeyword) {
                    // BARE NUMBER: If user just typed a number (e.g. "500", "amount is 500"),
                    // update the pending plan's amount directly without calling the API
                    const bareNumberMatch = text.match(/(\d+\.?\d*)/);
                    const isBareNumber = bareNumberMatch && text.replace(/[^a-zA-Z]/g, '').length < 15;

                    if (isBareNumber && pendingPlan && bareNumberMatch) {
                        const newAmount = bareNumberMatch[1];
                        const updatedPlan = { ...pendingPlan, payAmount: newAmount, intent: 'create_stream' };
                        setPendingPlan(updatedPlan);
                        onApplyPlan(updatedPlan);
                        const details: string[] = [];
                        if (updatedPlan.payPreset) details.push(`Pay type: **${updatedPlan.payPreset.replace('_', ' ')}**`);
                        details.push(`Amount: **${newAmount}**`);
                        if (updatedPlan.fixedTotalDays) details.push(`Duration: **${updatedPlan.fixedTotalDays} days**`);
                        addAgentMsg(
                            `✅ **Pay plan updated!**\n\n` +
                            details.join('\n') +
                            `\n\nType **"go"** to create the worker payroll record, or tell me a different amount.`
                        );
                        setPhase('confirm_plan');
                        return;
                    }

                    setThinking(true);
                    try {
                        // Try to parse the new input as a pay plan
                        const plan = await onDraftPlan(text, {});
                        if (plan && (plan.payPreset || plan.salaryPerSecond || plan.payAmount)) {
                            setPendingPlan(plan);
                            onApplyPlan(plan);
                            const details: string[] = [];
                            if (plan.payPreset) details.push(`Pay type: **${plan.payPreset.replace('_', ' ')}**`);
                            if (plan.payAmount) details.push(`Amount: **${plan.payAmount}**`);
                            if (plan.fixedTotalDays) details.push(`Duration: **${plan.fixedTotalDays} days**`);
                            if (plan.salaryPerSecond) details.push(`Rate: **${plan.salaryPerSecond}/sec**`);
                            addAgentMsg(
                                `✅ **Pay plan updated!**\n\n` +
                                details.join('\n') +
                                `\n\nType **"go"** to create the worker payroll record, or tell me a different amount.`
                            );
                            setPhase('confirm_plan');
                        } else if (isEditKeyword && !hasNumber) {
                            // Just said "edit" without a new value
                            addAgentMsg(`Sure! Tell me the new pay plan, e.g.:\n• "500 per month"\n• "25 per hour"\n• "5000 over 30 days"`);
                            setPhase('ask_pay');
                        } else {
                            addAgentMsg(`I couldn't parse that. Try something like:\n• "500 per month"\n• "25 per hour"\n• "5000 over 30 days"`);
                        }
                    } catch {
                        addAgentMsg(`I couldn't parse that. Try: "500 per month" or "25 per hour"`);
                    } finally {
                        setThinking(false);
                    }
                    return;
                }
                // User said something conversational — route to LLM, then remind about next step
                setThinking(true);
                try {
                    const { reply } = await askGrok(text);
                    const nextStep = executionSteps.find(s => s.status !== 'done');
                    const nextStepHint = nextStep
                        ? `\n\n📋 **Next step:** ${nextStep.label}\nType **"go"** to proceed, **"edit"** to change the pay plan, or **"edit options"** to change settings.`
                        : `\n\nType **"go"** to execute, or **"edit"** to change the pay plan.`;
                    addAgentMsg(reply + nextStepHint);
                } catch {
                    addAgentMsg(`I'm sorry, I had trouble understanding. Type **"go"** to execute, or **"help"** for all commands.`);
                } finally {
                    setThinking(false);
                }
                return;
            }

            // ASK_PAY: Try to parse as payroll instruction first
            if (phase === 'ask_pay') {
                setThinking(true);
                try {
                    const plan = await onDraftPlan(text, {});
                    if (plan && (plan.payPreset || plan.salaryPerSecond || plan.payAmount)) {
                        setPendingPlan(plan);
                        onApplyPlan(plan);

                        const details: string[] = [];
                        if (plan.payPreset) details.push(`Pay type: **${plan.payPreset.replace('_', ' ')}**`);
                        if (plan.payAmount) details.push(`Amount: **${plan.payAmount}**`);
                        if (plan.fixedTotalDays) details.push(`Duration: **${plan.fixedTotalDays} days**`);
                        if (plan.salaryPerSecond) details.push(`Rate: **${plan.salaryPerSecond}/sec**`);

                        addAgentMsg(
                            `✅ **Pay plan configured!**\n\n` +
                            details.join('\n') +
                            `\n\nType **"go"** to create the worker payroll record, or tell me a different amount.`
                        );
                        setPhase('confirm_plan');
                        return;
                    }
                    // If plan parsing failed, show helpful message and stay in ask_pay
                    addAgentMsg(`🤔 I couldn't parse that as a pay plan. Try something like:\n\n• "50 per hour"\n• "4000 per month"\n• "5000 over 30 days"\n• "0.001 per second"`);
                    return;
                } catch {
                    addAgentMsg(`🤔 I couldn't understand that. Try: "pay 100 per hour" or "5000 per month"`);
                    return;
                } finally {
                    setThinking(false);
                }
            }

            // HELP COMMAND: If user types "help", show capabilities
            if (text.toLowerCase().trim() === 'help') {
                addAgentMsg(
                    `📋 **OnyxFii Agent — What I Can Do:**\n\n` +
                    `**Setup Commands:**\n` +
                    `• "go" / "start" — Begin or continue setup\n` +
                    `• Paste a wallet address — Set worker wallet\n` +
                    `• "pay 100 per month" — Set pay plan\n` +
                    `• "deposit 500" — Add funds to vault\n\n` +
                    `**Pay Plan Formats:**\n` +
                    `• "50 per hour" / "4000 per month" / "60k per year"\n` +
                    `• "200 per day" / "1000 bi-weekly"\n` +
                    `• "5000 over 30 days" / "0.001 per second"\n\n` +
                    `**Post-Setup Commands:**\n` +
                    `• "pause" / "resume" — Pause or resume payroll\n` +
                    `• "give a $500 bonus" — One-time bonus\n` +
                    `• "raise to 0.0002/sec" — Update salary rate\n` +
                    `• "what's my status?" — Show full status summary\n` +
                    `• "deactivate" — Permanently remove a stream\n\n` +
                    `**Other:**\n` +
                    `• "fix mint" — Fix vault mint mismatch\n` +
                    `• "recover funds" — Withdraw from vault`
                );
                return;
            }

            // WALLET DETECTION: If user pastes a wallet address in any phase, capture it
            const trimmedText = text.replace(/\s+/g, ' ').trim();
            const walletMatch = trimmedText.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
            if (walletMatch && walletMatch[0].length >= 32 && walletMatch[0].length <= 44 && phase !== 'executing') {
                onApplyPlan({ employeeWallet: walletMatch[0] });
                addAgentMsg(
                    `Got it! Worker wallet: \`${walletMatch[0].slice(0, 6)}...${walletMatch[0].slice(-4)}\`\n\n` +
                    `Now, how much do you want to pay them? You can say things like:\n` +
                    `• "50 per hour"\n` +
                    `• "4000 per month" / "60k per year"\n` +
                    `• "5000 total over 30 days"\n` +
                    `• "0.001 per second"`
                );
                setPhase('ask_pay');
                return;
            }
            // ---- PAY PLAN DETECTION (any phase) ----
            // If user types "pay X per hour/month/week" or "X per month" etc., route to onDraftPlan
            const isPayPlanMessage = /\b(\d+\.?\d*)\s*(per\s+(second|hour|day|week|month|year)|over\s+\d+\s*days?)\b/i.test(text) ||
                /\bpay\s+\d/i.test(text);
            if (isPayPlanMessage) {
                setThinking(true);
                try {
                    const plan = await onDraftPlan(text, {});
                    if (plan && (plan.payPreset || plan.salaryPerSecond || plan.payAmount)) {
                        setPendingPlan(plan);
                        onApplyPlan(plan);

                        const details: string[] = [];
                        if (plan.payPreset) details.push(`Pay type: **${plan.payPreset.replace('_', ' ')}**`);
                        if (plan.payAmount) details.push(`Amount: **${plan.payAmount}**`);
                        if (plan.fixedTotalDays) details.push(`Duration: **${plan.fixedTotalDays} days**`);
                        if (plan.salaryPerSecond) details.push(`Rate: **${plan.salaryPerSecond}/sec**`);

                        addAgentMsg(
                            `✅ **Pay plan configured!**\n\n` +
                            details.join('\n') +
                            `\n\nBefore we proceed, I need to confirm a few options with you.\n\n` +
                            `👁️ **Would you like the worker to be able to view their earnings automatically?** (yes/no)`
                        );
                        setOptionStep(0);
                        setPhase('ask_options');
                        return;
                    }
                } catch {
                    // Fall through to LLM
                } finally {
                    setThinking(false);
                }
            }

            // ---- GROK-POWERED CONVERSATION (everything else) ----
            setThinking(true);
            try {
                const { reply, action } = await askGrok(text);
                addAgentMsg(reply);

                // Process LLM action commands
                if (action) {
                    if (action.type === 'set_phase' && action.phase) {
                        setPhase(action.phase);
                    } else if (action.type === 'apply_plan' && action.plan) {
                        onApplyPlan(action.plan);
                        if (action.plan.fixVaultMint) {
                            // LLM detected user wants to fix vault mint — set intent and move to executing
                            onApplyPlan({ intent: 'fix_vault_mint' } as any);
                            setPhase('executing');
                        } else if (action.plan.recoverFunds) {
                            // LLM detected user wants to recover vault funds
                            onApplyPlan({ intent: 'recover_funds' } as any);
                            if (action.plan.recoverAmount) {
                                onApplyPlan({ recoverAmount: action.plan.recoverAmount } as any);
                            }
                            setPhase('executing');
                        } else if (action.plan.intent && ['pause_stream', 'resume_stream', 'update_stream', 'deactivate_stream', 'grant_access'].includes(action.plan.intent)) {
                            // Post-setup operations: pause, resume, raise, bonus, deactivate, grant access
                            onApplyPlan({ intent: action.plan.intent } as any);
                            setPhase('executing');
                        } else if (action.plan.employeeWallet) {
                            setPhase('ask_pay');
                        }
                    }
                }
            } catch {
                addAgentMsg(`I'm sorry, I encountered an issue. Please try again.`);
            } finally {
                setThinking(false);
            }
        } catch {
            // Outer handler exception
            addAgentMsg('Sorry, something went wrong processing your request.');
        } finally {
            isSending.current = false;
        }
    }, [
        input,
        thinking,
        busy,
        ready,
        hydrated,
        phase,
        pendingPlan,
        businessExists,
        vaultExists,
        configExists,
        addAgentMsg,
        addUserMsg,
        askGrok,
        executionSteps,
        onDraftPlan,
        onExecutePlan,
        onApplyPlan,
        setInput,
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

                {(phase === 'executing' || phase === 'confirm_plan' || phase === 'ask_options' || phase === 'ask_setup' || phase === 'ask_wallet') && executionSteps.length > 0 && (
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
                {(busy || phase === 'executing' || phase === 'ask_funding') && (
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
                )}
                <button
                    id="agent-send-btn"
                    onClick={() => void handleSend()}
                    disabled={!walletConnected || !input.trim() || (thinking && phase !== 'executing') || !ready || !hydrated}
                    className="agent-chat-send"
                >
                    {(busy || phase === 'executing') ? 'Retry' : 'Send'}
                </button>
            </div>
        </section>
    );
}
