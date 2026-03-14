const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');

const PAYROLL_PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PAYROLL_PROGRAM_ID || '97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
const ER_URL = 'https://devnet-router.magicblock.app';

const SEEDS = {
  master_vault_v4b: Buffer.from('master_vault_v4b'),
  business_v4: Buffer.from('business_v4'),
  employee_v4: Buffer.from('employee_v4'),
};

function u64LE(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

async function monitor() {
  const statePath = path.resolve(__dirname, '../../services/keeper/devnet-v4-state.json');
  let state = {};
  if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  
  const businessIndex = Number(process.env.BUSINESS_INDEX || state.businessIndex || 0);
  const employeeIndex = Number(process.env.EMPLOYEE_INDEX || state.employeeIndex || 0);
  
  console.log(`🔍 Monitoring Employee ${employeeIndex} of Business ${businessIndex}`);
  
  const [masterVault] = PublicKey.findProgramAddressSync([SEEDS.master_vault_v4b], PAYROLL_PROGRAM_ID);
  const [business] = PublicKey.findProgramAddressSync([SEEDS.business_v4, masterVault.toBuffer(), u64LE(businessIndex)], PAYROLL_PROGRAM_ID);
  const [employee] = PublicKey.findProgramAddressSync([SEEDS.employee_v4, business.toBuffer(), u64LE(employeeIndex)], PAYROLL_PROGRAM_ID);
  
  console.log(`   Employee PDA: ${employee.toBase58()}`);
  console.log(`   Connecting to ER: ${ER_URL} ...`);
  
  const erConnection = new Connection(ER_URL, 'confirmed');
  
  let lastDataHash = '';
  let checks = 0;
  
  // Poll every 5 seconds
  setInterval(async () => {
      try {
          checks++;
          const info = await erConnection.getAccountInfo(employee, 'confirmed');
          if (!info) {
              console.log(`[${checks}] ❌ Account not found on ER. Is it delegated?`);
              return;
          }
          
          const currentHash = require('crypto').createHash('sha256').update(info.data).digest('hex');
          if (currentHash !== lastDataHash) {
              if (lastDataHash === '') {
                  console.log(`[${checks}] 🟢 Initial Data Loaded! Size: ${info.data.length} bytes`);
              } else {
                  console.log(`[${checks}] ⚡ DATA CHANGED ON ER! CRANK EXECUTED! Size: ${info.data.length} bytes`);
              }
              lastDataHash = currentHash;
              
              // Let's print the last 32 bytes to see if it's changing (often balances are at the end)
              const tail = info.data.subarray(info.data.length - 32);
              console.log(`   -> Tail: ${tail.toString('hex')}`);
          } else {
              process.stdout.write('.');
          }
      } catch (e) {
          console.log(`\n[${checks}] ⚠️ Error fetching: ${e.message}`);
      }
  }, 5000);
}

monitor();
