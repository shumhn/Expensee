#!/bin/bash
# Remove stale Vercel env variables

echo "Removing stale variables..."

rm_env() {
  local key=$1
  echo "Removing $key..."
  echo "y" | npx vercel env rm "$key" production --yes || true
  echo "y" | npx vercel env rm "$key" preview --yes || true
  echo "y" | npx vercel env rm "$key" development --yes || true
}

rm_env "NEXT_PUBLIC_DEFAULT_KEEPER_PUBKEY"
rm_env "NEXT_PUBLIC_MASTER_AUTHORITY"
rm_env "NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL"
rm_env "BRIDGE_PAYUSD_MINT_AUTHORITY_KEYPAIR_PATH"
rm_env "MINT_AUTHORITY_KEYPAIR_PATH"

echo "Cleanup completed!"
