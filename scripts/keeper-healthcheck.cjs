#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const url = (process.env.KEEPER_HEALTH_URL || process.env.NEXT_PUBLIC_KEEPER_API_URL || 'http://localhost:9090')
  .replace(/\/$/, '') + '/health';

const client = url.startsWith('https:') ? https : http;

const req = client.get(url, (res) => {
  const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
  if (!ok) {
    console.error(`keeper health failed: ${res.statusCode}`);
    process.exit(1);
  }
  process.exit(0);
});

req.on('error', (err) => {
  console.error(`keeper health error: ${err?.message || err}`);
  process.exit(1);
});
