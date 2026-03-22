import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

function readU128LEFrom32(b: Buffer): bigint {
  const bytes = b.subarray(0, 32);
  let out = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    out = out * 256n + BigInt(bytes[i] || 0);
  }
  return out;
}

async function main() {
  const conn = new Connection('https://api.devnet.solana.com');
  const programId = new PublicKey('97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
  const employeePda = new PublicKey('13mE1C6S8Jc2657oBqudY3v5dZ7gG211d2tq3X1N3Uv4');

  const acct = await conn.getAccountInfo(employeePda);
  if (!acct) {
    console.log('Account not found');
    return;
  }

  const data = acct.data;
  const encryptedAccrued = data.subarray(80, 112);
  const encryptedSalaryRate = data.subarray(112, 144);

  console.log('--- RAW BYTES ---');
  console.log('Accrued Hex   :', encryptedAccrued.toString('hex'));
  console.log('Salary Hex    :', encryptedSalaryRate.toString('hex'));

  console.log('--- BIGINTS ---');
  const accruedValue = readU128LEFrom32(encryptedAccrued);
  const salaryValue = readU128LEFrom32(encryptedSalaryRate);

  console.log('Accrued handle value:', accruedValue.toString());
  console.log('Salary handle value :', salaryValue.toString());
}

main().catch(console.error);
