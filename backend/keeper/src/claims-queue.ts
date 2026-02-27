import { MongoClient, Db, Collection } from 'mongodb';
import { ClaimAuthRecord } from './healthcheck';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB_NAME || 'expensee';

let client: MongoClient | null = null;
let db: Db | null = null;
let claimsCollection: Collection<PersistentClaimAuth> | null = null;
let withdrawsCollection: Collection<PersistentWithdrawAuth> | null = null;
let viewsCollection: Collection<PersistentViewAuth> | null = null;

export interface PersistentClaimAuth extends ClaimAuthRecord {
    status: 'pending' | 'completed' | 'failed';
    txSignature?: string;
    errorReason?: string;
    updatedAt: number;
}

export interface WithdrawAuthRecord {
    workerPubkey: string;
    streamIndex: number;
    signature: number[];
    message: number[];
    businessOwner: string;
    timestamp: number;
    receivedAt: number;
}

export interface PersistentWithdrawAuth extends WithdrawAuthRecord {
    status: 'pending' | 'completed' | 'failed';
    txSignature?: string;
    errorReason?: string;
    updatedAt: number;
}

export interface ViewAuthRecord {
    workerPubkey: string;
    streamIndex: number;
    signature: number[];
    message: number[];
    businessOwner: string;
    timestamp: number;
    receivedAt: number;
}

export interface PersistentViewAuth extends ViewAuthRecord {
    status: 'pending' | 'completed' | 'failed';
    txSignature?: string;
    errorReason?: string;
    updatedAt: number;
}

export async function connectQueue(): Promise<void> {
    if (!client) {
        if (!process.env.MONGODB_URI) {
            console.warn('[keeper db] MONGODB_URI not set! Defaulting to localhost:27017');
        }
        client = new MongoClient(uri);
        await client.connect();
        db = client.db(dbName);
        claimsCollection = db.collection<PersistentClaimAuth>('claims_queue');
        withdrawsCollection = db.collection<PersistentWithdrawAuth>('withdraws_queue');
        viewsCollection = db.collection<PersistentViewAuth>('views_queue');

        // Create an index to quickly find pending claims, and deduplicate by stream+nonce
        await claimsCollection.createIndex({ status: 1 });
        await claimsCollection.createIndex({ streamIndex: 1, nonce: 1 }, { unique: true });

        await withdrawsCollection.createIndex({ status: 1 });
        // Deduplicate withdraws by timestamp
        await withdrawsCollection.createIndex({ streamIndex: 1, timestamp: 1 }, { unique: true });

        await viewsCollection.createIndex({ status: 1 });
        // Deduplicate views by timestamp
        await viewsCollection.createIndex({ streamIndex: 1, timestamp: 1 }, { unique: true });

        console.log(`[keeper db] Connected to MongoDB database: ${dbName}`);
    }
}

export async function enqueueClaimAuth(auth: ClaimAuthRecord): Promise<boolean> {
    if (!claimsCollection) await connectQueue();
    try {
        const doc: PersistentClaimAuth = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await claimsCollection!.insertOne(doc);
        return true;
    } catch (e: any) {
        if (e.code === 11000) {
            // Duplicate key error (already queued)
            return false;
        }
        throw e;
    }
}

export async function getPendingClaimAuths(limit: number = 5): Promise<PersistentClaimAuth[]> {
    if (!claimsCollection) await connectQueue();
    return claimsCollection!.find({ status: 'pending' }).limit(limit).toArray();
}

export async function markClaimCompleted(streamIndex: number, nonce: number, sig: string): Promise<void> {
    if (!claimsCollection) return;
    await claimsCollection.updateOne(
        { streamIndex, nonce },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markClaimFailed(streamIndex: number, nonce: number, reason: string): Promise<void> {
    if (!claimsCollection) return;
    await claimsCollection.updateOne(
        { streamIndex, nonce },
        { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } }
    );
}

export async function getQueueSize(): Promise<number> {
    if (!claimsCollection) return 0;
    return claimsCollection.countDocuments({ status: 'pending' });
}

export async function enqueueWithdrawAuth(auth: WithdrawAuthRecord): Promise<boolean> {
    if (!withdrawsCollection) await connectQueue();
    try {
        const doc: PersistentWithdrawAuth = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await withdrawsCollection!.insertOne(doc);
        return true;
    } catch (e: any) {
        if (e.code === 11000) return false;
        throw e;
    }
}

export async function getPendingWithdrawAuths(limit: number = 5): Promise<PersistentWithdrawAuth[]> {
    if (!withdrawsCollection) await connectQueue();
    return withdrawsCollection!.find({ status: 'pending' }).limit(limit).toArray();
}

export async function markWithdrawCompleted(streamIndex: number, timestamp: number, sig: string): Promise<void> {
    if (!withdrawsCollection) return;
    await withdrawsCollection.updateOne(
        { streamIndex, timestamp },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markWithdrawFailed(streamIndex: number, timestamp: number, reason: string): Promise<void> {
    if (!withdrawsCollection) return;
    await withdrawsCollection.updateOne(
        { streamIndex, timestamp },
        { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } }
    );
}

export async function enqueueViewAuth(auth: ViewAuthRecord): Promise<boolean> {
    if (!viewsCollection) await connectQueue();
    try {
        const doc: PersistentViewAuth = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await viewsCollection!.insertOne(doc);
        return true;
    } catch (e: any) {
        if (e.code === 11000) return false;
        throw e;
    }
}

export async function getPendingViewAuths(limit: number = 5): Promise<PersistentViewAuth[]> {
    if (!viewsCollection) await connectQueue();
    return viewsCollection!.find({ status: 'pending' }).limit(limit).toArray();
}

export async function markViewCompleted(streamIndex: number, timestamp: number, sig: string): Promise<void> {
    if (!viewsCollection) return;
    await viewsCollection.updateOne(
        { streamIndex, timestamp },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markViewFailed(streamIndex: number, timestamp: number, reason: string): Promise<void> {
    if (!viewsCollection) return;
    await viewsCollection.updateOne(
        { streamIndex, timestamp },
        { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } }
    );
}

export async function getViewAccessTargets(streamIndex: number): Promise<string[]> {
    if (!viewsCollection) return [];
    const docs = await viewsCollection.find({ streamIndex }).toArray();
    const uniqueKeys = new Set(docs.map(d => d.workerPubkey));
    return Array.from(uniqueKeys);
}

/**
 * Look up the worker pubkey for a given stream from the withdraws_queue.
 * Used by the auto-healing logic when the on-chain WithdrawRequestV2 PDA
 * has a stale requester (e.g., from before the Ghost Mode fix).
 */
export async function getWorkerPubkeyForStream(streamIndex: number): Promise<string | null> {
    if (!withdrawsCollection) await connectQueue();
    const doc = await withdrawsCollection!.findOne(
        { streamIndex },
        { sort: { receivedAt: -1 } }
    );
    return doc?.workerPubkey ?? null;
}
