/**
 * Minimal health check HTTP server for the keeper service.
 * Exposes GET /health on port 9090 (configurable via KEEPER_HEALTH_PORT).
 *
 * Usage in the main loop:
 *   import { startHealthServer, recordTick, recordFailure } from './healthcheck';
 *   startHealthServer();
 *   // after each successful tick:
 *   recordTick();
 *   // on consecutive failures:
 *   recordFailure();
 */

import http from 'http';

const PORT = Number(process.env.KEEPER_HEALTH_PORT || '9090');

let lastTickAt = 0;
let tickCount = 0;
let consecutiveFailures = 0;
const startedAt = Date.now();

export function recordTick(): void {
    lastTickAt = Date.now();
    tickCount += 1;
    consecutiveFailures = 0;
}

export function recordFailure(): void {
    consecutiveFailures += 1;
}

export function startHealthServer(): void {
    const server = http.createServer((_req, res) => {
        const now = Date.now();
        const uptimeMs = now - startedAt;
        const lastTickAgoMs = lastTickAt > 0 ? now - lastTickAt : -1;

        // Consider unhealthy if no tick in 60 seconds or too many consecutive failures.
        const healthy = lastTickAgoMs < 60_000 && consecutiveFailures < 10;

        const body = JSON.stringify({
            ok: healthy,
            uptimeMs,
            uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
            tickCount,
            lastTickAgoMs,
            consecutiveFailures,
        });

        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(body);
    });

    server.listen(PORT, () => {
        // Log via console so it appears alongside keeper logs.
        console.log(`[keeper health] listening on http://0.0.0.0:${PORT}/health`);
    });

    server.on('error', (err) => {
        console.error(`[keeper health] server error: ${err.message}`);
    });
}
