const { Connection, PublicKey } = require('@solana/web3.js');

const MAGIC_PROGRAM_ID = new PublicKey('Magic11111111111111111111111111111111111111');

async function checkER() {
    const urls = [
        'https://devnet-router.magicblock.app'
    ];

    for (const url of urls) {
        try {
            console.log(`\n🔍 Checking ER RPC: ${url}`);
            const connection = new Connection(url, 'confirmed');
            
            // MagicBlock stores tasks in PDAs owned by MAGIC_PROGRAM_ID
            const accounts = await connection.getProgramAccounts(MAGIC_PROGRAM_ID);
            console.log(`   Found ${accounts.length} magic router accounts active.`);
            
            if (accounts.length > 0) {
                // If there are accounts, log their sizes/addresses to help identify our task
                const tasks = accounts.slice(0, 15);
                tasks.forEach((acc, i) => {
                    console.log(`   - [${i}] Addr: ${acc.pubkey.toBase58()} | Size: ${acc.account.data.length} bytes`);
                });
                if (accounts.length > 15) console.log(`   ... and ${accounts.length - 15} more.`);
            }
        } catch (e) {
            console.log(`   ❌ Error connecting to ${url}:`, e.message);
        }
    }
}

checkER();
