// Centralized endpoint guardrails for MagicBlock router and ER RPC usage.
const MAGICBLOCK_ALLOWED_HOSTS = new Set([
  'devnet-router.magicblock.app',
  'devnet-eu.magicblock.app',
  'devnet-us.magicblock.app',
  'devnet-as.magicblock.app',
  'tee.magicblock.app',
  'devnet.helius-rpc.com',
  'api.devnet.solana.com',
]);

export function normalizeMagicblockEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  if (url.protocol !== 'https:') {
    throw new Error('Only https endpoints are allowed');
  }
  if (!MAGICBLOCK_ALLOWED_HOSTS.has(url.host)) {
    throw new Error(`Endpoint host not allowed: ${url.host}`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function getMagicblockRouterRpcUrl(): string {
  return normalizeMagicblockEndpoint(
    process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_RPC_URL ||
      process.env.MAGICBLOCK_ROUTER_RPC_URL ||
      'https://devnet-router.magicblock.app'
  );
}

export { MAGICBLOCK_ALLOWED_HOSTS };
