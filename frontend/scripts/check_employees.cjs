const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = 'https://api.devnet.solana.com';
const PID = new PublicKey('97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
const DELEG = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

function u64LE(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }

(async () => {
  const c = new Connection(RPC, 'confirmed');
  const mv = PublicKey.findProgramAddressSync([Buffer.from('master_vault_v4b')], PID)[0];
  const mvi = await c.getAccountInfo(mv);
  console.log('MasterVault:', mv.toBase58(), mvi ? 'EXISTS' : 'MISSING');
  if (!mvi) { process.exit(0); }

  const biz = PublicKey.findProgramAddressSync([Buffer.from('business_v4'), mv.toBuffer(), u64LE(3)], PID)[0];
  const bi = await c.getAccountInfo(biz);
  console.log('Business 0:', biz.toBase58(), bi ? 'EXISTS' : 'MISSING');
  if (!bi) { process.exit(0); }

  for (let i = 0; i < 30; i++) {
    const emp = PublicKey.findProgramAddressSync([Buffer.from('employee_v4'), biz.toBuffer(), u64LE(i)], PID)[0];
    const ei = await c.getAccountInfo(emp);
    if (ei) {
      const delegated = ei.owner.equals(DELEG);
      console.log(`  Emp ${i}: ${emp.toBase58().slice(0,12)}.. | owner=${ei.owner.toBase58().slice(0,12)}.. | delegated=${delegated}`);
    }
  }
  console.log('Done.');
  process.exit(0);
})();
