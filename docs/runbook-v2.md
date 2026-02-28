# Runbook: Expensee (Private Payroll v2, Devnet First)

Hybrid Umbra privacy rollout notes: see `/Users/sumangiri/Desktop/expensee/docs/umbra-hybrid-rollout.md`.

This repo runs a **pull-based payroll** model with **strict private shield route**:
- Employee signs off-chain auth messages (withdraw/claim); Keeper relays on-chain execution.
- Amounts remain encrypted with Inco handles.
- Payouts follow a 2-hop path: vault -> shielded payout account -> claim destination.

## 1. Preconditions

- Solana CLI configured for devnet.
- Anchor installed.
- Program upgrade authority wallet funded on devnet.
- Inco programs available on devnet.
- MagicBlock router available (only needed if you delegate streams).
- Optional: Range API key if you enable compliance checks.

## 2. Deploy/upgrade program

```bash
anchor build -p payroll
anchor deploy -p payroll --provider.cluster devnet
```

Update program ID in:
- `/Users/sumangiri/Desktop/expensee/Anchor.toml`
- `/Users/sumangiri/Desktop/expensee/frontend/.env.local`
- keeper env: `/Users/sumangiri/Desktop/expensee/backend/keeper/.env`

## 3. Configure app

From `/Users/sumangiri/Desktop/expensee/frontend/.env.local.example`, fill required:
- `NEXT_PUBLIC_SOLANA_RPC_URL` (use a normal Solana devnet RPC)
- `NEXT_PUBLIC_PAYROLL_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID`
- `NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM`
- `NEXT_PUBLIC_PAYUSD_MINT`

Optional:
- `NEXT_PUBLIC_COMPLIANCE_ENABLED=false` (default)
- `NEXT_PUBLIC_RANGE_API_KEY` (only if you enable compliance)

Run:
```bash
cd app
npm install
npm run dev
```

## 4. Configure keeper

Use `/Users/sumangiri/Desktop/expensee/backend/keeper/.env.example`.

Note: keeper reuses the Inco SDK installed under `frontend/`, so run `npm install` in `frontend/` before starting the keeper.

Mandatory:
- `KEEPER_RPC_URL` (TX RPC; recommend `https://devnet-router.magicblock.app`)
- `KEEPER_READ_RPC_URL` (read/scanning RPC; must support `getProgramAccounts`, so use a normal Solana RPC)
- `KEEPER_PROGRAM_ID`
- `KEEPER_PAYER_KEYPAIR_PATH` (or `KEEPER_PAYER_SECRET_JSON`)

Recommended for production-style devnet:
- Use a **separate hot keeper key** for `KEEPER_PAYER_KEYPAIR_PATH` (do not reuse program upgrade authority key).

Optional:
- `KEEPER_ROUTER_RPC_URL` (defaults to MagicBlock router for `getDelegationStatus`)
- `KEEPER_VALIDATOR` (EU/US/Asia ER validator identity)
- `KEEPER_REDELEGATE_AFTER_WITHDRAW=true`
- `KEEPER_ACCRUE_ON_ER_BEFORE_COMMIT=true` (recommended: uses ER as the accrual checkpoint engine for delegated streams)
- Hybrid Umbra route controls:
  - `KEEPER_PRIVACY_PAYOUT_ROUTE_MODE=enforced` (recommended for strict privacy demos)
  - `KEEPER_UMBRA_RELAY_URL`, `KEEPER_UMBRA_POOL_ID`
  - optional `KEEPER_UMBRA_RELAY_API_KEY`, `KEEPER_UMBRA_ROUTE_TIMEOUT_MS`, `KEEPER_UMBRA_ROUTE_RETRIES`
  - optional `KEEPER_UMBRA_FORWARD_SIGNED_CLAIM`, `KEEPER_UMBRA_FORWARD_URL` (`KEEPER_UMBRA_FORWARD_SIGNED_CLAIM=true` only when relay mode is `umbra-network`; keep `false` for `destination` mode)
- `KEEPER_COMPLIANCE_ENABLED=false` (default)
- `KEEPER_RANGE_API_KEY` (only if compliance enabled)

Run:
```bash
cd backend/keeper
npm install
npm start
```

Optional local Umbra relay for hybrid routing tests:
```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=destination \
UMBRA_RELAY_DESTINATION_TOKEN_ACCOUNT=<intermediate_inco_token_account> \
npm run umbra:relay:dev
```

One-time destination mode (recommended for stronger unlinkability):
```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=destination \
UMBRA_RELAY_PROVISION_ONE_TIME_DESTINATION=true \
UMBRA_RELAY_RPC_URL=https://api.devnet.solana.com \
UMBRA_RELAY_PAYER_KEYPAIR_PATH=/absolute/path/to/relay-keypair.json \
UMBRA_RELAY_PAYUSD_MINT=<payusd_mint> \
npm run umbra:relay:dev
```

Quick validation while relay is running:
```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_TEST_URL=http://localhost:9191 \
UMBRA_RELAY_TEST_POOL_ID=devnet-pool-1 \
UMBRA_RELAY_TEST_RPC_URL=https://api.devnet.solana.com \
UMBRA_RELAY_TEST_MINT=<payusd_mint> \
npm run umbra:relay:self-test
```

Optional Umbra network forward mode:
```bash
cd /Users/sumangiri/Desktop/expensee
UMBRA_RELAY_MODE=umbra-network \
UMBRA_RELAY_DESTINATION_TOKEN_ACCOUNT=<intermediate_inco_token_account> \
UMBRA_NETWORK_DISCOVERY_URL=https://relayer.umbraprivacy.com \
UMBRA_NETWORK_FORWARD_BASE_URL=https://relayer.umbraprivacy.com/relay/{relayer} \
npm run umbra:relay:dev
```

## 5. Normal operations (MVP)

Employer:
1. Register business + init vault.
2. Init v2 stream config (keeper pubkey + settle interval).
   - If you need to rotate keeper later, use **Update Keeper (Rotate Hot Key)** in `/employer`.
3. Add employee stream v2 in **private shield route mode** (no fixed destination in stream state).
4. Fund vault.
5. Optional: delegate stream to an ER validator (EU/US/Asia recommended on devnet).
6. Keep automation (keeper) decrypt access enabled for private reveal and payout processing.

Optional quick setup script (creates vault/stream + optional mint+deposit if you control mint authority):
```bash
cd /Users/sumangiri/Desktop/expensee
set -a; source /Users/sumangiri/Desktop/expensee/backend/keeper/.env; set +a
SETUP_MINT_AUTHORITY_KEYPAIR_PATH=/Users/sumangiri/Desktop/expensee/keys/payroll-authority.json \
SETUP_MINT_UI=100 \
SETUP_DEPOSIT_UI=50 \
node /Users/sumangiri/Desktop/expensee/frontend/scripts/setup-v2-stream.cjs
```

Employee:
1. Open `/employee`, load the stream.
2. Click **Request Withdraw** (signs off-chain message — no Solana tx needed).

Keeper:
1. Scans pending `WithdrawRequestV2` accounts.
2. If delegated: commit+undelegate via router and wait for base ownership.
3. Calls `accrue_v2` to checkpoint the latest earned amount.
4. Calls `process_withdraw_request_v2` on base layer to buffer payout into shielded account.
5. Routes claim destination via relay path (destination mode / one-time account recommended).
6. Claims on behalf to routed destination or leaves buffered for authorized claim path.
7. Optionally redelegates.

## 5b. Privacy purge for old test data

Use this when you want to retire old streams and revoke old decrypt grants after moving to strict privacy defaults.

Dry-run preview:
```bash
cd /Users/sumangiri/Desktop/expensee
set -a; source /Users/sumangiri/Desktop/expensee/backend/keeper/.env; set +a
PURGE_OWNER_KEYPAIR_PATH=/absolute/path/to/employer-owner.json \
PURGE_REVOKE_WALLETS=<old_worker_wallet_1>,<old_worker_wallet_2> \
npm run privacy:purge
```

Execute live:
```bash
cd /Users/sumangiri/Desktop/expensee
set -a; source /Users/sumangiri/Desktop/expensee/backend/keeper/.env; set +a
PURGE_OWNER_KEYPAIR_PATH=/absolute/path/to/employer-owner.json \
PURGE_REVOKE_WALLETS=<old_worker_wallet_1>,<old_worker_wallet_2> \
PURGE_DRY_RUN=false \
PURGE_CONFIRM=YES_I_UNDERSTAND \
npm run privacy:purge
```

What it does:
- Scans all stream indices in your business.
- Commit+undelegates delegated streams.
- Deactivates active streams.
- Revokes view access for wallets listed in `PURGE_REVOKE_WALLETS` (when allowance accounts exist).

## 6. Vault Admin Withdraw (owner-only)

Use this when you want to recover unused funds from the payroll vault without resetting state.

UI path:
1. Open `/employer`.
2. In **2. Fund Vault**, open **Vault Admin Withdraw (Owner)**.
3. Enter amount + destination token account.
4. Submit **Withdraw Unused Funds from Vault**.

On-chain instruction:
- `admin_withdraw_vault_v2`

Notes:
- Only business owner can call it.
- Destination token account must match the same confidential mint as the vault mint.
- No program-id/env change is needed if your deployed `payroll` program id is unchanged.

## 7. Incident response

- Pause all streams: `pause_stream_v2(reason=1)`.
- Resume: `resume_stream_v2`.
- If delegated streams get stuck: ensure keeper `KEEPER_RPC_URL` points to router, and avoid delegating to `tee.magicblock.app` on devnet unless you have a token.

## 8. Monitoring checklist

- Keeper process liveness.
- Pending withdraw requests backlog.
- Dead-letter growth rate: `/Users/sumangiri/Desktop/expensee/backend/keeper/dead-letter.log`.
- RPC latency/error rate.
