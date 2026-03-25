#!/bin/bash
# Push env variables to Vercel (no interactive prompts)
set -e

echo "Pushing ENV to Vercel (Production only)..."

add_env() {
  local key=$1
  local val=$2
  echo "  → $key"
  npx vercel env rm "$key" production --yes 2>/dev/null || true
  printf '%s' "$val" | npx vercel env add "$key" production --yes --force
}

add_env "NEXT_PUBLIC_SOLANA_RPC_URL" "https://api.devnet.solana.com"
add_env "NEXT_PUBLIC_SOLANA_READ_RPC_URL" "https://api.devnet.solana.com"
add_env "NEXT_PUBLIC_PAYROLL_PROGRAM_ID" "97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU"
add_env "NEXT_PUBLIC_INCO_PROGRAM_ID" "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
add_env "NEXT_PUBLIC_INCO_TOKEN_PROGRAM_ID" "4cyJHzecVWuU2xux6bCAPAhALKQT8woBh4Vx3AGEGe5N"
add_env "NEXT_PUBLIC_MAGICBLOCK_DELEGATION_PROGRAM" "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
add_env "NEXT_PUBLIC_MAGICBLOCK_MAGIC_PROGRAM" "Magic11111111111111111111111111111111111111"
add_env "NEXT_PUBLIC_MAGICBLOCK_MAGIC_CONTEXT" "MagicContext1111111111111111111111111111111"
add_env "NEXT_PUBLIC_MAGICBLOCK_VALIDATOR" "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e"
add_env "NEXT_PUBLIC_MAGICBLOCK_TEE_VALIDATOR" "FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA"
add_env "NEXT_PUBLIC_MAGICBLOCK_ENDPOINT" "https://devnet.magicblock.app"
add_env "NEXT_PUBLIC_MAGICBLOCK_VALIDATOR_REGION" "eu"
add_env "NEXT_PUBLIC_MAGICBLOCK_TEE_URL" "https://tee.magicblock.app"
add_env "NEXT_PUBLIC_MAGICBLOCK_TEE_ENABLED" "true"
add_env "NEXT_PUBLIC_PAYUSD_MINT" "9j6MAQTA1TbmM2a1NDDdW8yxqvp7geZosEPoHVEJSEWz"
add_env "NEXT_PUBLIC_CONFIDENTIAL_USDC_MINT" "9j6MAQTA1TbmM2a1NDDdW8yxqvp7geZosEPoHVEJSEWz"
add_env "NEXT_PUBLIC_PUBLIC_USDC_MINT" "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
add_env "NEXT_PUBLIC_COMPLIANCE_ENABLED" "false"
add_env "NEXT_PUBLIC_DEBUG" "false"
add_env "SETUP_AUTO_DELEGATE" "true"
add_env "NEXT_PUBLIC_ENABLE_LEGACY_V2" "false"
add_env "NEXT_PUBLIC_ENABLE_LEGACY_V3" "false"
add_env "NEXT_PUBLIC_BRIDGE_ENABLED" "true"
add_env "ENABLE_DEVNET_SCRIPTS" "true"
add_env "NEXT_PUBLIC_PRIVACY_ID_SALT" "expensee-devnet-2026-03-13"
add_env "BRIDGE_SOLANA_RPC_URL" "https://api.devnet.solana.com"
add_env "BRIDGE_PUBLIC_DECIMALS" "6"
add_env "BRIDGE_CONFIDENTIAL_DECIMALS" "9"
add_env "BRIDGE_ESCROW_KEYPAIR_PATH" 'your_escrow_keypair_bytes_here'
add_env "BRIDGE_CONFIDENTIAL_USDC_MINT_AUTHORITY_KEYPAIR_PATH" 'your_usdc_mint_authority_bytes_here'
add_env "BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT" "EmUPqCnjh2euzqu3NDFZTzXrXSsWWY9sUVqhoj7FPVz4"
add_env "BRIDGE_CONFIDENTIAL_USDC_MINT" "9j6MAQTA1TbmM2a1NDDdW8yxqvp7geZosEPoHVEJSEWz"
add_env "GROQ_AGENT_MODEL" "llama-3.3-70b-versatile"
add_env "GROQ_BASE_URL" "https://api.groq.com/openai/v1"
add_env "GROQ_API_KEY" "your_groq_api_key_here"
add_env "MONGODB_DB_NAME" "expensee"
add_env "MONGODB_URI" "mongodb+srv://user:pass@cluster.mongodb.net/"
add_env "NEXT_PUBLIC_MASTER_AUTHORITY" "2QrwExUdu93o8mSdfEh6kvbNLTbN1UnVRrfyjQsDSUPE"
add_env "NEXT_PUBLIC_DEFAULT_KEEPER_PUBKEY" "2QrwExUdu93o8mSdfEh6kvbNLTbN1UnVRrfyjQsDSUPE"
add_env "NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL" "https://devnet-router.magicblock.app"
add_env "MINT_AUTHORITY_KEYPAIR_PATH" "keys/payroll-authority.json"

echo ""
echo "All Vercel environment variables pushed successfully!"
