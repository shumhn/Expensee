import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { encryptValue, COVALIDATOR_PUBLIC_KEY_INSTANCE } from '@inco/solana-sdk';
import {
  initMasterVaultV4,
  registerBusinessV4,
  initStreamConfigV4,
  addEmployeeV4,
  getMasterVaultV4Account,
} from '../lib/payroll-client';
import { WalletContextState } from '@solana/wallet-adapter-react';

const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(rpcUrl, 'confirmed');

const payerPath = path.resolve(__dirname, '../../keys/payroll-authority.json');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, 'utf8'))));

// Mock Wallet Context
const mockWallet = {
  publicKey: payer.publicKey,
  signTransaction: async (tx: any) => { tx.sign(payer); return tx; },
  signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.sign(payer)); return txs; },
} as WalletContextState;

async function run() {
  console.log('--- Devnet V4 Seeder ---');
  console.log('Wallet:', mockWallet.publicKey!.toBase58());

  let mv = await getMasterVaultV4Account(connection).catch(() => null);
  if (!mv) {
    console.log('1. Init Master Vault...');
    await initMasterVaultV4(connection, mockWallet);
    mv = await getMasterVaultV4Account(connection);
  } else {
    console.log('1. Master Vault EXISTS:', mv.address.toBase58());
  }

  console.log('2. Registering Business...');
  const { businessPDA, businessIndex } = await registerBusinessV4(connection, mockWallet, mockWallet.publicKey);
  console.log(`   Business ${businessIndex}: ${businessPDA.toBase58()}`);

  console.log('3. Init Stream Config...');
  await initStreamConfigV4(connection, mockWallet, businessPDA, 30);
  console.log('   Stream config established.');

  console.log('4. Adding Employee...');
  const empWallet = new PublicKey('Dipdwfe51x8SeKhpfprF2tuKP97SgbVWvZ1Pif8R1tmR'); // Random wallet
  const salaryLamports = 5_000_000_000n; // 5k USDC
  const now = Math.floor(Date.now() / 1000);

  const { txid, employeePDA, employeeIndex } = await addEmployeeV4(
    connection,
    mockWallet,
    businessPDA,
    empWallet,
    salaryLamports,
    now - 60,
    now + (86400 * 30) // 30 days
  );
  console.log(`   Employee ${employeeIndex}: ${employeePDA.toBase58()} (TX: ${txid})`);

  // Write out variables for the E2E script
  console.log('\n--- Setup Complete ---');
  console.log(`Run the crank test using:\n\nBUSINESS_INDEX=${businessIndex} EMPLOYEE_INDEX=${employeeIndex} EMPLOYEE_WALLET=${empWallet.toBase58()} node scripts/v4-crank-e2e.cjs`);
}

run().catch(console.error);
