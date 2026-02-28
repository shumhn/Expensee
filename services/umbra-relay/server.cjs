#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');

const fetchAny = globalThis.fetch;

const port = Number(process.env.UMBRA_RELAY_PORT || '9191');
const relayApiKey = (process.env.UMBRA_RELAY_API_KEY || '').trim();
const relayMode = (process.env.UMBRA_RELAY_MODE || 'destination').trim().toLowerCase();
const destinationTokenAccount = (process.env.UMBRA_RELAY_DESTINATION_TOKEN_ACCOUNT || '').trim();
const jobPrefix = (process.env.UMBRA_RELAY_JOB_PREFIX || 'umbra').trim();

const networkDiscoveryUrl = (process.env.UMBRA_NETWORK_DISCOVERY_URL || 'https://relayer.umbraprivacy.com').trim();
const networkForwardBaseUrl = (process.env.UMBRA_NETWORK_FORWARD_BASE_URL || 'https://relayer.umbraprivacy.com/relay/{relayer}').trim();
const networkForwardBodyMode = (process.env.UMBRA_NETWORK_FORWARD_BODY_MODE || 'json_transaction').trim();
const networkForwardTimeoutMs = Number(process.env.UMBRA_NETWORK_FORWARD_TIMEOUT_MS || '8000');
const networkForwardRetries = Number(process.env.UMBRA_NETWORK_FORWARD_RETRIES || '3');
const networkRelayerIndexMax = Number(process.env.UMBRA_NETWORK_RELAYER_INDEX_MAX || '8');

const provisionOneTimeDestination = process.env.UMBRA_RELAY_PROVISION_ONE_TIME_DESTINATION === 'true';
const relayRpcUrl = (process.env.UMBRA_RELAY_RPC_URL || 'https://api.devnet.solana.com').trim();
const relayPayerKeypairPath = (process.env.UMBRA_RELAY_PAYER_KEYPAIR_PATH || '').trim();
const relayPayerSecretJson = (process.env.UMBRA_RELAY_PAYER_SECRET_JSON || '').trim();
const incoTokenProgramId = (process.env.UMBRA_RELAY_INCO_TOKEN_PROGRAM_ID || '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N').trim();
const incoLightningProgramId = (process.env.UMBRA_RELAY_INCO_LIGHTNING_ID || '5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj').trim();
const payusdMint = (process.env.UMBRA_RELAY_PAYUSD_MINT || '').trim();
const routeOwnerPubkeyEnv = (process.env.UMBRA_RELAY_ROUTE_OWNER_PUBKEY || '').trim();

const INCO_INIT_ACCOUNT_DISCRIMINATOR = Buffer.from([74, 115, 99, 93, 197, 69, 103, 7]);

let relayConnection = null;
let relayPayer = null;
let routeOwnerPubkey = null;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk || '');
      if (data.length > 1024 * 1024) reject(new Error('payload_too_large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyAuth(req) {
  if (!relayApiKey) return true;
  const authHeader = String(req.headers.authorization || '');
  return authHeader === `Bearer ${relayApiKey}`;
}

function short(v) {
  const s = String(v || '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function makeJobId(streamIndex, payoutNonce) {
  const salt = crypto.randomBytes(3).toString('hex');
  return `${jobPrefix}-${streamIndex}-${payoutNonce}-${salt}`;
}

function resolveLocalPath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(process.cwd(), filePath);
}

function ensureRelaySignerLoaded() {
  if (!provisionOneTimeDestination) return;
  if (relayConnection && relayPayer) return;
  if (!payusdMint) {
    throw new Error('missing_UMBRA_RELAY_PAYUSD_MINT');
  }

  relayConnection = new Connection(relayRpcUrl, 'confirmed');

  if (relayPayerSecretJson) {
    const parsed = JSON.parse(relayPayerSecretJson);
    relayPayer = Keypair.fromSecretKey(Uint8Array.from(parsed));
  } else if (relayPayerKeypairPath) {
    const raw = fs.readFileSync(resolveLocalPath(relayPayerKeypairPath), 'utf8');
    relayPayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } else {
    throw new Error('missing_UMBRA_RELAY_PAYER_KEYPAIR_PATH_or_SECRET');
  }

  routeOwnerPubkey = routeOwnerPubkeyEnv ? new PublicKey(routeOwnerPubkeyEnv) : null;
}

async function createOneTimeDestinationTokenAccount(destinationOwnerOverride) {
  ensureRelaySignerLoaded();

  const tokenAccount = Keypair.generate();
  const mint = new PublicKey(payusdMint);
  const incoToken = new PublicKey(incoTokenProgramId);
  const incoLightning = new PublicKey(incoLightningProgramId);

  let destinationOwner = routeOwnerPubkey;
  if (destinationOwnerOverride) {
    destinationOwner = new PublicKey(destinationOwnerOverride);
  }
  if (!destinationOwner) {
    throw new Error('missing_route_owner_pubkey');
  }

  const ix = new TransactionInstruction({
    programId: incoToken,
    keys: [
      { pubkey: tokenAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationOwner, isSigner: false, isWritable: false },
      { pubkey: relayPayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: incoLightning, isSigner: false, isWritable: false },
    ],
    data: INCO_INIT_ACCOUNT_DISCRIMINATOR,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = relayPayer.publicKey;
  tx.recentBlockhash = (await relayConnection.getLatestBlockhash()).blockhash;
  tx.sign(relayPayer, tokenAccount);

  const sig = await relayConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await relayConnection.confirmTransaction(sig, 'confirmed');
  return {
    tokenAccount: tokenAccount.publicKey.toBase58(),
    txSignature: sig,
    owner: destinationOwner.toBase58(),
  };
}

function parsePayload(raw) {
  const body = JSON.parse(raw || '{}');
  return {
    version: Number(body.version || 0),
    dryRun: body.dryRun === true,
    poolId: String(body.poolId || ''),
    business: String(body.business || ''),
    streamIndex: Number(body.streamIndex),
    payoutNonce: Number(body.payoutNonce),
    payoutTokenAccount: String(body.payoutTokenAccount || ''),
    keeper: String(body.keeper || ''),
    routeOwnerPubkey: String(body.routeOwnerPubkey || ''),
  };
}

function parseForwardPayload(raw) {
  const body = JSON.parse(raw || '{}');
  return {
    version: Number(body.version || 0),
    streamIndex: Number(body.streamIndex),
    payoutNonce: Number(body.payoutNonce),
    signedTransactionBase64: String(body.signedTransactionBase64 || ''),
  };
}

function validatePayload(p) {
  if (p.version !== 1) return 'unsupported_version';
  if (!p.poolId) return 'missing_pool_id';
  if (!p.business) return 'missing_business';
  if (!Number.isFinite(p.streamIndex) || p.streamIndex < 0) return 'invalid_stream_index';
  if (!Number.isFinite(p.payoutNonce) || p.payoutNonce <= 0) return 'invalid_payout_nonce';
  if (!p.payoutTokenAccount) return 'missing_payout_token_account';
  if (!p.keeper) return 'missing_keeper';
  return null;
}

function validateForwardPayload(p) {
  if (p.version !== 1) return 'unsupported_version';
  if (!Number.isFinite(p.streamIndex) || p.streamIndex < 0) return 'invalid_stream_index';
  if (!Number.isFinite(p.payoutNonce) || p.payoutNonce <= 0) return 'invalid_payout_nonce';
  if (!p.signedTransactionBase64) return 'missing_signed_transaction';
  return null;
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractSignature(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.signature === 'string') return payload.signature;
  if (typeof payload.txSignature === 'string') return payload.txSignature;
  if (typeof payload.result === 'string') return payload.result;
  if (payload.data && typeof payload.data.signature === 'string') return payload.data.signature;
  return '';
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

async function discoverRelayerPublicKey() {
  if (!fetchAny) throw new Error('fetch_unavailable');
  const url = networkDiscoveryUrl;

  // Try GET style first.
  try {
    const g = await fetchAny(url, { method: 'GET' });
    const raw = await g.text();
    const parsed = parseMaybeJson(raw);
    const keys =
      (parsed && Array.isArray(parsed.relayerPublicKeys) && parsed.relayerPublicKeys) ||
      (parsed && Array.isArray(parsed.relayers) && parsed.relayers.map((r) => r.publicKey || r.relayerPublicKey).filter(Boolean)) ||
      [];
    if (keys.length > 0) {
      return String(keys[Math.floor(Math.random() * keys.length)]);
    }
  } catch {
    // continue
  }

  // Fallback to POST style with random index.
  const relayerIndex = Math.floor(Math.random() * Math.max(1, networkRelayerIndexMax));
  const p = await fetchAny(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relayerIndex }),
  });
  const raw = await p.text();
  const parsed = parseMaybeJson(raw) || {};
  const relayer =
    parsed.relayerPublicKey ||
    parsed.publicKey ||
    (Array.isArray(parsed.relayerPublicKeys) ? parsed.relayerPublicKeys[0] : null);
  if (!relayer) throw new Error('relayer_discovery_failed');
  return String(relayer);
}

function resolveForwardEndpoint(relayerPublicKey) {
  if (networkForwardBaseUrl.includes('{relayer}')) {
    return networkForwardBaseUrl.replace('{relayer}', relayerPublicKey);
  }
  return `${networkForwardBaseUrl.replace(/\/+$/, '')}/${relayerPublicKey}`;
}

async function forwardSignedTransactionToUmbra(signedTransactionBase64) {
  if (!fetchAny) return { ok: false, reason: 'fetch_unavailable' };
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= networkForwardRetries; attempt += 1) {
    try {
      const relayerPublicKey = await discoverRelayerPublicKey();
      const endpoint = resolveForwardEndpoint(relayerPublicKey);
      const { controller, timeout } = withTimeout(networkForwardTimeoutMs);

      try {
        let body = '';
        let headers = {};

        if (networkForwardBodyMode === 'raw_base64') {
          body = signedTransactionBase64;
          headers = { 'Content-Type': 'text/plain' };
        } else if (networkForwardBodyMode === 'json_signed_transaction') {
          body = JSON.stringify({ signedTransaction: signedTransactionBase64 });
          headers = { 'Content-Type': 'application/json' };
        } else {
          body = JSON.stringify({ transaction: signedTransactionBase64 });
          headers = { 'Content-Type': 'application/json' };
        }

        const res = await fetchAny(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        const raw = await res.text();
        const parsed = parseMaybeJson(raw) || raw;
        if (!res.ok) {
          lastError = `forward_http_${res.status}`;
          continue;
        }

        const relayTxSignature = extractSignature(parsed);
        return { ok: true, relayerPublicKey, relayTxSignature };
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
  }

  return { ok: false, reason: lastError };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return json(res, 200, {
      ok: true,
      service: 'umbra-relay',
      mode: relayMode,
      destinationConfigured: destinationTokenAccount.length > 0,
      networkDiscoveryHost: short(networkDiscoveryUrl),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  if (req.method === 'POST' && (req.url === '/route' || req.url === '/api/route')) {
    if (!verifyAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
      const payload = parsePayload(await readBody(req));
      const invalid = validatePayload(payload);
      if (invalid) return json(res, 400, { ok: false, error: invalid });

      const jobId = makeJobId(payload.streamIndex, payload.payoutNonce);
      const logBase =
        `job=${jobId} stream=${payload.streamIndex} nonce=${payload.payoutNonce} ` +
        `business=${short(payload.business)} payout=${short(payload.payoutTokenAccount)} dryRun=${payload.dryRun}`;

      if (relayMode === 'defer') {
        console.log(`[umbra-relay] accepted(defer) ${logBase}`);
        return json(res, 200, { ok: true, status: 'accepted', jobId, deferClaim: true });
      }

      let selectedDestination = destinationTokenAccount;
      let provisionTx = '';
      if (!payload.dryRun && provisionOneTimeDestination) {
        try {
          const provisioned = await createOneTimeDestinationTokenAccount(payload.routeOwnerPubkey || '');
          selectedDestination = provisioned.tokenAccount;
          provisionTx = provisioned.txSignature;
          console.log(
            `[umbra-relay] one-time account owner=${short(provisioned.owner)} account=${short(provisioned.tokenAccount)}`
          );
        } catch (e) {
          console.log(`[umbra-relay] one-time provision failed ${logBase} reason=${String(e && e.message ? e.message : e)}`);
          return json(res, 503, { ok: false, error: 'one_time_destination_provision_failed' });
        }
      }

      if (!selectedDestination) {
        console.log(`[umbra-relay] accepted(no-destination) ${logBase}`);
        return json(res, 200, { ok: true, status: 'accepted', jobId, deferClaim: true });
      }

      console.log(
        `[umbra-relay] routed ${logBase} destination=${short(selectedDestination)} ` +
        `${provisionTx ? `provision_tx=${short(provisionTx)}` : ''}`.trim()
      );
      return json(res, 200, {
        ok: true,
        status: 'routed',
        jobId,
        destinationTokenAccount: selectedDestination,
        deferClaim: false,
        provisionTxSignature: provisionTx || null,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  if (req.method === 'POST' && (req.url === '/forward-claim' || req.url === '/api/forward-claim')) {
    if (!verifyAuth(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    if (relayMode !== 'umbra-network') {
      return json(res, 400, { ok: false, error: 'forward_mode_requires_umbra-network' });
    }

    try {
      const payload = parseForwardPayload(await readBody(req));
      const invalid = validateForwardPayload(payload);
      if (invalid) return json(res, 400, { ok: false, error: invalid });

      const jobId = makeJobId(payload.streamIndex, payload.payoutNonce);
      const result = await forwardSignedTransactionToUmbra(payload.signedTransactionBase64);
      if (!result.ok) {
        console.log(
          `[umbra-relay] forward failed job=${jobId} stream=${payload.streamIndex} nonce=${payload.payoutNonce} reason=${result.reason}`
        );
        return json(res, 502, { ok: false, error: result.reason, jobId });
      }

      console.log(
        `[umbra-relay] forward ok job=${jobId} stream=${payload.streamIndex} nonce=${payload.payoutNonce} ` +
          `relayer=${short(result.relayerPublicKey)} tx=${short(result.relayTxSignature || 'pending')}`
      );
      return json(res, 200, {
        ok: true,
        status: 'forwarded',
        jobId,
        relayerPublicKey: result.relayerPublicKey,
        relayTxSignature: result.relayTxSignature || null,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  return json(res, 404, { ok: false, error: 'not_found' });
});

server.listen(port, () => {
  if (provisionOneTimeDestination) {
    try {
      ensureRelaySignerLoaded();
      const ownerLabel = routeOwnerPubkey ? routeOwnerPubkey.toBase58() : 'random-per-route';
      console.log(
        `[umbra-relay] one-time destination provisioning enabled owner=${ownerLabel} rpc=${relayRpcUrl}`
      );
    } catch (e) {
      console.log(`[umbra-relay] one-time provisioning init failed reason=${String(e && e.message ? e.message : e)}`);
    }
  }
  console.log(
    `[umbra-relay] listening on :${port} mode=${relayMode} destinationConfigured=${destinationTokenAccount.length > 0}`
  );
});
