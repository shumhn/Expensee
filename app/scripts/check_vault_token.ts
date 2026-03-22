import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const PAYROLL_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');

async function main() {
  const [masterVaultPDA] = PublicKey.findProgramAddressSync([Buffer.from("master_vault_v4b")], PAYROLL_PROGRAM_ID);
  const info = await connection.getAccountInfo(masterVaultPDA);
  if (!info) {
    console.log("Master vault not found at", masterVaultPDA.toBase58());
    return;
  }

  // MasterVaultV4 layout from lib.rs/state/v4.rs:
  // 8 (disc) + 32 (authority) + 32 (vault_token_account) + 32 (mint) + ...
  const data = info.data;
  const authority = new PublicKey(data.slice(8, 40));
  const vaultTokenAccount = new PublicKey(data.slice(40, 72));
  const mint = new PublicKey(data.slice(72, 104));

  console.log("Master Vault PDA:", masterVaultPDA.toBase58());
  console.log("Authority:", authority.toBase58());
  console.log("Vault Token Account:", vaultTokenAccount.toBase58());
  console.log("Mint:", mint.toBase58());

  // Also check if the app's BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT matches
  console.log("BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT from env:", process.env.BRIDGE_CONFIDENTIAL_ESCROW_TOKEN_ACCOUNT);
}

main().catch(console.error);
