const { Connection, PublicKey } = require('@solana/web3.js');
async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const PAYROLL = new PublicKey('97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU');
  const seed = Buffer.from('master_vault_v4b');
  const [pda] = PublicKey.findProgramAddressSync([seed], PAYROLL);
  console.log('PDA:', pda.toBase58());
  const ai = await connection.getAccountInfo(pda);
  if (!ai) { console.log('NOT FOUND'); return; }
  const d = ai.data;
  console.log('len:', d.length, 'owner:', ai.owner.toBase58());
  
  // With encrypted_total_balance layout (current Rust struct)
  console.log('--- WITH encrypted_total_balance (current) ---');
  console.log('  is_active byte209:', d[209], '  bump byte210:', d[210]);
  console.log('  nextBizIdx bytes201-209:', Number(d.readBigUInt64LE(201)));
  
  // Without encrypted_total_balance layout (older program)
  console.log('--- WITHOUT encrypted_total_balance (old) ---');
  console.log('  is_active byte177:', d[177], '  bump byte178:', d[178]);
  console.log('  nextBizIdx bytes169-177:', Number(d.readBigUInt64LE(169)));
  
  // Raw bytes around interesting areas
  console.log('--- RAW bytes 200-215 ---');
  var parts = [];
  for (var i = 200; i < Math.min(215, d.length); i++) {
    parts.push('b' + i + '=' + d[i]);
  }
  console.log(parts.join(' '));
  
  console.log('--- RAW bytes 170-185 ---');
  parts = [];
  for (var j = 170; j < Math.min(185, d.length); j++) {
    parts.push('b' + j + '=' + d[j]);
  }
  console.log(parts.join(' '));
}
main().catch(console.error);
