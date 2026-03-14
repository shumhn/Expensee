import anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ed25519 } from '@noble/curves/ed25519';

function expandHome(p) { return p?.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p; }

async function generateTeeToken(teeUrl, keypair) {
    try {
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
        
        // BUSINESS 8 EMPLOYEE 0
        const employeePda = new PublicKey("CNf3YpRQC6g95kGGVk3P4C64QDDVaUgNRriy2616Vw8s");

        console.log("Checking Employee on ER:", employeePda.toBase58());

        const account = await connection.getAccountInfo(employeePda);
        if (!account) {
            console.log("❌ Account not found on ER!");
            return;
        }

        const data = account.data;
        // Offset calculation for EmployeeEntryV4
        // DISCRIMINATOR(8) + business(32) + index(8) + id(32) + rate(32) + accrued(32) = 144
        const lastAccrualTime = data.readBigInt64LE(144);
        const lastSettleTime = data.readBigInt64LE(152);
        
        console.log("Last Accrual Time:", lastAccrualTime.toString());
        console.log("Last Settle Time:", lastSettleTime.toString());
        console.log("Current Time:     ", Math.floor(Date.now() / 1000));
        
        const diff = Math.floor(Date.now() / 1000) - Number(lastAccrualTime);
        console.log(`Diff (seconds):   ${diff}`);
        
        if (diff < 300) { // Within 5 minutes
            console.log("🚀 SUCCESS: Accrual time is recently updated! The autonomous crank is firing!");
        } else {
            console.log("⏳ Crank hasn't updated yet.");
        }
    } catch (e) {
        console.error("Fatal Error:", e);
    }
}

main();
