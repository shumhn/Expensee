# Public Entry/Exit Demo (Devnet): USDC In, Private Payroll Middle, USDC Out

This demo runbook explains how to *tell the real-world story*:

- **Public entry**: a company moves funds on-chain in a normal (public) stablecoin.
- **Private middle**: payroll streams happen in a confidential stablecoin-like token (Inco).
- **Public exit**: employees optionally cash out back to a public token.

Important limitations:
- On Solana devnet there is no canonical “real USDC” integration for confidential transfers. So for demo purposes we use a **public demo stablecoin mint** (`pUSDC`) plus a **custodial wrap/unwrap** step.
- This is exactly how real systems work operationally: a *trusted* custodian/issuer (or exchange) wraps/unwraps between public tokens and confidential tokens.

## 1) Create a Public Demo Stablecoin (pUSDC)

This uses the standard SPL Token program (public amounts).

```bash
solana config set --url devnet

# Create a public demo mint (6 decimals like USDC)
spl-token create-token --decimals 6
```

If `spl-token` is not working in your environment, you can use the repo helper instead:

```bash
RPC_URL=https://api.devnet.solana.com \
FEE_PAYER_KEYPAIR_PATH=keys/payroll-authority.json \
AMOUNT=1000 \
node app/scripts/create-public-usdc-mint.cjs
```

Copy the printed mint address and export it:

```bash
export PUBLIC_USDC_MINT=PASTE_MINT_ADDRESS_HERE
```

Create your associated token account (ATA) and mint yourself some pUSDC:

```bash
spl-token create-account $PUBLIC_USDC_MINT

# Mint 1000 "USDC" to your public token account (requires mint authority = your wallet)
spl-token mint $PUBLIC_USDC_MINT 1000
```

## 2) Wrap: Public pUSDC -> Confidential cUSDC-like (payUSD mint)

In Expensee, the confidential token is `NEXT_PUBLIC_PAYUSD_MINT` (an Inco payUSD mint).

For devnet demo, “wrap” is custodial:

1. You send pUSDC to a known escrow address (operator-controlled).
2. The operator mints you the same amount of confidential token to your **Inco source token account**.

You can do this either:
- via CLI (steps below), or
- via the app bridge UI: `http://localhost:3000/bridge` (requires bridge env vars).

### 2a) Send pUSDC to escrow (public)

Pick an escrow address you control (for demo, you can use your own wallet pubkey):

```bash
export PUBLIC_ESCROW_ADDRESS=PASTE_ESCROW_WALLET_PUBKEY
spl-token transfer $PUBLIC_USDC_MINT 100 $PUBLIC_ESCROW_ADDRESS --fund-recipient
```

### 2b) Mint confidential token to your Inco source token account (private middle funding)

This is the existing helper:

```bash
DEST_TOKEN_ACCOUNT=YOUR_INCO_SOURCE_TOKEN_ACCOUNT \
MINT_AUTHORITY_KEYPAIR_PATH=keys/payroll-authority.json \
AMOUNT=100 \
node app/scripts/mint-payusd.cjs
```

Now you can deposit into the Expensee vault from the Employer UI:
- Create your source Inco token account (if needed)
- Deposit to vault

## 3) Run Private Payroll (confidential middle)

Use the app as normal:

Employer:
- Create employee stream (optionally bounded month/week)
- Optionally delegate to MagicBlock ER validator (EU/US/Asia recommended on devnet)
- Grant employee decrypt access (so they can “Reveal Earnings”)

Employee:
- Reveal earnings (attested decrypt)
- Request withdraw

Keeper:
- Processes withdraw request
- If delegated: commit+undelegate -> settle -> redelegate

## 4) Unwrap: Confidential -> Public pUSDC (optional cash out)

For demo, “unwrap” is custodial:

1. Employee transfers confidential token to an operator-controlled Inco token account (private transfer).
2. Operator transfers pUSDC from escrow back to the employee’s public token account (public).

If you use the `/bridge` page, make sure you created an escrow Inco token account once:

```bash
node app/scripts/create-bridge-escrow-confidential-account.cjs
```

This is the unavoidable tradeoff on public chains:
- The *cash-out* amount becomes public when moving back into public tokens.

## What This Proves

1. **Public proof**: companies can show they moved a public stablecoin amount on-chain (auditability).
2. **Private payroll**: salary rates/accrual/payout amounts are encrypted during payroll operations (Inco).
3. **Zebec-like UX**: earnings grow continuously and employees withdraw on demand (no per-second transfers).
4. **MagicBlock impact**: when streams are delegated, settlement uses commit/undelegate/redelegate (ER-first lifecycle).

## Why Businesses Want This

1. Salary privacy prevents competitor poaching and eliminates “glass worker” compensation leaks.
2. Raises/bonuses can happen without broadcasting internal compensation changes to the entire internet.
3. Public entry/exit is a feature:
   - Auditors can still verify funds moved in/out.
   - Employees still have a clean public cash-out trail if they need it.
