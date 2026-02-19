# Keeper Service (Expensee: Withdraw-Request Mode)

This service processes **pending withdraw requests**:

1. Scan `WithdrawRequestV2` accounts that are `is_pending=true`
2. If the stream is delegated: `commit_and_undelegate_stream_v2` via MagicBlock router, wait for callback
3. Checkpoint accrual on base layer via `accrue_v2`
4. Decrypt the accrued Inco Lightning handle (attested decrypt) and re-encrypt as ciphertext
5. Settle on base layer via `process_withdraw_request_v2` (confidential transfer of encrypted amount)
6. Optionally `redelegate_stream_v2`

It enforces:
- 10s scheduler with per-stream jitter
- idempotency per `(withdraw_request_pda, requested_at)`
- retry with exponential backoff
- optional compliance policy (Range) if enabled
- dead-letter logging + optional alert webhook

## Required env

Copy and edit `backend/keeper/.env.example`.

Critical required values:
- `KEEPER_RPC_URL`
- `KEEPER_READ_RPC_URL`
- `KEEPER_PROGRAM_ID`
- `KEEPER_PAYER_KEYPAIR_PATH` (or `KEEPER_PAYER_SECRET_JSON`)

Optional (recommended defaults are in `.env.example`):
- `KEEPER_ROUTER_RPC_URL`
- `KEEPER_VALIDATOR`
- `KEEPER_REDELEGATE_AFTER_WITHDRAW`
- `KEEPER_COMPLIANCE_ENABLED` (default: false)
- `KEEPER_RANGE_API_KEY` (only if compliance enabled)

## Run

From repo root:

```bash
cd app
npm install

set -a
source backend/keeper/.env.example
set +a
npx ts-node backend/keeper/src/index.ts
```

## Operational notes

- Caller must be authorized as stream keeper (or business owner).
- Keeper processes at most `KEEPER_MAX_STREAMS_PER_TICK` per interval.
- Failures are appended to `KEEPER_DEAD_LETTER_FILE`.
- If consecutive tick failures exceed `KEEPER_MAX_CONSECUTIVE_FAILURES`, circuit breaker opens.
