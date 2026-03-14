# Expensee Frontend

Frontend for the v4 pooled-vault privacy flow (index-based PDAs + Inco FHE).

## Active pages

- `/` Landing and product entry
- `/employer` Business/vault/v4 setup and controls (default)
- `/employee` v4 payroll status + withdraw request (default)

Legacy consoles (advanced):
- `/employer-v3` Legacy v3 console
- `/employee-v3` Legacy v3 portal
- `/employer-v2` Legacy v2 console (deprecated)
- `/employee-v2` Legacy v2 portal (deprecated)

## Core behavior

- Uses `lib/payroll-client.ts` v4 instruction set for new flows.
- Index-based PDAs for privacy (no employee pubkey in PDA seeds).
- Pooled vault model: a single global vault token account + per-business encrypted balances.
- Encrypted metadata (counts, balances, IDs, salary) via Inco Lightning.
- Employees submit a withdraw request; keeper processes and buffers payouts; employee claims.

## Run

```bash
npm install
npm run dev
```

## Required env

Copy `.env.local.example` to `.env.local` and set:
- `NEXT_PUBLIC_SOLANA_RPC_URL`
- `NEXT_PUBLIC_SOLANA_READ_RPC_URL` (optional)
- `NEXT_PUBLIC_PAYROLL_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID`
- `NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM`
- `NEXT_PUBLIC_PAYUSD_MINT`
- `NEXT_PUBLIC_COMPLIANCE_ENABLED` (optional)
- `NEXT_PUBLIC_RANGE_API_KEY` (optional)
