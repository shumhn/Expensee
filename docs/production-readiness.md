# Production Readiness Checklist

This document tracks the minimum requirements before launching real payroll payouts.

## ✅ Completed (current state)
- End-to-end v4 flow works (setup → delegate → accrue → withdraw → claim → redelegate).
- PER/TEE execution path works for delegated streams.
- Keeper is running and automated accrual is live.
- Pooled vault + encrypted balances/IDs (Inco) are implemented.
- V4 events minimized by default.
- Logs redact TEE auth tokens.

## ⚠️ Required Before Real Payouts
1. Security review
   - External audit for on-chain program.
   - Internal review for keeper and scripts.
2. Key management
   - Move payer secrets to KMS/HSM.
   - Remove raw secrets from `.env` and repo.
3. Monitoring + alerting
   - Uptime (keeper + RPC) alerts.
   - Payout failure alerts.
   - Dead-letter queue monitoring.
4. Operational controls
   - Multisig for program upgrade authority.
   - Multisig for pooled vault authority.
   - Emergency pause/disable documented.
5. RPC resiliency
   - Primary + backup read RPCs.
   - Rate limit and retry policies tuned.
6. Compliance + policy
   - If compliance is required, wire Range policy config.
7. Backups + recovery
   - Keeper queue backups.
   - Runbook for replaying stuck payouts.

## Keeper Strict Mode
- Set `KEEPER_ENV=production` and `KEEPER_STRICT_STARTUP=true`.
- This will fail fast if:
  - `KEEPER_PAYER_SECRET_JSON` is set without `KEEPER_ALLOW_INLINE_SECRET_JSON=true`
  - TEE RPC is missing token
  - Umbra enforced route isn’t configured
  - `MONGODB_URI` is missing

## Optional Hardening
- Random sparse IDs to reduce count leakage.
- Batching/delayed commits to reduce timing metadata.
- Dedicated relayer to mask fee-payer identity.

## Current Reality Statement (for docs/marketing)
"Real-time private payroll with encrypted balances + PER/TEE execution, plus unavoidable on-chain metadata."
