import { Db, MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI?.trim() || '';
const dbName = process.env.MONGODB_DB_NAME?.trim() || 'expensee';

declare global {
  // eslint-disable-next-line no-var
  var __expenseeMongoClientPromise: Promise<MongoClient> | undefined;
}

function createClientPromise(): Promise<MongoClient> {
  if (!uri) {
    throw new Error('MONGODB_URI is not configured');
  }
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
  });
  return client.connect();
}

export function isMongoConfigured(): boolean {
  return Boolean(uri);
}

export async function getMongoDb(): Promise<Db> {
  if (!global.__expenseeMongoClientPromise) {
    global.__expenseeMongoClientPromise = createClientPromise();
  }
  const client = await global.__expenseeMongoClientPromise;
  return client.db(dbName);
}

