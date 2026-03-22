import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local' });

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

const PAYROLL_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');

const businessIndex = 0; // Guessing index 0
const employeeIndex = 0; // Guessing index 0

const masterVaultPDA = PublicKey.findProgramAddressSync([Buffer.from("master_vault")], PAYROLL_PROGRAM_ID)[0];

const businessIndexBuf = Buffer.alloc(8);
businessIndexBuf.writeBigUInt64LE(BigInt(businessIndex));
const businessPDA = PublicKey.findProgramAddressSync([Buffer.from("business"), masterVaultPDA.toBuffer(), businessIndexBuf], PAYROLL_PROGRAM_ID)[0];

const employeeIndexBuf = Buffer.alloc(8);
employeeIndexBuf.writeBigUInt64LE(BigInt(employeeIndex));
const employeePDA = PublicKey.findProgramAddressSync([Buffer.from("employee"), businessPDA.toBuffer(), employeeIndexBuf], PAYROLL_PROGRAM_ID)[0];

async function main() {
  const info = await connection.getAccountInfo(employeePDA, 'confirmed');
  console.log("Employee PDA:", employeePDA.toBase58());
  if (info) {
    console.log("Owner:", info.owner.toBase58());
    console.log("Expected:", PAYROLL_PROGRAM_ID.toBase58());
    console.log("Equals:", info.owner.equals(PAYROLL_PROGRAM_ID));
  } else {
    console.log("Account not found");
  }
}

main().catch(console.error);
