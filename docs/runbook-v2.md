# Runbook: Expensee (Private Payroll v2, Devnet First)

This repo runs a **pull-based payroll** model with **Ghost Mode** privacy:
- Employee signs an off-chain message — the Keeper relays `keeper_request_withdraw_v2` on-chain (employee wallet never touches the blockchain).
- Keeper checkpoints accrual (`accrue_v2`), decrypts the accrued Inco handle (attested decrypt), re-encrypts as ciphertext, then pays out using `process_withdraw_request_v2` (1 tx on base layer, plus commit+undelegate if the stream is delegated).

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
- `KEEPER_COMPLIANCE_ENABLED=false` (default)
- `KEEPER_RANGE_API_KEY` (only if compliance enabled)

Run:
```bash
cd backend/keeper
npm install
npm start
```

## 5. Normal operations (MVP)

Employer:
1. Register business + init vault.
2. Init v2 stream config (keeper pubkey + settle interval).
   - If you need to rotate keeper later, use **Update Keeper (Rotate Hot Key)** in `/employer`.
3. Add employee stream v2 (fixed destination token account, encrypted salary rate).
4. Fund vault.
5. Optional: delegate stream to an ER validator (EU/US/Asia recommended on devnet).
6. Grant decrypt permissions (recommended for devnet demos):
   - Employee: call `grant_employee_view_access_v2` so they can use “Reveal Earnings”.
   - Keeper (if keeper is a separate hot wallet): call `grant_keeper_view_access_v2` so withdraw processing can decrypt salary-rate handle.

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
4. Decrypts what it needs via Inco attested decrypt and re-encrypts as ciphertext.
5. Calls `process_withdraw_request_v2` on base layer (confidential transfer of encrypted amount).
6. Optionally redelegates.

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
