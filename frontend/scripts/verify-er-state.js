const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const { getAuthToken } = require('@magicblock-labs/ephemeral-rollups-sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) { return p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

async function generateTeeToken(teeUrl, keypair) {
    try {
        const { ed25519 } = await import('@noble/curves/ed25519');
        const signMessage = async (message) => ed25519.sign(message, keypair.secretKey.slice(0, 32));
        const auth = await getAuthToken(teeUrl, keypair.publicKey, signMessage);
        return typeof auth === 'string' ? auth : auth.token;
    } catch (err) {
        console.error(`❌ TEE token generation failed: ${err.message}`);
        return null;
    }
}

async function main() {
    try {
        const TEE_URL = "https://tee.magicblock.app";
        const walletPath = expandHome("~/.config/solana/id.json");
        const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
        
        const token = await generateTeeToken(TEE_URL, keypair);
        if (!token) {
            console.error("❌ Failed to generate TEE token");
            return;
        }

        const connection = new Connection(`${TEE_URL}?token=${token}`, "confirmed");
        
        // BUSINESS 6 EMPLOYEE 0
        const employeePda = new PublicKey("ChNJV46HTD3TZgBjWhiaBo29hrm9sUT1xRZjQHZcCbge");

        console.log("Checking Employee on ER:", employeePda.toBase58());

        const account = await connection.getAccountInfo(employeePda);
        if (!account) {
            console.log("❌ Account not found on ER!");
            return;
        }

        const data = account.data;
        // Offset calculation for EmployeeEntryV4
        // DISCRIMINATOR(8) + INDEX(8) + ACTIVE(1) + RATE(32) + ACCRUED(32) = 81
        const lastAccrualTime = data.readBigInt64LE(81);
        const lastSettleTime = data.readBigInt64LE(89);
        
        console.log("Last Accrual Time:", lastAccrualTime.toString());
        console.log("Last Settle Time:", lastSettleTime.toString());
        console.log("Current Time:     ", Math.floor(Date.now() / 1000));
        
        const diff = Math.floor(Date.now() / 1000) - Number(lastAccrualTime);
        console.log(`Diff (seconds):   ${diff}`);
        
        if (diff < 60) {
            console.log("🚀 SUCCESS: Accrual time is very recent! The crank is firing!");
        } else {
            console.log("⏳ Crank hasn't updated yet.");
        }
    } catch (e) {
        console.error("Fatal Error:", e);
    }
}

main();
