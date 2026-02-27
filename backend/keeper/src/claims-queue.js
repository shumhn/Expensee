"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectQueue = connectQueue;
exports.enqueueClaimAuth = enqueueClaimAuth;
exports.getPendingClaimAuths = getPendingClaimAuths;
exports.markClaimCompleted = markClaimCompleted;
exports.markClaimFailed = markClaimFailed;
exports.getQueueSize = getQueueSize;
exports.enqueueWithdrawAuth = enqueueWithdrawAuth;
exports.getPendingWithdrawAuths = getPendingWithdrawAuths;
exports.markWithdrawCompleted = markWithdrawCompleted;
exports.markWithdrawFailed = markWithdrawFailed;
exports.enqueueViewAuth = enqueueViewAuth;
exports.getPendingViewAuths = getPendingViewAuths;
exports.markViewCompleted = markViewCompleted;
exports.markViewFailed = markViewFailed;
const mongodb_1 = require("mongodb");
const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB_NAME || 'expensee';
let client = null;
let db = null;
let claimsCollection = null;
let withdrawsCollection = null;
let viewsCollection = null;
async function connectQueue() {
    if (!client) {
        if (!process.env.MONGODB_URI) {
            console.warn('[keeper db] MONGODB_URI not set! Defaulting to localhost:27017');
        }
        client = new mongodb_1.MongoClient(uri);
        await client.connect();
        db = client.db(dbName);
        claimsCollection = db.collection('claims_queue');
        withdrawsCollection = db.collection('withdraws_queue');
        viewsCollection = db.collection('views_queue');
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
async function enqueueClaimAuth(auth) {
    if (!claimsCollection)
        await connectQueue();
    try {
        const doc = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await claimsCollection.insertOne(doc);
        return true;
    }
    catch (e) {
        if (e.code === 11000) {
            // Duplicate key error (already queued)
            return false;
        }
        throw e;
    }
}
async function getPendingClaimAuths(limit = 5) {
    if (!claimsCollection)
        await connectQueue();
    return claimsCollection.find({ status: 'pending' }).limit(limit).toArray();
}
async function markClaimCompleted(streamIndex, nonce, sig) {
    if (!claimsCollection)
        return;
    await claimsCollection.updateOne({ streamIndex, nonce }, { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } });
}
async function markClaimFailed(streamIndex, nonce, reason) {
    if (!claimsCollection)
        return;
    await claimsCollection.updateOne({ streamIndex, nonce }, { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } });
}
async function getQueueSize() {
    if (!claimsCollection)
        return 0;
    return claimsCollection.countDocuments({ status: 'pending' });
}
async function enqueueWithdrawAuth(auth) {
    if (!withdrawsCollection)
        await connectQueue();
    try {
        const doc = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await withdrawsCollection.insertOne(doc);
        return true;
    }
    catch (e) {
        if (e.code === 11000)
            return false;
        throw e;
    }
}
async function getPendingWithdrawAuths(limit = 5) {
    if (!withdrawsCollection)
        await connectQueue();
    return withdrawsCollection.find({ status: 'pending' }).limit(limit).toArray();
}
async function markWithdrawCompleted(streamIndex, timestamp, sig) {
    if (!withdrawsCollection)
        return;
    await withdrawsCollection.updateOne({ streamIndex, timestamp }, { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } });
}
async function markWithdrawFailed(streamIndex, timestamp, reason) {
    if (!withdrawsCollection)
        return;
    await withdrawsCollection.updateOne({ streamIndex, timestamp }, { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } });
}
async function enqueueViewAuth(auth) {
    if (!viewsCollection)
        await connectQueue();
    try {
        const doc = {
            ...auth,
            status: 'pending',
            updatedAt: Date.now(),
        };
        await viewsCollection.insertOne(doc);
        return true;
    }
    catch (e) {
        if (e.code === 11000)
            return false;
        throw e;
    }
}
async function getPendingViewAuths(limit = 5) {
    if (!viewsCollection)
        await connectQueue();
    return viewsCollection.find({ status: 'pending' }).limit(limit).toArray();
}
async function markViewCompleted(streamIndex, timestamp, sig) {
    if (!viewsCollection)
        return;
    await viewsCollection.updateOne({ streamIndex, timestamp }, { $set: { status: 'completed', txSignature: sig, updatedAt: Date.now() } });
}
async function markViewFailed(streamIndex, timestamp, reason) {
    if (!viewsCollection)
        return;
    await viewsCollection.updateOne({ streamIndex, timestamp }, { $set: { status: 'failed', errorReason: reason, updatedAt: Date.now() } });
}
