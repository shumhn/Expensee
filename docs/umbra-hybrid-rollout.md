# Umbra + Inco Hybrid Rollout (Employer + Employee Privacy)

## Goal

Use the strongest part of each layer:

- Inco: confidential payroll math and encrypted amounts.
- Umbra: sender/receiver unlinkability on payout delivery.
- Keeper: always-on execution, retries, fallback, and relays.

## Current State

- Payroll rate/accrual/settlement uses Inco encrypted handles.
- Keeper processes withdraw requests into shielded payout accounts first.
- Optional direct auto-claim exists for compatibility and demos.

## Target State

1. Employer creates private payroll record (no fixed worker destination required in stream state).
2. Keeper settles into shielded payout staging account.
3. Keeper routes payout through Umbra relay path.
4. Worker claims to fresh destination account.
5. Legacy direct destination route remains disabled in strict privacy mode.

## Keeper Route Modes

Use `KEEPER_PRIVACY_PAYOUT_ROUTE_MODE`:

- `off`
  - Existing behavior only.
  - No Umbra route decisions.
- `shadow`
  - Keeper logs Umbra route decisions and metadata.
  - Existing payout claim flow still runs.
- `enforced`
  - Keeper sends buffered payout metadata to Umbra relay endpoint.
  - No direct fallback route is executed.
  - If relay fails, payout remains buffered and keeper emits alert/dead-letter.

Umbra config vars:

- `KEEPER_UMBRA_RELAY_URL`
- `KEEPER_UMBRA_POOL_ID`
- `KEEPER_UMBRA_RELAYER_KEY_ID` (optional ops label)
- `KEEPER_UMBRA_RELAY_API_KEY` (optional bearer auth)
- `KEEPER_UMBRA_ROUTE_TIMEOUT_MS`
- `KEEPER_UMBRA_ROUTE_RETRIES`
- `KEEPER_UMBRA_FORWARD_SIGNED_CLAIM`
- `KEEPER_UMBRA_FORWARD_URL`

## Relay Contract

Keeper sends `POST` to `KEEPER_UMBRA_RELAY_URL` with payload fields:

- `version`, `dryRun`, `poolId`, `relayerKeyId`
- `business`, `streamIndex`
- `requestAddress`, `requesterAuthHash`, `requestedAt`
- `payoutNonce`, `shieldedPayout`, `payoutTokenAccount`, `mint`, `keeper`, `createdAt`

Relay responses:

- Async accept (no immediate claim):
  - `{ ok: true, status: "accepted", jobId, deferClaim: true }`
- Immediate intermediate route:
  - `{ ok: true, status: "routed", jobId, destinationTokenAccount, deferClaim: false }`

When `destinationTokenAccount` is returned in `enforced` mode, keeper executes
`keeper_claim_on_behalf_v2` directly to that intermediate destination.

## Local Dev Relay

Local relay service path:

- `/Users/sumangiri/Desktop/expensee/services/umbra-relay/server.cjs`

Run:

```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=destination \
UMBRA_RELAY_DESTINATION_TOKEN_ACCOUNT=<intermediate_inco_token_account> \
npm run umbra:relay:dev
```

For stronger linkability reduction, enable one-time route destination provisioning:

```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=destination \
UMBRA_RELAY_PROVISION_ONE_TIME_DESTINATION=true \
UMBRA_RELAY_RPC_URL=https://api.devnet.solana.com \
UMBRA_RELAY_PAYER_KEYPAIR_PATH=/absolute/path/to/relay-keypair.json \
UMBRA_RELAY_PAYUSD_MINT=<payusd_mint> \
npm run umbra:relay:dev
```

This creates a fresh confidential destination token account per payout route call.
By default, each one-time account gets a random owner key to avoid owner-level clustering.

Umbra network forward mode (signed claim tx relay):

```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=umbra-network \
UMBRA_RELAY_DESTINATION_TOKEN_ACCOUNT=<intermediate_inco_token_account> \
UMBRA_NETWORK_DISCOVERY_URL=https://relayer.umbraprivacy.com \
UMBRA_NETWORK_FORWARD_BASE_URL=https://relayer.umbraprivacy.com/relay/{relayer} \
npm run umbra:relay:dev
```

Keeper env for integration:

```bash
KEEPER_PRIVACY_PAYOUT_ROUTE_MODE=enforced
KEEPER_UMBRA_RELAY_URL=http://localhost:9191/route
KEEPER_UMBRA_POOL_ID=devnet-pool-1
KEEPER_UMBRA_RELAYER_KEY_ID=local-relayer
KEEPER_UMBRA_FORWARD_SIGNED_CLAIM=false
# Optional override; defaults to http://localhost:9191/forward-claim
KEEPER_UMBRA_FORWARD_URL=http://localhost:9191/forward-claim
```

Note: set `KEEPER_UMBRA_FORWARD_SIGNED_CLAIM=true` only when relay mode is
`UMBRA_RELAY_MODE=umbra-network`. Keep it `false` for `destination` mode.

## Employer Side UX

- Keep employer onboarding simple:
  - "Create private payroll record"
  - "Allow automation (keeper) decrypt access"
  - "Private payout route is managed by automation"
- Do not ask employer to choose privacy routing internals.
- Keep MagicBlock controls as speed controls only.

## Employee Side UX

- "Reveal live earnings" should default to keeper confidential relay in strict mode.
- Withdraw should route to shielded payout first, then private route.
- Encourage one-time destination account per claim.

## Rollout Phases

1. Phase 1 (done): privacy route mode and Umbra env controls.
2. Phase 2 (done): keeper relay adapter call with timeout/retry/auth support.
3. Phase 3 (done): local relay service + immediate intermediate destination route path.
4. Phase 4 (done): signed claim tx forwarding path from keeper to relay worker.
5. Phase 5: wire production Umbra pool worker logic behind relay endpoint.
6. Phase 6: frontend status cards show route state (`Buffered`, `Routed`, `Claimed`).
7. Phase 7: disable legacy auto-claim defaults and run privacy regression checks.

## Known Limits

- Chain activity and some operational metadata remain visible.
- Hybrid design focuses on hiding sensitive amounts and reducing payer/receiver linkability.
