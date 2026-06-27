# Demo Checklist: Devnet V4

Use this checklist to demo what exists in this repo: the v4 pooled-vault payroll flow, Inco confidential values, MagicBlock delegation, and shielded payout claim.

## Preconditions

1. Program is deployed on devnet:
   - `97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU`
2. Copy app env:
   ```bash
   cp app/.env.local.example app/.env.local
   ```
3. Set `NEXT_PUBLIC_PAYUSD_MINT` or `NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT` to a devnet confidential mint you control.
4. Keep compliance disabled for demos unless you have a configured Range key:
   ```bash
   NEXT_PUBLIC_COMPLIANCE_ENABLED=false
   ```
5. Do not use `tee.magicblock.app` without a TEE auth token. The default ER validator is:
   - `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e`

## Run The App

```bash
cd app
npm install
npm run dev
```

Open `http://localhost:3000`.

## Optional CLI Bootstrap

The current v4 bootstrap script is:

```bash
node scripts/setup-v4-pooled.cjs
```

The full devnet flow runner is:

```bash
npm run flow:v4
```

Useful individual scripts:

- `scripts/v4-request-withdraw.cjs`
- `scripts/v4-withdraw-flow.cjs`
- `scripts/v4-claim-payout.cjs`
- `scripts/v4-delegate-cycle.cjs`
- `scripts/v4-crank-e2e.cjs`
- `scripts/verify-er-state.mjs`

## Employer UI Flow

Go to `http://localhost:3000/employer` and connect the employer wallet.

1. Initialize or load `MasterVaultV4`.
2. Create or link the pooled vault Inco token account.
3. Register a `BusinessEntryV4`.
4. Initialize `BusinessStreamConfigV4`.
5. Create or link your source Inco token account.
6. Deposit confidential payroll tokens into the pooled vault with `deposit_v4`.
7. Add an employee with `add_employee_v4`.
8. Grant employee view access when you want the employee to reveal earnings.
9. Optionally delegate the stream to MagicBlock with `delegate_stream_v4`.
10. Optionally schedule or run crank settlement with `schedule_crank_v4` / `crank_settle_v4`.

## Employee UI Flow

Go to `http://localhost:3000/employee` and connect the employee wallet.

1. Use Magic Scan or enter business/employee indexes manually.
2. Load the employee record.
3. Reveal earnings if view access has been granted.
4. Request withdrawal with `request_withdraw_v4`.
5. If the stream is delegated, commit/undelegate first.
6. Process withdrawal into a `ShieldedPayoutV4`.
7. Claim the payout with `claim_payout_v4`.
8. Redelegate after settlement if you want streaming to continue in ER.

## Proof Artifacts

Capture:

1. Employer screen showing business, vault, and employee record.
2. Employee screen showing Magic Scan or loaded employee record.
3. MagicBlock delegation status before/after commit.
4. Explorer transaction for deposit or payout showing Inco confidential transfer CPI.
5. Account data showing encrypted handles instead of plaintext salary/balance values.

## Honest Demo Claim

"Expensee demonstrates v4 private payroll on Solana devnet: employers fund a pooled confidential vault, employees are indexed by encrypted identity handles, MagicBlock can accelerate stream accrual, and withdrawals settle through shielded payout accounts."
