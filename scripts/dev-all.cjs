#!/usr/bin/env node

/**
 * Dev orchestrator: keeper + UI + v4 flow.
 *
 * Env toggles:
 * - RUN_KEEPER=true/false
 * - RUN_UI=true/false
 * - RUN_FLOW=true/false
 * - KEEPER_HEALTH_URL (default: NEXT_PUBLIC_KEEPER_API_URL + /health)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

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

function getHealthUrl() {
  const explicit = (process.env.KEEPER_HEALTH_URL || '').trim();
  if (explicit) return explicit;
  const base = (process.env.NEXT_PUBLIC_KEEPER_API_URL || 'http://localhost:9090').trim();
  return `${base.replace(/\/$/, '')}/health`;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      const { statusCode } = res;
      res.resume();
      res.on('end', () => resolve(statusCode || 0));
    });
    req.on('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await httpGet(url);
      if (status >= 200 && status < 300) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function spawnProcess(label, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot, env: process.env });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[dev-all] ${label} exited with code ${code}`);
    }
  });
  return child;
}

async function main() {
  const runKeeper = envFlag('RUN_KEEPER', true);
  const runUi = envFlag('RUN_UI', true);
  const runFlow = envFlag('RUN_FLOW', true);
  const healthUrl = getHealthUrl();

  let keeperChild = null;
  if (runKeeper) {
    const healthy = await waitForHealth(healthUrl, 2000);
    if (healthy) {
      console.log(`[dev-all] Keeper already running (${healthUrl}).`);
    } else {
      console.log('[dev-all] Starting keeper...');
      keeperChild = spawnProcess('keeper', 'npm', ['run', 'keeper:dev']);
    }
  }

  let uiChild = null;
  if (runUi) {
    console.log('[dev-all] Starting UI...');
    uiChild = spawnProcess('ui', 'npm', ['run', 'dev']);
  }

  if (runFlow) {
    console.log('[dev-all] Waiting for keeper health...');
    const ok = await waitForHealth(healthUrl, 60_000);
    if (!ok) {
      throw new Error(`Keeper health check timed out at ${healthUrl}`);
    }
    console.log('[dev-all] Running v4 flow...');
    spawnProcess('flow', 'npm', ['run', 'flow:v4']);
  }

  const cleanup = () => {
    if (keeperChild) keeperChild.kill('SIGINT');
    if (uiChild) uiChild.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[dev-all] failed:', err);
  process.exit(1);
});
