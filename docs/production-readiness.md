# Production Readiness Checklist

This repo is currently a devnet MVP. Before real payroll payouts, treat the following as required work.

## Current State

- V4 pooled vault, business, employee, withdraw request, and shielded payout accounts are implemented.
- Inco Lightning handles are used for encrypted payroll values.
- MagicBlock delegation, crank scheduling, commit/undelegate, and redelegate paths are implemented.
- Employer and employee dashboards are wired through the Next.js app.
- Devnet helper scripts exist under `scripts/`.
- The public/confidential bridge is a custodial devnet demo, not a trustless bridge.

## Required Before Real Payouts

1. External security audit for the Anchor program.
2. Internal review of Next.js API routes and devnet scripts.
3. Multisig for program upgrade authority.
4. Multisig or stronger operational controls for pooled-vault authority.
5. KMS/HSM-backed key management for any server-side bridge keys.
6. Remove or isolate devnet-only APIs from production deploys.
7. RPC failover, retry policy, and transaction monitoring.
8. Payout failure monitoring and recovery runbooks.
9. Compliance policy decision and Range integration review if compliance is enabled.
10. Clear disclosure that MagicBlock TEE execution is part of the privacy/security model.

## Optional Hardening

- Sparse/randomized business and employee IDs to reduce count leakage.
- Delayed or batched settlement to reduce timing metadata.
- Dedicated fee-payer or relayer strategy if transaction fee-payer privacy matters.
- Formal invariant tests for vault balance, reserved balance, payout claim, and cancellation flows.

## Current Reality Statement

"Expensee is a devnet private payroll MVP with encrypted payroll records, pooled vault payouts, Inco confidential token flows, and MagicBlock-assisted stream execution. It is not production payroll infrastructure yet."
