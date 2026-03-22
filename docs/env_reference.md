# Expensee Environment Reference

This document provides a comprehensive reference for all environment variables used in the Expensee project.

## Component: App (`app/.env.local`)

These variables are primarily used by the Next.js application for interacting with the Solana blockchain and external APIs.

| Variable | Description | Example Value (onyx-fii) |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Main RPC endpoint for blockchain transactions. | `https://devnet.helius-rpc.com/...` |
| `NEXT_PUBLIC_SOLANA_READ_RPC_URL` | Optional fallback RPC for read operations. | Same as RPC URL |
| `NEXT_PUBLIC_PAYROLL_PROGRAM_ID` | Deployed payroll smart contract ID. | `3P3tYHEUykB2fH5vx...` |
| `NEXT_PUBLIC_INCO_PROGRAM_ID` | Inco FHE program ID. | `5sjEbPiqgZrYwR31...` |
| `NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID` | Inco confidential token program ID. | `4cyJHzecVWuU2xux...` |
| `NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM` | MagicBlock delegation program. | `DELeGGvXpWV2fqJUh...` |
| `NEXT_PUBLIC_PAYUSD_MINT` | Confidential PayUSD token mint address. | `4FVrXQpUPFKMtR2b...` |
| `NEXT_PUBLIC_KEEPER_API_URL` | URL of the backend Keeper service. | `https://onyxfii.onrender.com` |
| `NEXT_PUBLIC_BRIDGE_ENABLED` | Toggle for the public/confidential bridge UI. | `true` |

## Component: Keeper (`backend/keeper/.env`)

The Keeper is a Node.js service that automates confidential payroll claims and manages privacy-preserving payouts.

| Variable | Description | Example Value |
| :--- | :--- | :--- |
| `KEEPER_RPC_URL` | MagicBlock router RPC for fast transaction processing. | `https://devnet-router.magicblock.app` |
| `KEEPER_PROGRAM_ID` | Same as `NEXT_PUBLIC_PAYROLL_PROGRAM_ID`. | `3P3tYHEUykB2fH5vx...` |
| `KEEPER_PAYER_KEYPAIR_PATH` | Path to the JSON keypair for the keeper's payer. | `~/.config/solana/id.json` |
| `MONGODB_URI` | Connection string for persistent storage of claim states. | `mongodb+srv://...` |
| `MONGODB_DB_NAME` | Database name for the keeper service. | `expensee` |

## AI Integration Variables

The project uses several AI models for financial assistance and audit automation.

- `GEMINI_API_KEY`: Google Gemini Pro for reasoning tasks.
- `GROQ_API_KEY`: Groq for low-latency Llama-3 inference.
- `OPENROUTER_API_KEY`: OpenRouter for accessing a variety of LLMs.

## Bridge & Escrow (Demo Mode)

- `BRIDGE_ESCROW_KEYPAIR_PATH`: Secret key array for the escrow authority.
- `BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT`: Inco account that receives confidential tokens.

---
*Note: Sensitive variables like API keys and secret keys should NEVER be committed to version control.*
