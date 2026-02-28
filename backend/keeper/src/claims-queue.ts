import { MongoClient, Db, Collection } from 'mongodb';
import { ClaimAuthRecord } from './healthcheck';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB_NAME || 'expensee';
const queueRetentionSecs = Number(process.env.KEEPER_QUEUE_RETENTION_SECS || '86400');

let client: MongoClient | null = null;
let db: Db | null = null;
let claimsCollection: Collection<PersistentClaimAuth> | null = null;
let withdrawsCollection: Collection<PersistentWithdrawAuth> | null = null;
let viewsCollection: Collection<PersistentViewAuth> | null = null;

function sameIndexKey(a: Record<string, any>, b: Record<string, any>): boolean {
    const aEntries = Object.entries(a || {});
    const bEntries = Object.entries(b || {});
    if (aEntries.length !== bEntries.length) return false;
    for (let i = 0; i < aEntries.length; i += 1) {
        const [aKey, aVal] = aEntries[i]!;
        const [bKey, bVal] = bEntries[i]!;
        if (aKey !== bKey || aVal !== bVal) return false;
    }
    return true;
}

async function ensureScopedUniqueIndex(
    collection: Collection<any>,
    legacyKey: Record<string, 1 | -1>,
    scopedKey: Record<string, 1 | -1>,
): Promise<void> {
    const indexes = await collection.indexes();
    for (const idx of indexes) {
        if (!idx.unique) continue;
        if (sameIndexKey(idx.key, legacyKey)) {
            await collection.dropIndex(idx.name);
            console.log(`[keeper db] Dropped legacy unique index ${collection.collectionName}.${idx.name}`);
        }
    }
    await collection.createIndex(scopedKey, { unique: true });
}

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

        // Create indexes for queue scans and business-scoped dedupe.
        await claimsCollection.createIndex({ status: 1 });
        if (queueRetentionSecs > 0) {
            await claimsCollection.createIndex(
                { updatedAt: 1 },
                {
                    expireAfterSeconds: queueRetentionSecs,
                    partialFilterExpression: { status: { $in: ['completed', 'failed'] } },
                },
            );
        }
        await ensureScopedUniqueIndex(
            claimsCollection,
            { streamIndex: 1, nonce: 1 },
            { businessOwner: 1, streamIndex: 1, nonce: 1 },
        );

        await withdrawsCollection.createIndex({ status: 1 });
        if (queueRetentionSecs > 0) {
            await withdrawsCollection.createIndex(
                { updatedAt: 1 },
                {
                    expireAfterSeconds: queueRetentionSecs,
                    partialFilterExpression: { status: { $in: ['completed', 'failed'] } },
                },
            );
        }
        await ensureScopedUniqueIndex(
            withdrawsCollection,
            { streamIndex: 1, timestamp: 1 },
            { businessOwner: 1, streamIndex: 1, timestamp: 1 },
        );

        await viewsCollection.createIndex({ status: 1 });
        if (queueRetentionSecs > 0) {
            await viewsCollection.createIndex(
                { updatedAt: 1 },
                {
                    expireAfterSeconds: queueRetentionSecs,
                    partialFilterExpression: { status: { $in: ['completed', 'failed'] } },
                },
            );
        }
        await ensureScopedUniqueIndex(
            viewsCollection,
            { streamIndex: 1, timestamp: 1 },
            { businessOwner: 1, streamIndex: 1, timestamp: 1 },
        );

        const retentionLabel =
            queueRetentionSecs > 0 ? `${queueRetentionSecs}s` : 'disabled';
        console.log(
            `[keeper db] Connected to MongoDB database: ${dbName} (queue retention: ${retentionLabel})`,
        );
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

export async function markClaimCompleted(
    businessOwner: string,
    streamIndex: number,
    nonce: number,
    sig: string
): Promise<void> {
    if (!claimsCollection) return;
    await claimsCollection.updateOne(
        { businessOwner, streamIndex, nonce },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markClaimFailed(
    businessOwner: string,
    streamIndex: number,
    nonce: number,
    reason: string
): Promise<void> {
    if (!claimsCollection) return;
    await claimsCollection.updateOne(
        { businessOwner, streamIndex, nonce },
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

export async function markWithdrawCompleted(
    businessOwner: string,
    streamIndex: number,
    timestamp: number,
    sig: string
): Promise<void> {
    if (!withdrawsCollection) return;
    await withdrawsCollection.updateOne(
        { businessOwner, streamIndex, timestamp },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markWithdrawFailed(
    businessOwner: string,
    streamIndex: number,
    timestamp: number,
    reason: string
): Promise<void> {
    if (!withdrawsCollection) return;
    await withdrawsCollection.updateOne(
        { businessOwner, streamIndex, timestamp },
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

export async function markViewCompleted(
    businessOwner: string,
    streamIndex: number,
    timestamp: number,
    sig: string
): Promise<void> {
    if (!viewsCollection) return;
    await viewsCollection.updateOne(
        { businessOwner, streamIndex, timestamp },
        { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } }
    );
}

export async function markViewFailed(
    businessOwner: string,
    streamIndex: number,
    timestamp: number,
    reason: string
): Promise<void> {
    if (!viewsCollection) return;
    await viewsCollection.updateOne(
        { businessOwner, streamIndex, timestamp },
        { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } }
    );
}

export async function getViewAccessTargets(streamIndex: number, businessOwner?: string): Promise<string[]> {
    if (!viewsCollection) return [];
    const filter = businessOwner ? { streamIndex, businessOwner } : { streamIndex };
    const docs = await viewsCollection.find(filter).toArray();
    const uniqueKeys = new Set(docs.map(d => d.workerPubkey));
    return Array.from(uniqueKeys);
}

/**
 * Look up the worker pubkey for a given stream from the withdraws_queue.
 * Used by the auto-healing logic when the on-chain WithdrawRequestV2 PDA
 * has a stale requester (e.g., from before the Ghost Mode fix).
 */
export async function getWorkerPubkeyForStream(
    streamIndex: number,
    businessOwner: string
): Promise<string | null> {
    if (!withdrawsCollection) await connectQueue();
    const doc = await withdrawsCollection!.findOne(
        { streamIndex, businessOwner },
        { sort: { receivedAt: -1 } }
    );
    return doc?.workerPubkey ?? null;
}
