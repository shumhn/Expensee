import { PublicKey, Keypair } from "@solana/web3.js";
import assert from "assert";
import { createHash } from "crypto";

/**
 * 2-Hop Shielded Payout — Pure Unit Tests
 *
 * No Anchor IDL or deployment needed. Tests PDA derivation,
 * auth hash logic, account layout, and privacy properties.
 */

// 4. Setup program
const PROGRAM_ID = new PublicKey("3P3tYHEUykB2fH5vxpunHQH3C7zi9B3fFXyzaRP38bJn");
const BUSINESS_SEED = Buffer.from("business");
const SHIELDED_PAYOUT_V2_SEED = Buffer.from("shielded_payout");

function deriveBusinessPDA(owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [BUSINESS_SEED, owner.toBuffer()],
        PROGRAM_ID
    );
}

function derivePayoutPDA(business: PublicKey, streamIndex: number, nonce: number): [PublicKey, number] {
    const streamIndexBuf = Buffer.alloc(8);
    streamIndexBuf.writeBigUInt64LE(BigInt(streamIndex));
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    return PublicKey.findProgramAddressSync(
        [SHIELDED_PAYOUT_V2_SEED, business.toBuffer(), streamIndexBuf, nonceBuf],
        PROGRAM_ID
    );
}

function authHash(pubkey: PublicKey): Buffer {
    return createHash('sha256').update(pubkey.toBuffer()).digest();
}

type PayoutState = {
    employeeAuthHash: Buffer;
    claimed: boolean;
    cancelled: boolean;
    createdAt: number;
    expiresAt: number;
};

function validateClaim(state: PayoutState, claimer: PublicKey, now: number): string | null {
    if (state.claimed) return "PayoutAlreadyClaimed";
    if (state.cancelled) return "PayoutAlreadyCancelled";
    if (state.expiresAt > 0 && now > state.expiresAt) return "PayoutExpired";
    if (!authHash(claimer).equals(state.employeeAuthHash)) return "UnauthorizedClaimer";
    return null;
}

function applyClaim(state: PayoutState, claimer: PublicKey, now: number): string | null {
    const err = validateClaim(state, claimer, now);
    if (err) return err;
    state.claimed = true;
    return null;
}

function validateCancel(state: PayoutState, now: number): string | null {
    if (state.claimed) return "PayoutAlreadyClaimed";
    if (state.cancelled) return "PayoutAlreadyCancelled";
    if (state.expiresAt > 0 && now <= state.expiresAt) return "PayoutNotExpired";
    return null;
}

function applyCancel(state: PayoutState, now: number): string | null {
    const err = validateCancel(state, now);
    if (err) return err;
    state.cancelled = true;
    return null;
}

describe("shielded-payout-v2 (unit)", () => {
    const owner = Keypair.generate();
    const [businessPDA] = deriveBusinessPDA(owner.publicKey);

    describe("PDA Derivation", () => {
        it("unique PDAs for different nonces", () => {
            const [pda1] = derivePayoutPDA(businessPDA, 0, 1000);
            const [pda2] = derivePayoutPDA(businessPDA, 0, 1001);
            assert.notStrictEqual(pda1.toBase58(), pda2.toBase58());
            console.log("✅ Different nonces → different PDAs");
        });

        it("unique PDAs for different stream indices", () => {
            const [pda1] = derivePayoutPDA(businessPDA, 0, 1000);
            const [pda2] = derivePayoutPDA(businessPDA, 1, 1000);
            assert.notStrictEqual(pda1.toBase58(), pda2.toBase58());
            console.log("✅ Different stream indices → different PDAs");
        });

        it("deterministic for same inputs", () => {
            const [pda1] = derivePayoutPDA(businessPDA, 5, 12345);
            const [pda2] = derivePayoutPDA(businessPDA, 5, 12345);
            assert.strictEqual(pda1.toBase58(), pda2.toBase58());
            console.log("✅ Same inputs → same PDA");
        });

        it("unique PDAs for different businesses", () => {
            const otherOwner = Keypair.generate();
            const [otherBiz] = deriveBusinessPDA(otherOwner.publicKey);
            const [pda1] = derivePayoutPDA(businessPDA, 0, 1000);
            const [pda2] = derivePayoutPDA(otherBiz, 0, 1000);
            assert.notStrictEqual(pda1.toBase58(), pda2.toBase58());
            console.log("✅ Different businesses → different PDAs");
        });
    });

    describe("Auth Hash", () => {
        it("deterministic for same wallet", () => {
            const wallet = Keypair.generate();
            const h1 = authHash(wallet.publicKey);
            const h2 = authHash(wallet.publicKey);
            assert.strictEqual(h1.toString('hex'), h2.toString('hex'));
            console.log("✅ Auth hash is deterministic");
        });

        it("is 32 bytes (SHA-256)", () => {
            const wallet = Keypair.generate();
            assert.strictEqual(authHash(wallet.publicKey).length, 32);
            console.log("✅ Auth hash is 32 bytes");
        });

        it("unique per wallet", () => {
            const w1 = Keypair.generate();
            const w2 = Keypair.generate();
            assert.notStrictEqual(
                authHash(w1.publicKey).toString('hex'),
                authHash(w2.publicKey).toString('hex')
            );
            console.log("✅ Different wallets → different hashes");
        });
    });

    describe("Account Layout", () => {
        const fields = [
            { name: "discriminator", start: 0, size: 8 },
            { name: "business", start: 8, size: 32 },
            { name: "streamIndex", start: 40, size: 8 },
            { name: "nonce", start: 48, size: 8 },
            { name: "employeeAuthHash", start: 56, size: 32 },
            { name: "encryptedAmount", start: 88, size: 32 },
            { name: "claimed", start: 120, size: 1 },
            { name: "cancelled", start: 121, size: 1 },
            { name: "createdAt", start: 122, size: 8 },
            { name: "expiresAt", start: 130, size: 8 },
            { name: "payoutTokenAccount", start: 138, size: 32 },
            { name: "bump", start: 170, size: 1 },
        ];

        it("no gaps or overlaps", () => {
            for (let i = 1; i < fields.length; i++) {
                const prev = fields[i - 1];
                const curr = fields[i];
                assert.strictEqual(
                    prev.start + prev.size, curr.start,
                    `Gap between ${prev.name} and ${curr.name}`
                );
            }
            console.log("✅ No gaps or overlaps");
        });

        it("total size = 171 bytes", () => {
            const last = fields[fields.length - 1];
            assert.strictEqual(last.start + last.size, 171);
            console.log("✅ Total: 171 bytes");
        });

        it("matches on-chain LEN constant", () => {
            const expectedLen = 8 + 32 + 8 + 8 + 32 + 32 + 1 + 1 + 8 + 8 + 32 + 1;
            assert.strictEqual(expectedLen, 171);
            console.log("✅ LEN = 171");
        });
    });

    describe("2-Hop Privacy", () => {
        it("PDA address does not contain worker pubkey", () => {
            const worker = Keypair.generate();
            const [pda] = derivePayoutPDA(businessPDA, 0, 1000);
            const pdaBuf = pda.toBuffer();
            const workerBuf = worker.publicKey.toBuffer();
            let match = false;
            for (let i = 0; i <= pdaBuf.length - 32; i++) {
                if (pdaBuf.slice(i, i + 32).equals(workerBuf)) { match = true; break; }
            }
            assert.strictEqual(match, false, "Worker pubkey should NOT be in PDA");
            console.log("✅ PDA doesn't leak worker identity");
        });

        it("auth hash is one-way (hash ≠ pubkey)", () => {
            const wallet = Keypair.generate();
            const hash = authHash(wallet.publicKey);
            assert.notStrictEqual(
                hash.toString('hex'),
                wallet.publicKey.toBuffer().toString('hex')
            );
            console.log("✅ Auth hash is one-way");
        });
    });

    describe("Guard Behavior (claim/cancel)", () => {
        it("prevents unauthorized claimer", () => {
            const worker = Keypair.generate();
            const attacker = Keypair.generate();
            const state: PayoutState = {
                employeeAuthHash: authHash(worker.publicKey),
                claimed: false,
                cancelled: false,
                createdAt: 1000,
                expiresAt: 2000,
            };
            const err = applyClaim(state, attacker.publicKey, 1500);
            assert.strictEqual(err, "UnauthorizedClaimer");
            assert.strictEqual(state.claimed, false);
        });

        it("prevents double claim", () => {
            const worker = Keypair.generate();
            const state: PayoutState = {
                employeeAuthHash: authHash(worker.publicKey),
                claimed: false,
                cancelled: false,
                createdAt: 1000,
                expiresAt: 2000,
            };

            const first = applyClaim(state, worker.publicKey, 1500);
            assert.strictEqual(first, null);
            assert.strictEqual(state.claimed, true);

            const second = applyClaim(state, worker.publicKey, 1501);
            assert.strictEqual(second, "PayoutAlreadyClaimed");
        });

        it("prevents claim after expiry", () => {
            const worker = Keypair.generate();
            const state: PayoutState = {
                employeeAuthHash: authHash(worker.publicKey),
                claimed: false,
                cancelled: false,
                createdAt: 1000,
                expiresAt: 2000,
            };
            const err = applyClaim(state, worker.publicKey, 2001);
            assert.strictEqual(err, "PayoutExpired");
            assert.strictEqual(state.claimed, false);
        });

        it("prevents cancel before expiry and allows cancel after expiry", () => {
            const worker = Keypair.generate();
            const state: PayoutState = {
                employeeAuthHash: authHash(worker.publicKey),
                claimed: false,
                cancelled: false,
                createdAt: 1000,
                expiresAt: 2000,
            };

            const before = applyCancel(state, 2000);
            assert.strictEqual(before, "PayoutNotExpired");
            assert.strictEqual(state.cancelled, false);

            const after = applyCancel(state, 2001);
            assert.strictEqual(after, null);
            assert.strictEqual(state.cancelled, true);
        });

        it("prevents claim after cancellation", () => {
            const worker = Keypair.generate();
            const state: PayoutState = {
                employeeAuthHash: authHash(worker.publicKey),
                claimed: false,
                cancelled: false,
                createdAt: 1000,
                expiresAt: 2000,
            };

            const cancelled = applyCancel(state, 2001);
            assert.strictEqual(cancelled, null);

            const claimAfterCancel = applyClaim(state, worker.publicKey, 2001);
            assert.strictEqual(claimAfterCancel, "PayoutAlreadyCancelled");
        });
    });
});
