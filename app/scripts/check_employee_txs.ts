import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const PAYROLL_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');

const businessIndex = 0; 
const employeeIndex = 1; 

const masterVaultPDA = PublicKey.findProgramAddressSync([Buffer.from("master_vault")], PAYROLL_PROGRAM_ID)[0];

const businessIndexBuf = Buffer.alloc(8);
businessIndexBuf.writeBigUInt64LE(BigInt(businessIndex));
const businessPDA = PublicKey.findProgramAddressSync([Buffer.from("business"), masterVaultPDA.toBuffer(), businessIndexBuf], PAYROLL_PROGRAM_ID)[0];

const employeeIndexBuf = Buffer.alloc(8);
employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
const employeePDA = PublicKey.findProgramAddressSync([Buffer.from("employee"), businessPDA.toBuffer(), employeeIndexBuf], PAYROLL_PROGRAM_ID)[0];

async function main() {
  const sigs = await connection.getSignaturesForAddress(employeePDA, { limit: 5 });
  console.log(`Last 5 txs for ${employeePDA.toBase58()}:`);
  for (const sig of sigs) {
    console.log(`- ${sig.signature} (err: ${sig.err ? JSON.stringify(sig.err) : 'none'})`);
    if (sig.err) {
      const tx = await connection.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      console.log(`  Logs:`, tx?.meta?.logMessages);
    }
  }
}

main().catch(console.error);
