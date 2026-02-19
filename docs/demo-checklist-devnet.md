# Demo Checklist (Devnet): Prove MagicBlock + Inco Are Working

This is a step-by-step checklist you can follow to produce a **credible demo** showing:

- **Inco privacy**: salary rate + accrued amounts are **not plaintext on-chain** (handles only).
- **MagicBlock impact**: delegated streams run **accrual checkpoint inside ER**, then **commit+undelegate** to settle on the base layer only when needed.
- **Low base-layer tx count**: payouts happen **only on withdraw request**, not every 10 seconds.

---

## 0) Preconditions

1. Program is deployed/upgraded on devnet.
   - Program ID (devnet): `CgRkrU26uERpZEPXUQ2ANXgPMFHXPrX4bFaM5UHFdPEh`
2. Compliance is disabled on devnet (recommended).
   - App: `NEXT_PUBLIC_COMPLIANCE_ENABLED=false`
   - Keeper: `KEEPER_COMPLIANCE_ENABLED=false`
3. Do **not** delegate to `tee.magicblock.app` on devnet unless you have a TEE token.
   - Use EU/US/Asia validator identities (default here is EU):
     - `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e`

---

## 1) Run App + Keeper

### App
```bash
cd /Users/sumangiri/Desktop/expensee/app
npm install
npm run dev
```

### Keeper
```bash
cd /Users/sumangiri/Desktop/expensee/services/keeper
npm install
set -a; source .env; set +a
npm start
```

Keeper must use **dual RPC**:
- `KEEPER_READ_RPC_URL`: normal Solana devnet RPC (must support `getProgramAccounts`)
- `KEEPER_RPC_URL`: MagicBlock router (for delegated lifecycle txs)
  - `https://devnet-router.magicblock.app`

### Optional: One-Command Bootstrap (CLI)

If you want to bootstrap accounts + stream from the terminal (and optionally mint+deposit if you control the mint authority):

```bash
cd /Users/sumangiri/Desktop/expensee
set -a; source /Users/sumangiri/Desktop/expensee/services/keeper/.env; set +a
SETUP_MINT_AUTHORITY_KEYPAIR_PATH=/Users/sumangiri/Desktop/expensee/keys/payroll-authority.json \
SETUP_MINT_UI=100 \
SETUP_DEPOSIT_UI=50 \
node /Users/sumangiri/Desktop/expensee/app/scripts/setup-v2-stream.cjs
```

---

## 2) Employer Flow (UI)

Go to `http://localhost:3000/employer` and connect **Employer wallet**.

1. **Register Business**
2. **Create Vault Token Account**
   - Click `Create Vault Token Account`
   - This creates an Inco confidential token account owned by your vault PDA.
3. **Initialize Vault**
   - Paste auto-filled vault token account (if needed)
   - Click `Initialize Vault`
4. **Create My Source Token Account**
   - Click `Create My Source Token Account`
   - This is the account you deposit from.
5. **Fund Source Token Account**
   - You need some payUSD tokens (the mint configured in `.env.local` as `NEXT_PUBLIC_PAYUSD_MINT`).
   - If you created/own the mint authority, you can mint to your source token account:
     ```bash
     cd /Users/sumangiri/Desktop/expensee
     set -a; source app/.env.local; set +a
     DEST_TOKEN_ACCOUNT=YOUR_SOURCE_TOKEN_ACCOUNT AMOUNT=100 node app/scripts/mint-payusd.cjs
     ```
     If your mint authority is not `~/.config/solana/id.json`, set:
     - `MINT_AUTHORITY_KEYPAIR_PATH=/path/to/keypair.json`

   - If you do NOT control the mint authority for the configured mint:
     - Create a new confidential mint you control (devnet):
       ```bash
       cd /Users/sumangiri/Desktop/expensee
       MINT_AUTHORITY_KEYPAIR_PATH=/Users/sumangiri/Desktop/expensee/keys/payroll-authority.json \
       npx ts-node scripts/create-new-mint.ts
       ```
     - Update `NEXT_PUBLIC_PAYUSD_MINT` in:
       - `/Users/sumangiri/Desktop/expensee/app/.env.local`
       - `/Users/sumangiri/Desktop/expensee/services/keeper/.env` (via `NEXT_PUBLIC_PAYUSD_MINT` only if you reference it elsewhere; keeper uses on-chain vault mint)
     - Restart app + keeper, then mint to your source token account using `app/scripts/mint-payusd.cjs`.
6. **Deposit to Vault**
   - Paste your source token account
   - Choose amount
   - Click `Deposit to Vault`
7. **Init v2 Config**
   - `Keeper pubkey` must be the payer pubkey used by the keeper service.
   - `Settle interval` can stay `10` (it’s a rate-limit guard; payouts are still withdraw-driven).
8. **Add Employee Stream**
   - Use a real employee wallet you control (or click `Use My Wallet as Employee (Demo)`).
   - Click `Create Employee Destination Token Account` to generate the employee’s confidential token account.
   - Click `Create Employee Stream v2`.
   - Note the `Stream index` used.
9. **(Optional) Delegate Stream**
   - Enter stream index.
   - Click `Delegate to MagicBlock ER Validator`.

---

## 3) Employee Flow (UI)

Go to `http://localhost:3000/employee` and connect the **Employee wallet**.

1. Paste employer wallet address.
2. Enter the stream index.
3. Click `Load Stream Status`.
4. Click `Request Withdraw (Withdraw-all)`.

This creates a `WithdrawRequestV2` PDA. No payout happens until keeper processes it.

---

## 4) What “Success” Looks Like (Logs)

### Keeper logs (must appear)

Undelegated stream:
- `process_withdraw_request_v2 tx=...`
- `Processed withdraw_request=...`

Delegated stream (MagicBlock impact):
- `Routing stream=... to delegated ER endpoint=...`
- `accrue_v2 tx=... rpc=https://devnet-*.magicblock.app` (ER-side checkpoint)
- `commit_and_undelegate_stream_v2 tx=... rpc=https://devnet-*.magicblock.app`
- `Waiting undelegate ...`
- `process_withdraw_request_v2 tx=... rpc=<solana rpc>`
- optional: `redelegate_stream_v2 tx=...`

Optional debug (local only):
- set `KEEPER_LOG_PLAINTEXT_AMOUNTS=true`
- you’ll see `accrued_plaintext ... amount=...` in keeper logs

---

## 5) Proof Artifacts (Screenshots/Video)

Capture:
1. Employer screen: stream created + delegated.
2. Employee screen: withdraw request submitted (tx id shown).
3. Keeper terminal logs showing:
   - ER routing + commit+undelegate (MagicBlock)
   - withdraw processing tx signature (base layer)
4. Explorer:
   - The withdraw processing transaction includes an Inco confidential transfer CPI.
   - Amount/rate are not visible as plaintext on the payroll stream account (handles only).

---

## 6) One-Line Demo Claim (Honest)

“Employees earn continuously in private (Inco handles). When they request a withdrawal, our Expensee keeper checkpoints accrual in MagicBlock ER, commits state back to devnet, and settles a single confidential payout to a fixed destination token account.”
