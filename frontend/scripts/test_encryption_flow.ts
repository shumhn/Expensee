import { encryptValue } from '@inco/solana-sdk/encryption';
import { readFileSync } from 'fs';

async function main() {
  const salary = 5000000n; // 5 USDC
  
  console.log('--- ENCRYPTING SALARY ---');
  try {
    const encryptedHex = await encryptValue(salary);
    console.log('Raw Hex from Inco SDK:', encryptedHex);
    
    // This is what encryptForInco does:
    const bufferBytes = Buffer.from(encryptedHex, 'hex');
    console.log('Buffer bytes length:', bufferBytes.length);
    
    // This is what the Rust program does:
    // It takes the buffer, truncates it to 32 bytes or pads it, then saves it.
    let storedHandle = Buffer.alloc(32);
    bufferBytes.copy(storedHandle, 0, 0, Math.min(bufferBytes.length, 32));
    
    console.log('Stored on Solana (32 bytes):', storedHandle.toString('hex'));
    
    // This is what getEmployeeV4DecryptHandles does:
    let out = 0n;
    for (let i = 31; i >= 0; i -= 1) {
      out = out * 256n + BigInt(storedHandle[i] || 0);
    }
    
    console.log('Extracted Handle BigInt:', out.toString());
    
  } catch (e) {
    console.error('Error:', e);
  }
}

main().catch(console.error);
