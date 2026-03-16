import type { NextApiRequest, NextApiResponse } from 'next';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import {
  KeypairWallet,
  SolanaAgentKit,
  executeAction,
  type Action as ToolkitAction,
  type Plugin,
} from 'solana-agent-kit';

type PayPreset = 'per_second' | 'hourly' | 'weekly' | 'monthly' | 'fixed_total';
type AgentIntent =
  | 'create_stream'
  | 'update_stream'
  | 'pause_stream'
  | 'resume_stream'
  | 'deactivate_stream'
  | 'grant_access'
  | 'unknown';

type AgentPlan = {
  source: 'heuristic' | 'llm' | 'toolkit';
  intent: AgentIntent;
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
  streamIndex?: number;
  bonusAmount?: string;
  depositAmount?: string;
};

type AgentPlanOk = {
  ok: true;
  plan: AgentPlan;
};

type AgentPlanErr = {
  ok: false;
  error: string;
};

type CurrentFormState = {
  employeeWallet?: string;
  payPreset?: PayPreset;
  payAmount?: string;
  fixedTotalDays?: string;
  salaryPerSecond?: string;
  boundPresetPeriod?: boolean;
  depositAmount?: string;
};

type PlannerInput = {
  instruction: string;
  current: CurrentFormState;
};

const PAY_PRESETS: ReadonlySet<string> = new Set([
  'per_second',
  'hourly',
  'weekly',
  'monthly',
  'fixed_total',
]);

const TOOLKIT_ACTION_NAME = 'draft_payroll_plan';
const TOOLKIT_RPC_URL =
  process.env.RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  process.env.KEEPER_READ_RPC_URL ||
  'https://api.devnet.solana.com';

let cachedToolkitAgent: SolanaAgentKit | null = null;
let cachedToolkitAction: ToolkitAction | null = null;

function toTrimmedString(v: unknown): string {
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

function toPayPreset(v: unknown): PayPreset | undefined {
  if (typeof v !== 'string') return undefined;
  const next = v.trim();
  return PAY_PRESETS.has(next) ? (next as PayPreset) : undefined;
}

function formatNumber(n: number, decimals = 9): string {
  const fixed = n.toFixed(decimals);
  return fixed.replace(/\.?0+$/, '');
}

function parsePositive(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function unitToDays(value: number, unit: string): number {
  if (unit.startsWith('week')) return value * 7;
  if (unit.startsWith('month')) return value * 30;
  return value;
}

function findWalletCandidate(text: string): string | undefined {
  const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const filtered = matches.filter((m) => m !== '11111111111111111111111111111111');
  return filtered[0];
}

function buildHeuristicPlan(input: PlannerInput): AgentPlan {
  let text = input.instruction;

  // Normalize: strip dollar signs and commas (e.g. "$1,000" → "1000")
  text = text.replace(/\$/g, '').replace(/,/g, '');

  // Normalize: expand K/M shorthand (e.g. "60k" → "60000", "1.5m" → "1500000")
  text = text.replace(/(\d+(?:\.\d+)?)\s*[kK]\b/g, (_, n) => String(Number(n) * 1000));
  text = text.replace(/(\d+(?:\.\d+)?)\s*[mM]\b/g, (_, n) => String(Number(n) * 1000000));

  const lower = text.toLowerCase();
  const missing: string[] = [];

  const plan: AgentPlan = {
    source: 'heuristic',
    intent: 'create_stream', // Default
    summary: 'Drafted plan from your message.',
    confidence: 0.45,
    missing,
    boundPresetPeriod: true,
    autoGrantDecrypt: false,
  };

  // Detect basic intent keywords
  if (lower.includes('pause') || lower.includes('stop')) {
    plan.intent = 'pause_stream';
    plan.summary = 'Intent to pause existing stream detected.';
  } else if (lower.includes('resume') || lower.includes('start again') || lower.includes('unpause')) {
    plan.intent = 'resume_stream';
    plan.summary = 'Intent to resume existing stream detected.';
  } else if (lower.includes('deactivate') || lower.includes('remove') || lower.includes('delete')) {
    plan.intent = 'deactivate_stream';
    plan.summary = 'Intent to deactivate stream detected.';
  } else if (lower.includes('grant') || lower.includes('allow') || lower.includes('access')) {
    plan.intent = 'grant_access';
    plan.summary = 'Intent to grant access detected.';
  } else if (lower.includes('bonus') || lower.includes('raise') || lower.includes('increase')) {
    plan.intent = 'update_stream';
    plan.summary = 'Intent to update stream (raise/bonus) detected.';
  } else if (lower.includes('deposit') || lower.includes('fund') || lower.includes('add money') || lower.includes('add fund')) {
    plan.intent = 'create_stream'; // Using create_stream as base for setup-related tasks
    plan.summary = 'Intent to deposit funds detected.';
  }

  // Detect stream index if present
  const indexMatch = text.match(/(?:stream|record|#)\s*(\d+)/i);
  if (indexMatch) {
    plan.streamIndex = parseInt(indexMatch[1]);
  }

  // Detect bonus amount
  const bonusMatch = lower.match(/(?:bonus|tip|extra)\s*(?:\$|of\s*)?(\d+(?:\.\d+)?)/i);
  if (bonusMatch) {
    plan.bonusAmount = bonusMatch[1];
  }

  const wallet = findWalletCandidate(text);
  if (wallet) {
    plan.employeeWallet = wallet;
    plan.confidence += 0.2;
  } else if (!input.current.employeeWallet) {
    missing.push('worker wallet');
  }

  // Example: "pay 5000 for 30 days"
  const fixedTotalMatch = lower.match(
    /(?:pay|set|stream|budget)?[^0-9]{0,30}(\d+(?:\.\d+)?)\s*(?:usdc|usd|token|payusd|cusdc|cusdc-like)?\s*(?:total\s*)?(?:for|over)\s*(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)\b/
  );
  if (fixedTotalMatch) {
    const amount = Number(fixedTotalMatch[1]);
    const periodValue = Number(fixedTotalMatch[2]);
    const unit = fixedTotalMatch[3];
    if (Number.isFinite(amount) && Number.isFinite(periodValue)) {
      plan.payPreset = 'fixed_total';
      plan.payAmount = formatNumber(amount, 6);
      plan.fixedTotalDays = String(Math.max(1, Math.round(unitToDays(periodValue, unit))));
      plan.confidence += 0.35;
      plan.summary = `Fixed total ${plan.payAmount} over ${plan.fixedTotalDays} days.`;
    }
  }

  // Example: "pay 25 per hour", "30/hr", "0.0001 per sec", "200/day", "60000/year", "1000 bi-weekly"
  if (!plan.payPreset) {
    // Check for bi-weekly / fortnightly first (special two-word pattern)
    const biWeeklyMatch = lower.match(
      /(\d+(?:\.\d+)?)\s*(?:usdc|usd|token|payusd)?\s*(?:\/|\s*per\s+)?(?:bi[- ]?weekly|biweekly|fortnightly|every\s*(?:two|2)\s*weeks?)\b/
    );
    if (biWeeklyMatch) {
      const amount = Number(biWeeklyMatch[1]);
      if (Number.isFinite(amount) && amount > 0) {
        // Convert bi-weekly to weekly (÷ 2)
        const weeklyAmount = amount / 2;
        plan.payPreset = 'weekly';
        plan.payAmount = formatNumber(weeklyAmount, 6);
        plan.boundPresetPeriod = true;
        plan.summary = `Bi-weekly pay $${formatNumber(amount, 2)} converted to weekly: ${plan.payAmount}/week.`;
        plan.confidence += 0.35;
      }
    }
  }
  if (!plan.payPreset) {
    const rateMatch = lower.match(
      /(\d+(?:\.\d+)?)\s*(?:usdc|usd|token|payusd|cusdc|c?usdc-like)?\s*(?:\/|\s*per\s+)(second|sec|hour|hr|weekly|week|monthly|month|hourly|day|daily|year|yearly|annual|annually)\b/
    );
    if (rateMatch) {
      const amount = Number(rateMatch[1]);
      const unit = rateMatch[2];
      if (Number.isFinite(amount)) {
        if (unit === 'second' || unit === 'sec') {
          plan.payPreset = 'per_second';
          plan.salaryPerSecond = formatNumber(amount, 9);
          plan.summary = `Per-second pay set to ${plan.salaryPerSecond}.`;
        } else if (unit === 'hour' || unit === 'hr' || unit === 'hourly') {
          plan.payPreset = 'hourly';
          plan.payAmount = formatNumber(amount, 6);
          plan.boundPresetPeriod = true;
          plan.summary = `Hourly pay set to ${plan.payAmount}.`;
        } else if (unit === 'day' || unit === 'daily') {
          // Convert daily to fixed_total over 1 day
          plan.payPreset = 'fixed_total';
          plan.payAmount = formatNumber(amount, 6);
          plan.fixedTotalDays = '1';
          plan.boundPresetPeriod = true;
          plan.summary = `Daily pay set to ${plan.payAmount} (fixed total over 1 day).`;
        } else if (unit === 'week' || unit === 'weekly') {
          plan.payPreset = 'weekly';
          plan.payAmount = formatNumber(amount, 6);
          plan.boundPresetPeriod = true;
          plan.summary = `Weekly pay set to ${plan.payAmount}.`;
        } else if (unit === 'year' || unit === 'yearly' || unit === 'annual' || unit === 'annually') {
          // Convert yearly to monthly (÷ 12)
          const monthlyAmount = amount / 12;
          plan.payPreset = 'monthly';
          plan.payAmount = formatNumber(monthlyAmount, 6);
          plan.boundPresetPeriod = true;
          plan.summary = `Yearly salary $${formatNumber(amount, 2)} converted to monthly: ${plan.payAmount}/month.`;
        } else {
          plan.payPreset = 'monthly';
          plan.payAmount = formatNumber(amount, 6);
          plan.boundPresetPeriod = true;
          plan.summary = `Monthly pay set to ${plan.payAmount}.`;
        }
        plan.confidence += 0.35;
      }
    }
  }

  // Validate: reject zero or negative pay amounts
  if (plan.payAmount && Number(plan.payAmount) <= 0) {
    plan.payAmount = undefined;
    plan.payPreset = undefined;
    plan.summary = 'Invalid amount: pay must be greater than zero.';
    plan.confidence = 0.1;
  }
  if (plan.salaryPerSecond && Number(plan.salaryPerSecond) <= 0) {
    plan.salaryPerSecond = undefined;
    plan.payPreset = undefined;
    plan.summary = 'Invalid amount: salary rate must be greater than zero.';
    plan.confidence = 0.1;
  }

  // Example: "for 2 weeks" (applies to hourly/weekly/monthly)
  if (plan.payPreset && plan.payPreset !== 'fixed_total') {
    const durationMatch = lower.match(/for\s+(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months)\b/);
    if (durationMatch) {
      const value = Number(durationMatch[1]);
      const unit = durationMatch[2];
      if (Number.isFinite(value)) {
        const days = Math.max(1, Math.round(unitToDays(value, unit)));
        plan.fixedTotalDays = String(days);
        plan.boundPresetPeriod = true;
        plan.confidence += 0.05;
      }
    }
  }

  // Detect deposit amount (e.g. "deposit 100", "fund with 50")
  const fundMatch = lower.match(/(?:deposit|fund|add)\s*(?:with|amount\s*of)?\s*(?:\$|payusd|usdc)?\s*(\d+(?:\.\d+)?)/i);
  if (fundMatch) {
    plan.depositAmount = fundMatch[1];
    plan.summary = `Funding amount set to ${plan.depositAmount}.`;
    plan.confidence += 0.2;
  }

  if (!plan.payPreset && input.current.payPreset) {
    plan.payPreset = input.current.payPreset;
    plan.summary = `${plan.summary} Kept existing pay type (${input.current.payPreset}).`;
  }

  if (!plan.payPreset && !input.current.payPreset) missing.push('pay plan');
  if (plan.payPreset === 'fixed_total' && !plan.fixedTotalDays) missing.push('period days');
  if (plan.payPreset !== 'per_second' && !plan.payAmount && plan.payPreset) missing.push('amount per period');
  if (plan.payPreset === 'per_second' && !plan.salaryPerSecond) missing.push('salary per second');

  plan.confidence = Math.min(0.98, Number(plan.confidence.toFixed(2)));
  return plan;
}

function cleanJsonString(raw: string): string {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return raw.slice(first, last + 1);
  return raw;
}

function normalizeLlmPlan(raw: unknown): AgentPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const sourceRaw = toTrimmedString(obj.source);
  const source: AgentPlan['source'] =
    sourceRaw === 'toolkit' ? 'toolkit' : sourceRaw === 'llm' ? 'llm' : 'heuristic';
  const summary = toTrimmedString(obj.summary) || 'Drafted plan from AI.';
  const confidenceNumber = Number(obj.confidence);
  const confidence =
    Number.isFinite(confidenceNumber) && confidenceNumber >= 0 && confidenceNumber <= 1
      ? confidenceNumber
      : 0.6;
  const missing = Array.isArray(obj.missing)
    ? obj.missing.map((x) => toTrimmedString(x)).filter(Boolean)
    : [];

  const intentRaw = toTrimmedString(obj.intent);
  const intent: AgentIntent = (['create_stream', 'update_stream', 'pause_stream', 'resume_stream', 'deactivate_stream', 'grant_access', 'unknown'].includes(intentRaw))
    ? (intentRaw as AgentIntent)
    : 'create_stream';

  const normalized: AgentPlan = {
    source,
    intent,
    summary,
    confidence,
    missing,
  };

  if (typeof obj.streamIndex === 'number') normalized.streamIndex = obj.streamIndex;
  else if (typeof obj.streamIndex === 'string') {
    const si = parseInt(obj.streamIndex);
    if (!isNaN(si)) normalized.streamIndex = si;
  }

  const bonusAmount = toTrimmedString(obj.bonusAmount);
  if (bonusAmount) normalized.bonusAmount = bonusAmount;

  const employeeWallet = toTrimmedString(obj.employeeWallet);
  if (employeeWallet) normalized.employeeWallet = employeeWallet;

  const payPreset = toPayPreset(obj.payPreset);
  if (payPreset) normalized.payPreset = payPreset;

  const payAmount = toTrimmedString(obj.payAmount);
  if (payAmount) normalized.payAmount = payAmount;

  const fixedTotalDays = toTrimmedString(obj.fixedTotalDays);
  if (fixedTotalDays) normalized.fixedTotalDays = fixedTotalDays;

  const salaryPerSecond = toTrimmedString(obj.salaryPerSecond);
  if (salaryPerSecond) normalized.salaryPerSecond = salaryPerSecond;

  normalized.boundPresetPeriod = typeof obj.boundPresetPeriod === 'boolean' ? obj.boundPresetPeriod : true;
  normalized.autoGrantDecrypt = typeof obj.autoGrantDecrypt === 'boolean' ? obj.autoGrantDecrypt : false;

  const depositAmount = toTrimmedString(obj.depositAmount);
  if (depositAmount) normalized.depositAmount = depositAmount;

  return normalized;
}

async function tryLlmPlan(input: PlannerInput): Promise<AgentPlan | null> {
  const apiKey = toTrimmedString(process.env.GROQ_API_KEY) || toTrimmedString(process.env.OPENAI_API_KEY);
  if (!apiKey) return null;
  const model = toTrimmedString(process.env.GROQ_AGENT_MODEL) || toTrimmedString(process.env.OPENAI_AGENT_MODEL) || 'llama-3.3-70b-versatile';
  const baseUrl = toTrimmedString(process.env.GROQ_BASE_URL) || toTrimmedString(process.env.OPENAI_BASE_URL) || 'https://api.groq.com/openai/v1';

  const systemPrompt =
    'You are a payroll planner for OnyxFii, a real-time agentic private payroll engine on Solana. Convert user text into STRICT JSON only.\n' +
    'KEYS: source, intent, summary, confidence, missing, employeeWallet, payPreset, payAmount, fixedTotalDays, salaryPerSecond, boundPresetPeriod, streamIndex, bonusAmount, depositAmount.\n' +
    'INTENTS (must be one of): create_stream, update_stream (for raise/bonus), pause_stream, resume_stream, deactivate_stream, grant_access.\n' +
    'payPreset must be one of: per_second, hourly, weekly, monthly, fixed_total.\n' +
    'Do not include markdown. If unsure, leave fields empty and put missing hints. For funding Step 2, capture the amount in depositAmount.';

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify({
            instruction: input.instruction,
            current: input.current,
          }),
        },
      ],
    }),
  });

  if (!resp.ok) return null;
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json?.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(cleanJsonString(content));
    const normalized = normalizeLlmPlan(parsed);
    if (!normalized) return null;
    normalized.source = 'llm';
    return normalized;
  } catch {
    return null;
  }
}

function normalizeCurrentForAction(current: CurrentFormState): Record<string, unknown> {
  return {
    employeeWallet: current.employeeWallet || '',
    payPreset: current.payPreset || '',
    payAmount: current.payAmount || '',
    fixedTotalDays: current.fixedTotalDays || '',
    salaryPerSecond: current.salaryPerSecond || '',
    boundPresetPeriod: typeof current.boundPresetPeriod === 'boolean' ? current.boundPresetPeriod : undefined,
    depositAmount: current.depositAmount || '',
  };
}

async function buildPlanForToolkit(input: PlannerInput): Promise<AgentPlan> {
  const llm = await tryLlmPlan(input);
  const base = llm || buildHeuristicPlan(input);
  return {
    ...base,
    source: 'toolkit',
    summary: `Agent drafted: ${base.summary}`,
  };
}

function createPlannerPlugin(): Plugin {
  const plannerSchema = z.object({
    instruction: z.string().min(1).max(1200),
    current: z
      .object({
        intent: z.enum(['create_stream', 'update_stream', 'pause_stream', 'resume_stream', 'deactivate_stream', 'grant_access', 'unknown']).optional(),
        employeeWallet: z.string().optional(),
        payPreset: z
          .enum(['per_second', 'hourly', 'weekly', 'monthly', 'fixed_total'])
          .optional(),
        payAmount: z.string().optional(),
        fixedTotalDays: z.string().optional(),
        salaryPerSecond: z.string().optional(),
        boundPresetPeriod: z.boolean().optional(),
        streamIndex: z.number().optional(),
        bonusAmount: z.string().optional(),
        depositAmount: z.string().optional(),
      })
      .default({}),
  });

  const plannerAction: ToolkitAction = {
    name: TOOLKIT_ACTION_NAME,
    similes: ['draft payroll plan', 'parse payroll instruction', 'agent payroll draft'],
    description:
      'Converts an employer payroll instruction into normalized payroll form inputs (wallet + pay plan fields).',
    examples: [
      [
        {
          input: {
            instruction: 'pay 5000 over 30 days to 9xQeWvG816bUx9EPf...',
            current: {},
          },
          output: {
            plan: {
              source: 'toolkit',
              payPreset: 'fixed_total',
              payAmount: '5000',
              fixedTotalDays: '30',
            },
          },
          explanation: 'Maps fixed total language to bounded payroll inputs.',
        },
      ],
    ],
    schema: plannerSchema as unknown as ToolkitAction['schema'],
    handler: async (_agent, args) => {
      const current: CurrentFormState = {
        employeeWallet: toTrimmedString(args?.current?.employeeWallet),
        payPreset: toPayPreset(args?.current?.payPreset),
        payAmount: toTrimmedString(args?.current?.payAmount),
        fixedTotalDays: toTrimmedString(args?.current?.fixedTotalDays),
        salaryPerSecond: toTrimmedString(args?.current?.salaryPerSecond),
        boundPresetPeriod:
          typeof args?.current?.boundPresetPeriod === 'boolean'
            ? args.current.boundPresetPeriod
            : undefined,
        depositAmount: toTrimmedString(args?.current?.depositAmount),
      };
      const plan = await buildPlanForToolkit({
        instruction: toTrimmedString(args?.instruction),
        current,
      });
      return { plan };
    },
  };

  return {
    name: 'ghoststream-payroll-planner',
    methods: {},
    actions: [plannerAction],
    initialize() {
      // No runtime init required for planning-only plugin.
    },
  };
}

function getToolkitContext(): { agent: SolanaAgentKit; action: ToolkitAction } | null {
  try {
    if (cachedToolkitAgent && cachedToolkitAction) {
      return { agent: cachedToolkitAgent, action: cachedToolkitAction };
    }

    const ephemeralKeypair = Keypair.generate();
    const wallet = new KeypairWallet(ephemeralKeypair, TOOLKIT_RPC_URL);
    const agent = new SolanaAgentKit(wallet, TOOLKIT_RPC_URL, {});
    agent.use(createPlannerPlugin());

    const action = agent.actions.find((a) => a.name === TOOLKIT_ACTION_NAME);
    if (!action) return null;

    cachedToolkitAgent = agent;
    cachedToolkitAction = action;
    return { agent, action };
  } catch {
    return null;
  }
}

async function tryToolkitPlan(input: PlannerInput): Promise<AgentPlan | null> {
  const context = getToolkitContext();
  if (!context) return null;

  try {
    const result = await executeAction(context.action, context.agent, {
      instruction: input.instruction,
      current: normalizeCurrentForAction(input.current),
    });
    if (result?.status !== 'success') return null;
    const normalized = normalizeLlmPlan((result as Record<string, unknown>).plan);
    if (!normalized) return null;
    normalized.source = 'toolkit';
    if (!normalized.summary.startsWith('Agent drafted:')) {
      normalized.summary = `Agent drafted: ${normalized.summary}`;
    }
    return normalized;
  } catch {
    return null;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AgentPlanOk | AgentPlanErr>
) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const body = (req.body || {}) as { instruction?: unknown; current?: unknown };
    const instruction = toTrimmedString(body.instruction);
    if (!instruction) {
      res.status(400).json({ ok: false, error: 'Instruction is required' });
      return;
    }
    if (instruction.length > 1200) {
      res.status(400).json({ ok: false, error: 'Instruction too long' });
      return;
    }

    const currentRaw = (body.current || {}) as Record<string, unknown>;
    const current: CurrentFormState = {
      employeeWallet: toTrimmedString(currentRaw.employeeWallet),
      payPreset: toPayPreset(currentRaw.payPreset),
      payAmount: toTrimmedString(currentRaw.payAmount),
      fixedTotalDays: toTrimmedString(currentRaw.fixedTotalDays),
      salaryPerSecond: toTrimmedString(currentRaw.salaryPerSecond),
      boundPresetPeriod:
        typeof currentRaw.boundPresetPeriod === 'boolean' ? currentRaw.boundPresetPeriod : undefined,
      depositAmount: toTrimmedString(currentRaw.depositAmount),
    };

    const input: PlannerInput = { instruction, current };
    const toolkitPlan = await tryToolkitPlan(input);
    const llm = toolkitPlan ? null : await tryLlmPlan(input);
    const plan = toolkitPlan || llm || buildHeuristicPlan(input);

    // Final safety pass: keep only valid numeric strings when provided.
    if (plan.payAmount && parsePositive(plan.payAmount) === null) delete plan.payAmount;
    if (plan.salaryPerSecond && parsePositive(plan.salaryPerSecond) === null) delete plan.salaryPerSecond;
    if (plan.fixedTotalDays && parsePositive(plan.fixedTotalDays) === null) delete plan.fixedTotalDays;
    if (plan.depositAmount && parsePositive(plan.depositAmount) === null) delete plan.depositAmount;

    res.status(200).json({ ok: true, plan });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to build plan' });
  }
}
