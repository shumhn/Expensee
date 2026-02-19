# Expensee Frontend

Frontend for the v2 private payroll flow (Expensee pivot: real-time accrual + on-demand withdraw).

## Active pages

- `/` Landing and product entry
- `/employer` Business/vault/v2 stream setup and controls
- `/employee` Stream status + withdraw request

## Core behavior

- Uses `app/lib/payroll-client.ts` v2 instruction set for new flows.
- Optional compliance gating for stream creation (disabled by default on devnet/local).
- Uses fixed destination token account per stream.
- Employees submit a withdraw request; keeper processes and pays out to the fixed destination token account.

## Run

```bash
npm install
npm run dev
```

## Required env

Copy `app/.env.local.example` to `app/.env.local` and set:
- `NEXT_PUBLIC_SOLANA_RPC_URL`
- `NEXT_PUBLIC_SOLANA_READ_RPC_URL` (optional)
- `NEXT_PUBLIC_PAYROLL_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_PROGRAM_ID`
- `NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID`
- `NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM`
- `NEXT_PUBLIC_PAYUSD_MINT`
- `NEXT_PUBLIC_COMPLIANCE_ENABLED` (optional)
- `NEXT_PUBLIC_RANGE_API_KEY` (optional)
