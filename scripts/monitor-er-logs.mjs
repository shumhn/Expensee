import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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
        if (!token) throw new Error("Failed to generate TEE token");

        const connection = new Connection(`${TEE_URL}?token=${token}`, {
            wsEndpoint: `wss://tee.magicblock.app?token=${token}`,
            commitment: "confirmed"
        });
        
        const programId = new PublicKey("97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU");
        console.log(`📡 Listening for ER logs on ${programId.toBase58()}...`);
        
        connection.onLogs(programId, (logs, ctx) => {
            console.log(`\n--- Transaction [${logs.signature}] ---`);
            if (logs.err) console.error("❌ ERROR:", logs.err);
            logs.logs.forEach(l => console.log(l));
        });

        // Keep alive
        setInterval(() => {}, 10000);
    } catch (e) {
        console.error("Fatal Error:", e);
    }
}

main();
