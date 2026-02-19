import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Payroll } from "../target/types/payroll";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { assert } from "chai";

describe("payroll", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.Payroll as Program<Payroll>;
    const owner = (provider.wallet as anchor.Wallet).payer;

    // Constants (must match program)
    const BUSINESS_SEED = Buffer.from("business");
    const VAULT_SEED = Buffer.from("vault");
    const STREAM_CONFIG_V2_SEED = Buffer.from("stream_config_v2");
    const EMPLOYEE_V2_SEED = Buffer.from("employee_v2");
    const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

    // PDAs
    const [businessPDA, businessBump] = PublicKey.findProgramAddressSync(
        [BUSINESS_SEED, owner.publicKey.toBuffer()],
        program.programId
    );

    const [vaultPDA, vaultBump] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, businessPDA.toBuffer()],
        program.programId
    );

    const [streamConfigV2PDA, streamConfigV2Bump] = PublicKey.findProgramAddressSync(
        [STREAM_CONFIG_V2_SEED, businessPDA.toBuffer()],
        program.programId
    );

    it("Registers a business", async () => {
        try {
            await program.methods
                .registerBusiness()
                .accounts({
                    owner: owner.publicKey,
                    // business: businessPDA, // Correctly inferred by Anchor if seeds are defined in context
                    // system_program: SystemProgram.programId,
                } as any)
                .rpc();

            const businessAccount = await program.account.business.fetch(businessPDA);
            assert.equal(businessAccount.owner.toBase58(), owner.publicKey.toBase58());
            assert.equal(businessAccount.bump, businessBump);
            console.log("✅ Business registered");
        } catch (err) {
            console.error(err);
            throw err;
        }
    });

    it("Initializes a vault", async () => {
        // Note: This requires a token account, but since we are just checking PDA/auth logic,
        // we can pass a dummy pubkey for the token account for the PDA derivation test.
        const dummyTokenAccount = Keypair.generate().publicKey;
        const dummyMint = Keypair.generate().publicKey;

        await program.methods
            .initVault(dummyTokenAccount, dummyMint)
            .accounts({
                owner: owner.publicKey,
                business: businessPDA,
                // vault: vaultPDA,
                // system_program: SystemProgram.programId,
            } as any)
            .rpc();

        const vaultAccount = await program.account.businessVault.fetch(vaultPDA);
        assert.equal(vaultAccount.business.toBase58(), businessPDA.toBase58());
        assert.equal(vaultAccount.tokenAccount.toBase58(), dummyTokenAccount.toBase58());
        console.log("✅ Vault initialized");
    });

    it("Initializes stream config v2", async () => {
        const keeper = Keypair.generate().publicKey;
        const settleInterval = new anchor.BN(10);

        await program.methods
            .initStreamConfigV2(keeper, settleInterval)
            .accounts({
                owner: owner.publicKey,
                business: businessPDA,
                // stream_config_v2: streamConfigV2PDA,
                // system_program: SystemProgram.programId,
            } as any)
            .rpc();

        const configAccount = await program.account.businessStreamConfigV2.fetch(streamConfigV2PDA);
        assert.equal(configAccount.keeperPubkey.toBase58(), keeper.toBase58());
        assert.equal(configAccount.settleIntervalSecs.toNumber(), 10);
        console.log("✅ Stream config v2 initialized");
    });

    it("Deactivates a stream (auth check)", async () => {
        // We can't easily add_employee_stream_v2 because it requires Inco Lightning CPI.
        // But we can test that calling deactivate_stream_v2 on a non-existent account fails with expected error
        // or we can try to "simulate" a stream if we manually initialize the account (harder).

        // For now, let's just verify that the instruction exists and the PDA check works.
        const streamIndex = new anchor.BN(0);
        const [employeeStreamPDA] = PublicKey.findProgramAddressSync(
            [EMPLOYEE_V2_SEED, businessPDA.toBuffer(), streamIndex.toArrayLike(Buffer, "le", 8)],
            program.programId
        );

        try {
            await program.methods
                .deactivateStreamV2(streamIndex)
                .accounts({
                    owner: owner.publicKey,
                    business: businessPDA,
                    streamConfigV2: streamConfigV2PDA,
                    employeeStream: employeeStreamPDA,
                } as any)
                .rpc();
            assert.fail("Should have failed because account doesn't exist");
        } catch (err: any) {
            // Expecting AccountDoesNotExist or similar
            assert.include(err.message, "Account does not exist");
            console.log("✅ Deactivate stream auth/PDA check passed (failed as expected for missing account)");
        }
    });
});
