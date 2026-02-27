"use strict";
/**
 * Health check + Claim Relay API server for the keeper service.
 * Exposes:
 *   GET  /health           — health check
 *   POST /api/claim-auth   — receive worker claim authorizations
 *
 * Port: 9090 (configurable via KEEPER_HEALTH_PORT).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordTick = recordTick;
exports.recordFailure = recordFailure;
exports.startHealthServer = startHealthServer;
const http_1 = __importDefault(require("http"));
const PORT = Number(process.env.KEEPER_HEALTH_PORT || '9090');
let lastTickAt = 0;
let tickCount = 0;
let consecutiveFailures = 0;
const startedAt = Date.now();
/** In-memory queue removed for DB integration. */
function recordTick() {
    lastTickAt = Date.now();
    tickCount += 1;
    consecutiveFailures = 0;
}
function recordFailure() {
    consecutiveFailures += 1;
}
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}
function startHealthServer() {
    const server = http_1.default.createServer((req, res) => {
        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, corsHeaders());
            res.end();
            return;
        }
        // Health check
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
            const now = Date.now();
            const uptimeMs = now - startedAt;
            const lastTickAgoMs = lastTickAt > 0 ? now - lastTickAt : -1;
            const healthy = lastTickAgoMs < 60000 && consecutiveFailures < 10;
            Promise.resolve().then(() => __importStar(require('./claims-queue'))).then(q => q.getQueueSize()).then(queueSize => {
                const body = JSON.stringify({
                    ok: healthy,
                    uptimeMs,
                    uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
                    tickCount,
                    lastTickAgoMs,
                    consecutiveFailures,
                    pendingClaimAuths: queueSize,
                });
                res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(body);
            }).catch(() => {
                const body = JSON.stringify({ ok: healthy, error: "Queue unreadable" });
                res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', ...corsHeaders() });
                res.end(body);
            });
            return;
        }
        // Claim authorization endpoint
        if (req.method === 'POST' && req.url === '/api/claim-auth') {
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.workerPubkey || data.streamIndex === undefined || data.nonce === undefined || !data.businessOwner) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }
                    const { enqueueClaimAuth, getQueueSize } = await Promise.resolve().then(() => __importStar(require('./claims-queue')));
                    const queued = await enqueueClaimAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        nonce: data.nonce,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        expiry: data.expiry || 0,
                        receivedAt: Date.now(),
                    });
                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'Authorization already queued' }));
                        return;
                    }
                    const queueSize = await getQueueSize();
                    console.log(`[keeper api] claim auth queued to DB stream=${data.streamIndex} nonce=${data.nonce} worker=${data.workerPubkey.slice(0, 8)}...`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true, queueSize }));
                }
                catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }
        // Withdraw authorization endpoint
        if (req.method === 'POST' && req.url === '/api/withdraw-auth') {
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.workerPubkey || data.streamIndex === undefined || data.timestamp === undefined || !data.businessOwner) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }
                    const { enqueueWithdrawAuth } = await Promise.resolve().then(() => __importStar(require('./claims-queue')));
                    const queued = await enqueueWithdrawAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        timestamp: data.timestamp,
                        receivedAt: Date.now(),
                    });
                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'Withdraw auth already queued' }));
                        return;
                    }
                    console.log(`[keeper api] withdraw auth queued to DB stream=${data.streamIndex} ts=${data.timestamp} worker=${data.workerPubkey.slice(0, 8)}...`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }
        // View authorization endpoint
        if (req.method === 'POST' && req.url === '/api/request-view-access') {
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.workerPubkey || data.streamIndex === undefined || data.timestamp === undefined || !data.businessOwner) {
                        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ error: 'Missing required fields' }));
                        return;
                    }
                    const { enqueueViewAuth } = await Promise.resolve().then(() => __importStar(require('./claims-queue')));
                    const queued = await enqueueViewAuth({
                        workerPubkey: data.workerPubkey,
                        streamIndex: data.streamIndex,
                        signature: data.signature || [],
                        message: data.message || [],
                        businessOwner: data.businessOwner,
                        timestamp: data.timestamp,
                        receivedAt: Date.now(),
                    });
                    if (!queued) {
                        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                        res.end(JSON.stringify({ ok: true, message: 'View auth already queued' }));
                        return;
                    }
                    console.log(`[keeper api] view auth queued to DB stream=${data.streamIndex} ts=${data.timestamp} worker=${data.workerPubkey.slice(0, 8)}...`);
                    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
                    res.end(JSON.stringify({ error: e?.message || 'Invalid JSON' }));
                }
            });
            return;
        }
        // 404
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ error: 'Not found' }));
    });
    server.listen(PORT, () => {
        console.log(`[keeper api] listening on http://0.0.0.0:${PORT} (health + relay API)`);
    });
    server.on('error', (err) => {
        console.error(`[keeper api] server error: ${err.message}`);
    });
}
