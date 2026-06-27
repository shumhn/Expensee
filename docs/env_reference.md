# Expensee Environment Reference

This repo contains the Anchor program, the main Next.js app, the landing page, and devnet helper scripts.

## App: `app/.env.local`

| Variable | Description | Example |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Main Solana RPC used by the app for transactions. | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_SOLANA_READ_RPC_URL` | Optional read fallback RPC. | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_PAYROLL_PROGRAM_ID` | Deployed Expensee payroll program. | `97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU` |
| `NEXT_PUBLIC_INCO_PROGRAM_ID` | Inco Lightning program. | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` |
| `NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID` | Inco confidential token program. | `4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N` |
| `NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM` | MagicBlock delegation program. | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| `NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM` | MagicBlock scheduling program. | `Magic11111111111111111111111111111111111111` |
| `NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT` | MagicBlock global context account. | devnet context pubkey |
| `NEXT_PUBLIC_MAGICBLOCK_VALIDATOR` | Default ER validator identity for stream delegation. | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| `NEXT_PUBLIC_MAGICBLOCK_ENDPOINT` | MagicBlock endpoint used for ER/router calls. | `https://devnet-router.magicblock.app` |
| `NEXT_PUBLIC_MAGICBLOCK_TEE_URL` | Token-gated TEE RPC endpoint. | `https://tee.magicblock.app` |
| `NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED` | Enables TEE-authenticated transaction routing in app flows. | `true` |
| `NEXT_PUBLIC_PAYUSD_MINT` | Confidential payroll token mint. | devnet mint pubkey |
| `NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT` | Optional alias/override for the confidential mint. | devnet mint pubkey |
| `NEXT_PUBLIC_COMPLIANCE_ENABLED` | Enables Range compliance checks in supported flows. | `false` |
| `NEXT_PUBLIC_RANGE_API_KEY` | Range API key when compliance is enabled. | optional |
| `NEXT_PUBLIC_PRIVACY_ID_SALT` | Optional salt for hashed employer/employee IDs. | optional |
| `MONGODB_URI` | Optional storage for AI assistant run state. | optional |
| `MONGODB_DB_NAME` | MongoDB database name. | `expensee` |

## AI Assistant

The app can use these optional provider keys for `/api/agent/*` routes:

- `GROQ_API_KEY`
- `GROQ_AGENT_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_AGENT_MODEL`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`

Without provider keys, the planner falls back to heuristic behavior where available.

## Bridge Demo

The `/bridge` page and bridge API routes are optional and custodial. They require server-controlled escrow and mint-authority keypairs.

| Variable | Description |
| :--- | :--- |
| `NEXT_PUBLIC_BRIDGE_ENABLED` | Turns bridge UI/API usage on. |
| `NEXT_PUBLIC_PUBLIC_USDC_MINT` | Public SPL token mint used for demo deposits/withdrawals. |
| `BRIDGE_SOLANA_RPC_URL` | RPC used by bridge API routes. |
| `BRIDGE_PUBLIC_DECIMALS` | Decimals for public token side. |
| `BRIDGE_CONFIDENTIAL_DECIMALS` | Decimals for confidential token side. |
| `BRIDGE_ESCROW_KEYPAIR_PATH` | Escrow signer keypair path or inline JSON array. |
| `BRIDGE_CONFIDENTIAL_USDC_MINT_AUTHORITY_KEYPAIR_PATH` | Confidential mint authority keypair path or inline JSON array. |
| `BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT` | Escrow's Inco token account for unwrap flows. |

Do not commit real secrets or production keypairs.
