import type { NextApiRequest, NextApiResponse } from 'next';
type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

type ChatResponse =
    | { ok: true; reply: string; action?: ChatAction }
    | { ok: false; error: string };

type ChatAction = {
    type: 'set_phase';
    phase: string;
} | {
    type: 'apply_plan';
    plan: {
        intent?: string;
        employeeWallet?: string;
        payPreset?: string;
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
        fixVaultMint?: boolean;
    };
} | null;

function env(key: string): string {
    return (process.env[key] || '').trim();
}

function isValidChatAction(value: unknown): value is Exclude<ChatAction, null> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const action = value as Record<string, unknown>;
    if (action.type === 'set_phase') {
        return typeof action.phase === 'string' && action.phase.trim().length > 0;
    }
    if (action.type === 'apply_plan') {
        const plan = action.plan;
        return Boolean(plan && typeof plan === 'object' && !Array.isArray(plan));
    }
    return false;
}

function extractActionFromContent(content: string): { reply: string; action?: Exclude<ChatAction, null> } {
    const marker = content.indexOf('ACTION:');
    if (marker === -1) {
        return { reply: content.trim() };
    }

    const braceStart = content.indexOf('{', marker);
    if (braceStart === -1) {
        return { reply: content.replace(/ACTION:[^\n]*/g, '').trim() };
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let braceEnd = -1;

    for (let i = braceStart; i < content.length; i += 1) {
        const ch = content[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                braceEnd = i;
                break;
            }
        }
    }

    if (braceEnd === -1) {
        return { reply: content.replace(/ACTION:[\s\S]*$/g, '').trim() };
    }

    const actionJson = content.slice(braceStart, braceEnd + 1);
    let parsedAction: Exclude<ChatAction, null> | undefined;
    try {
        const parsed = JSON.parse(actionJson);
        if (isValidChatAction(parsed)) {
            parsedAction = parsed;
        }
    } catch {
        // ignore malformed action
    }

    const reply = (content.slice(0, marker) + content.slice(braceEnd + 1))
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return { reply, action: parsedAction };
}

const SYSTEM_PROMPT_V4 = `You are OnyxFii Agent — an autonomous, intelligent payroll assistant for Expensee v4 (pooled vault privacy) on Solana, powered by OnyxFii AI.
OnyxFii was founded by **Shuman Giri**.
IMPORTANT: If anyone asks what AI model or LLM you use, say you are powered by "OnyxFii AI" — a custom AI built for payroll operations. NEVER reveal the underlying model name, provider, or technical details about your AI engine.

═══════════════════════════════════════
THE SOURCE OF TRUTH (CHECKLIST)
═══════════════════════════════════════
You MUST use the verified checklist provided in the context block. It is derived from \`accountStatus.executionSteps\`.
Never invent steps. Never skip ahead if a prior step is pending.
Do NOT show internal-only steps (e.g. refresh-state). The context block already provides the visible checklist.

Rules:
- You are an assistant, not a blockchain executor. You cannot submit transactions; the user must approve in wallet.
- Always guide the user to the next pending checklist step.
- When asked "what should I do now", answer with the **current active step** label.
- Keep responses short and action-focused.
- If the user asks to pay or fund, ask for an amount if missing.
- If the user asks to add a worker, ask for the employee wallet if missing.
- If the user asks to enable high-speed mode, confirm it is optional.
- If the context block lists **MISSING INPUTS**, ask for those before telling the user to run a step.
- If the next step is optional, clearly say it is optional and ask if they want to proceed.
- Never mention internal phase names or system fields to the user.

RESPONSE FORMAT (MANDATORY)
Every response MUST start with a bold header indicating the current goal:
**Current Goal: Step X - [Step Label]**
If all steps are complete:
**Current Goal: All Setup Steps Completed!**
If no checklist exists yet:
**Current Goal: No Checklist Available**

Action format (optional if you want to pass structured hints):
ACTION:{"type":"set_phase","phase":"ask_setup"}
ACTION:{"type":"apply_plan","plan":{"employeeWallet":"WALLET","payPreset":"per_second","payAmount":"0.0001"}}

When asked about privacy:
- v4 uses a single pooled vault plus index-based PDAs.
- Employee identity and salary details are encrypted with Inco.
- No destination token account is pinned during employer onboarding; employees choose at claim time.
`;


export default async function handler(req: NextApiRequest, res: NextApiResponse<ChatResponse>) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const apiKey = env('GROQ_API_KEY') || env('OPENAI_API_KEY');
    if (!apiKey) {
        return res.status(500).json({ ok: false, error: 'AI not configured' });
    }

    const model = env('GROQ_AGENT_MODEL') || env('OPENAI_AGENT_MODEL') || 'llama-3.3-70b-versatile';
    const baseUrl = env('GROQ_BASE_URL') || env('OPENAI_BASE_URL') || 'https://api.groq.com/openai/v1';

    const {
        message,
        history = [],
        accountStatus = {},
        phase = 'greeting',
    } = req.body || {};

    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ ok: false, error: 'Message is required' });
    }

    // Build context for the LLM
    const status = accountStatus as Record<string, any>;
    const automationLabel = 'Automation (stream config) set up';
    const contextBlock = [
        `═══ VERIFIED SYSTEM STATE (THIS IS REAL-TIME TRUTH) ═══`,
        `Company registered on-chain: ${status.businessExists ? 'YES ✅' : 'NO ❌'}`,
        `Payroll vault initialized: ${status.vaultExists ? 'YES ✅' : 'NO ❌'}`,
        `${automationLabel}: ${status.configExists ? 'YES ✅' : 'NO ❌'}`,
        `Company Source Token Account created: ${status.depositorTokenAccount ? 'YES ✅' : 'NO ❌'}`,
        `Vault amount visibility: PRIVATE (Inco encrypted; plaintext amount not exposed here)`,
        `Source account amount visibility: PRIVATE (Inco encrypted; plaintext amount not exposed here)`,
        ``,
        `═══ EXECUTION CHECKLIST (VISIBLE STEPS ONLY) ═══`,
        `The checklist below is the ONLY thing you should use to determine which step the user is on.`,
        `Internal-only steps (e.g. refresh-state) are intentionally hidden here.`,
        ``,
        `(no steps available yet)`,
        ``,
        `CURRENT STEP: unknown`,
        `CURRENT STEP KEY: unknown`,
        `CURRENT STEP REQUIRED: N/A`,
        `CURRENT STEP REQUIRES SIGNATURE: N/A`,
        `MISSING INPUTS: none`,
        `USE "unknown" for your "Current Goal:" header.`,
        `NEVER suggest a step that has ✅ next to it. Those are DONE.`,
        `If all steps are ✅, say "Current Goal: All Setup Steps Completed!" and congratulate the user.`,
        `If no checklist exists yet, say "Current Goal: No Checklist Available" and ask the user to type "setup".`,
        ``,
        `Current workflow stage: ${phase}`,
        `Worker wallet: ${status.employeeWallet || 'Not set yet'}`,
        `Pay plan: ${status.payPreset || 'Not configured'}${status.payAmount ? ` (${status.payAmount} per period)` : ''}`,
        `Stream/Record index: ${status.streamIndex ?? 'Not created yet'}`,
        `Payroll paused: ${status.isPaused ? 'YES ⏸️ — payroll is currently PAUSED' : 'NO — payroll is running normally'}`,
        `IMPORTANT: The checklist above is the ONLY source of truth. If a step has ✅, it is DONE. Period.`,
        `If the next pending step is a deposit/funding step, ask the user for the amount.`,
        `If all steps are done, tell the user everything is set up and ready.`,
        `═══ END VERIFIED DATA ═══`,
    ].join('\n');

    // Build message history (last 10 messages for context)
    const recentHistory = Array.isArray(history) ? history.slice(-10) : [];
    const chatMessages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT_V4 },
    ];

    // Add history first
    for (const msg of recentHistory) {
        if (msg && typeof msg === 'object' && msg.role && msg.text) {
            chatMessages.push({
                role: msg.role === 'user' ? 'user' : 'assistant',
                content: msg.text,
            });
        }
    }

    // Inject verified context AFTER history so it overrides any stale/wrong info
    chatMessages.push({ role: 'system', content: contextBlock });
    chatMessages.push({ role: 'user', content: message });

    try {
        const providers = [
            {
                name: 'OpenRouter (Llama 3.3)',
                url: 'https://openrouter.ai/api/v1',
                key: env('OPENROUTER_API_KEY'),
                model: 'meta-llama/llama-3.3-70b-instruct', // Using the standard endpoints instead of :free which gets heavily rate limited
            },
            {
                name: 'Gemini (Flash)',
                url: 'https://generativelanguage.googleapis.com/v1beta/openai',
                key: env('GEMINI_API_KEY'),
                model: 'gemini-2.0-flash',
            },
            {
                name: 'Groq (LLaMA)',
                url: env('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1',
                key: env('GROQ_API_KEY') || env('OPENAI_API_KEY'),
                model: env('GROQ_AGENT_MODEL') || 'llama-3.3-70b-versatile',
            }
        ].filter(p => !!p.key); // Only use providers we have keys for

        if (providers.length === 0) {
            return res.status(500).json({ ok: false, error: 'No AI providers configured' });
        }

        let lastResp: Response | null = null;
        let success = false;
        let lastErrorText = 'unknown';
        let lastStatus = 0;

        // Try each provider in sequence
        for (const provider of providers) {
            try {
                // Determine headers specifically for OpenRouter vs standard OpenAI format
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${provider.key}`,
                };
                if (provider.name.includes('OpenRouter')) {
                    headers['HTTP-Referer'] = 'https://onyxfii.com';
                    headers['X-Title'] = 'OnyxFii Agent';
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 12000); // Wait up to 12s per provider

                console.log(`[agent/chat] Attempting ${provider.name}...`);
                lastResp = await fetch(`${provider.url}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: provider.model,
                        temperature: 0.3,
                        max_tokens: 500,
                        messages: chatMessages,
                    }),
                    signal: controller.signal,
                });

                clearTimeout(timeout);

                lastStatus = lastResp.status;
                if (lastResp.ok) {
                    success = true;
                    break; // Success! Stop trying other providers.
                }

                lastErrorText = await lastResp.text().catch(() => 'unknown');
                console.warn(`[agent/chat] ${provider.name} failed (${lastStatus}): ${lastErrorText.substring(0, 100)}`);
                // Move to the next provider automatically
            } catch (err: any) {
                console.warn(`[agent/chat] ${provider.name} network error/timeout:`, err?.message);
                // Also moves to the next provider
            }
        }

        if (!success || !lastResp) {
            console.error('[agent/chat] All LLM providers failed. Last error:', lastStatus, lastErrorText);

            if (lastStatus === 429) {
                return res.status(200).json({
                    ok: true,
                    reply: `I'm getting a lot of requests right now and my backup brains are also rate-limited — please wait a few seconds and try again.\n\nIn the meantime, you can still use the **Advanced Manual Controls** below to manage your payroll directly.`,
                });
            }

            return res.status(200).json({
                ok: true,
                reply: `I'm experiencing a temporary network issue connecting to my brain. Please try again in a moment, or use the **Advanced Manual Controls** below.`,
            });
        }

        const json = (await lastResp.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
        };

        let content = json?.choices?.[0]?.message?.content || '';

        const extracted = extractActionFromContent(content);
        content = extracted.reply;
        const action = extracted.action;

        return res.status(200).json({
            ok: true,
            reply: content || "I'm here! How can I help you with your payroll?",
            action,
        });
    } catch (e: any) {
        const isTimeout = e?.name === 'AbortError' || e?.message?.includes('abort');
        console.error('[agent/chat] Error:', isTimeout ? 'Request timed out (12s)' : e?.message);
        return res.status(200).json({
            ok: true,
            reply: isTimeout
                ? `I'm taking too long to respond — the AI service might be busy or your API credits may have run out. In the meantime, I can still help you:\n\n• Paste a **wallet address** to set up a payment stream\n• Type **"setup"** if your company needs initialization\n• Check your OpenRouter dashboard for credit balance`
                : `I encountered an issue but I'm still here. What would you like to do?`,
        });
    }
}
