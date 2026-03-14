import anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
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

async function getRouterBlockhash(rpcUrl, tx) {
  const writableAccounts = new Set();
  if (tx.feePayer) writableAccounts.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions)
    for (const k of ix.keys)
      if (k.isWritable) writableAccounts.add(k.pubkey.toBase58());

  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getBlockhashForAccounts',
      params: [Array.from(writableAccounts)],
    }),
  });
  const payload = await resp.json();
  const val = payload?.result?.value ?? payload?.result;
  if (!val || !val.blockhash) throw new Error('Router blockhash missing: ' + JSON.stringify(payload));
  return val;
}

import crypto from 'crypto';

function getCrankSettleV4Discriminator() {
    // Generate anchor sighash for "global:crank_settle_v4"
    const hash = crypto.createHash("sha256").update("global:crank_settle_v4").digest();
    return hash.slice(0, 8);
}

async function main() {
    try {
        const TEE_URL = "https://tee.magicblock.app";
        const walletPath = expandHome("~/.config/solana/id.json");
        const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
        
        const token = await generateTeeToken(TEE_URL, keypair);
        if (!token) throw new Error("Failed to get TEE auth token");

        const erConn = new Connection(`${TEE_URL}?token=${token}`, "confirmed");
        const programId = new PublicKey("97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU");
        // Business 6, Employee 0
        const employeePda = new PublicKey("ChNJV46HTD3TZgBjWhiaBo29hrm9sUT1xRZjQHZcCbge");

        // Construct ix
        // data: discriminator (8) + employee_index (8)
        const disc = getCrankSettleV4Discriminator();
        const argsBuf = Buffer.alloc(8);
        argsBuf.writeBigUInt64LE(BigInt(0), 0); // employee_index = 0
        const data = Buffer.concat([disc, argsBuf]);

        const ix = new TransactionInstruction({
            programId,
            keys: [
                { pubkey: employeePda, isSigner: false, isWritable: true }
            ],
            data
        });

        const tx = new Transaction().add(ix);
        tx.feePayer = keypair.publicKey;

        const erUrl = `${TEE_URL}?token=${token}`;
        const { blockhash, lastValidBlockHeight } = await getRouterBlockhash(erUrl, tx);
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.sign(keypair);

        console.log("Submitting crank_settle_v4 directly to ER...");
        let simResult = await erConn.simulateTransaction(tx);
        console.log("Simulation Logs:");
        console.log(simResult.value.logs);
        if (simResult.value.err) {
            console.error("Simulation failed:", simResult.value.err);
            return;
        }

        const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
        console.log(`✅ Sent (ER): ${sig}`);
        await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        console.log(`✅ Confirmed on ER`);

    } catch (e) {
        console.error("Fatal Error:", e);
    }
}

main();
