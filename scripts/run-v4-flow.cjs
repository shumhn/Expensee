#!/usr/bin/env node

/**
 * Run the full v4 flow end-to-end (devnet).
 *
 * Steps (default):
 * 1) setup-v4-pooled.cjs
 * 2) v4-delegate-cycle.cjs
 * 3) v4-withdraw-flow.cjs
 *
 * Options (env):
 * - RUN_SETUP=false
 * - RUN_DELEGATE=false
 * - RUN_WITHDRAW=false
 * - USE_TEE=true
 * - SETUP_FORCE_NEW_EMPLOYEE=true (recommended if prior withdraw exists)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const statePath = path.join(repoRoot, 'services', 'keeper', 'devnet-v4-state.json');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(repoRoot, 'frontend', '.env.local'));
loadEnvFile(path.join(repoRoot, '.env'));

function envFlag(name, fallback = true) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

function runScript(label, script, extraEnv = {}) {
  const scriptPath = path.join(__dirname, script);
  console.log(`\n== ${label} ==`);
  const result = spawnSync('node', [scriptPath], {
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function extractTxs(output) {
  const lines = output.split('\n');
  const steps = [];
  const rx = /^([a-zA-Z0-9_]+):\s+([1-9A-HJ-NP-Za-km-z]{32,})\s*$/;
  for (const line of lines) {
    const match = line.trim().match(rx);
    if (match) {
      steps.push({ label: match[1], sig: match[2] });
    }
  }
  return steps;
}

function updateState(runRecord) {
  let state = {};
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      state = {};
    }
  }
  state.lastRun = runRecord;
  const history = Array.isArray(state.flowHistory) ? state.flowHistory : [];
  history.unshift(runRecord);
  state.flowHistory = history.slice(0, 10);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  const startedAt = new Date().toISOString();
  const runRecord = { startedAt, status: 'running', steps: [] };
  try {
    const explicitUseTee = (process.env.USE_TEE || '').trim();
    const validator = (process.env.MAGICBLOCK_VALIDATOR || process.env.NEXT_PUBLIC_MAGICBLOCK_VALIDATOR || '').trim();
    let useTee = envFlag('USE_TEE', false);
    if (!explicitUseTee) {
      const teeEnabled = envFlag('NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED', false);
      if (teeEnabled || validator === 'FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA') {
        useTee = true;
      }
    }
    const runSetup = envFlag('RUN_SETUP', true);
    const runDelegate = envFlag('RUN_DELEGATE', true);
    const runWithdraw = envFlag('RUN_WITHDRAW', true);

    let output = '';
    if (runSetup) {
      const setupEnv = {
        ...(process.env.SETUP_FORCE_NEW_EMPLOYEE ? {} : { SETUP_FORCE_NEW_EMPLOYEE: 'true' }),
      };
      output += runScript('setup-v4-pooled', 'setup-v4-pooled.cjs', setupEnv);
    }
    if (runDelegate) {
      output += runScript('v4-delegate-cycle', 'v4-delegate-cycle.cjs', {
        USE_TEE: useTee ? 'true' : 'false',
      });
    }
    if (runWithdraw) {
      output += runScript('v4-withdraw-flow', 'v4-withdraw-flow.cjs', {
        USE_TEE: useTee ? 'true' : 'false',
      });
    }

    runRecord.status = 'success';
    runRecord.steps = extractTxs(output);
    runRecord.finishedAt = new Date().toISOString();
    updateState(runRecord);
  } catch (err) {
    runRecord.status = 'failed';
    runRecord.error = err.message || String(err);
    runRecord.finishedAt = new Date().toISOString();
    updateState(runRecord);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
