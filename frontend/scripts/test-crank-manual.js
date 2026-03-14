const anchor = require("@coral-xyz/anchor");
const { PublicKey, TransactionInstruction, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require("fs");

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const programId = new PublicKey("97u6CxDck3yhEP6bcvjsMUeV6Us439Y7sSSBBj14QQuU");
    
    // Manual discriminator for crank_settle_v4 (sha256("global:crank_settle_v4"))
    const discriminator = Buffer.from([0xcc, 0x90, 0xe6, 0x76, 0x4d, 0xf6, 0x05, 0x9c]);

    const businessIndex = 3;
    const employeeIndex = 0;

    const [masterVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("master_vault_v4")],
        programId
    );

    const businessIndexBytes = Buffer.alloc(8);
    businessIndexBytes.writeBigUInt64LE(BigInt(businessIndex));
    const [business] = PublicKey.findProgramAddressSync(
        [Buffer.from("business_v4"), masterVault.toBuffer(), businessIndexBytes],
        programId
    );

    const employeeIndexBytes = Buffer.alloc(8);
    employeeIndexBytes.writeBigUInt64LE(BigInt(employeeIndex));
    const [employee] = PublicKey.findProgramAddressSync(
        [Buffer.from("employee_v4"), business.toBuffer(), employeeIndexBytes],
        programId
    );

    console.log("Cranking Employee:", employee.toBase58());

    // Data: Discriminator + u64 employeeIndex
    const data = Buffer.concat([discriminator, employeeIndexBytes]);

    const keys = [
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: employee, isSigner: false, isWritable: true },
    ];

    const ix = new TransactionInstruction({
        programId,
        keys,
        data,
    });

    try {
        const tx = new Transaction().add(ix);
        const sig = await provider.sendAndConfirm(tx);
        console.log("✅ Manual Crank Settle Success:", sig);
    } catch (err) {
        console.error("❌ Manual Crank Settle Failed:", err);
    }
}

main();
