#!/usr/bin/env node
'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');

const relayUrl = (process.env.UMBRA_RELAY_TEST_URL || 'http://localhost:9191').replace(/\/+$/, '');
const routeUrl = `${relayUrl}/route`;
const healthUrl = `${relayUrl}/health`;
const poolId = process.env.UMBRA_RELAY_TEST_POOL_ID || 'devnet-pool-1';
const rpcUrl = process.env.UMBRA_RELAY_TEST_RPC_URL || 'https://api.devnet.solana.com';
const mintExpected = process.env.UMBRA_RELAY_TEST_MINT || '';

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function requestBody(nonce) {
  return {
    version: 1,
    dryRun: false,
    poolId,
    business: '11111111111111111111111111111111',
    streamIndex: 99,
    payoutNonce: nonce,
    payoutTokenAccount: '11111111111111111111111111111111',
    keeper: '11111111111111111111111111111111',
  };
}

async function readTokenMeta(connection, tokenAccount) {
  const info = await connection.getAccountInfo(new PublicKey(tokenAccount), 'confirmed');
  if (!info) return null;
  const d = Buffer.from(info.data);
  if (d.length < 72) return null;
  return {
    ownerProgram: info.owner.toBase58(),
    mint: new PublicKey(d.subarray(8, 40)).toBase58(),
    tokenOwner: new PublicKey(d.subarray(40, 72)).toBase58(),
    len: d.length,
  };
}

async function main() {
  const health = await fetchJson(healthUrl);
  assert(health.ok && health.json.ok === true, `relay health failed: ${JSON.stringify(health)}`);
  console.log(`[self-test] relay healthy mode=${health.json.mode}`);

  const n1 = Math.floor(Date.now() / 1000);
  const n2 = n1 + 1;
  const r1 = await fetchJson(routeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(n1)),
  });
  const r2 = await fetchJson(routeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody(n2)),
  });

  assert(r1.ok && r1.json.ok, `route1 failed: ${JSON.stringify(r1)}`);
  assert(r2.ok && r2.json.ok, `route2 failed: ${JSON.stringify(r2)}`);
  const d1 = r1.json.destinationTokenAccount;
  const d2 = r2.json.destinationTokenAccount;
  assert(typeof d1 === 'string' && d1.length > 0, 'route1 destination missing');
  assert(typeof d2 === 'string' && d2.length > 0, 'route2 destination missing');
  assert(d1 !== d2, 'destinations are reused (expected one-time unique destination)');
  console.log(`[self-test] destination1=${d1}`);
  console.log(`[self-test] destination2=${d2}`);
  console.log('[self-test] one-time destination uniqueness PASS');

  const conn = new Connection(rpcUrl, 'confirmed');
  const m1 = await readTokenMeta(conn, d1);
  const m2 = await readTokenMeta(conn, d2);
  assert(m1 && m2, 'one or more destination token accounts not found on-chain');
  assert(m1.ownerProgram === '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N', 'dest1 not Inco token account');
  assert(m2.ownerProgram === '4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N', 'dest2 not Inco token account');
  if (mintExpected) {
    assert(m1.mint === mintExpected, `dest1 mint mismatch expected=${mintExpected} got=${m1.mint}`);
    assert(m2.mint === mintExpected, `dest2 mint mismatch expected=${mintExpected} got=${m2.mint}`);
  }
  assert(m1.tokenOwner !== m2.tokenOwner, 'token owners are reused (expected random owner per route)');

  console.log(`[self-test] tokenOwner1=${m1.tokenOwner}`);
  console.log(`[self-test] tokenOwner2=${m2.tokenOwner}`);
  console.log('[self-test] on-chain checks PASS');
}

main()
  .then(() => {
    console.log('[self-test] ALL PASS');
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[self-test] FAIL: ${e?.message || e}`);
    process.exit(1);
  });

