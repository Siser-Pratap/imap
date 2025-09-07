// backend/src/lib/esClient.ts
import { Client } from '@elastic/elasticsearch';
import dotenv from 'dotenv';
dotenv.config();

export const ES_INDEX = process.env.ES_INDEX || 'emails_v1';
export const esClient = new Client({
  node: process.env.ES_URL || 'http://localhost:9200',
  maxRetries: 3,
  requestTimeout: 60000
});

/** Normalize messageId -> encoded id safe for doc id */
export function encodedMessageId(messageId: string) {
  // messageId might be like "<abcd@domain>" - base64 to keep id safe
  return Buffer.from(messageId).toString('base64url'); // base64url available in Node 18+
}

export function docIdFor(accountId: string | number, messageId: string) {
  const enc = encodedMessageId(messageId || `${Date.now()}-${Math.random()}`);
  return `${accountId}_${enc}`;
}

export async function ensureIndex() {
  try {
    const exists = await esClient.indices.exists({ index: ES_INDEX });
    if (!exists) {
      await esClient.indices.create({
        index: ES_INDEX,
        body: {
          mappings: {
            properties: {
              messageId: { type: 'keyword' },
              accountId: { type: 'keyword' },
              folder: { type: 'keyword' },
              from: { type: 'text' },
              to: { type: 'text' },
              subject: { type: 'text' },
              bodyText: { type: 'text' },
              bodyHtml: { type: 'text' },
              receivedAt: { type: 'date' },
              labels: { type: 'keyword' },
              raw: { type: 'text' }
            }
          }
        }
      });
      console.log('Elasticsearch index created:', ES_INDEX);
    } else {
      console.log('Elasticsearch index exists:', ES_INDEX);
    }
  } catch (err) {
    console.error('Error ensuring ES index:', err);
    throw err;
  }
}

/** Check if a doc with this accountId + messageId exists */
export async function docExists(accountId: string | number, messageId: string) {
  const id = docIdFor(accountId, messageId);
  try {
    const { body } = await esClient.exists({ index: ES_INDEX, id });
    return !!body;
  } catch (err) {
    console.error('Error checking doc exists', err);
    return false;
  }
}

/** Index email using messageId -> encoded id to avoid duplicates */
export async function indexEmail(doc: Record<string, any>) {
  const id = docIdFor(doc.accountId, doc.messageId);
  try {
    await esClient.index({
      index: ES_INDEX,
      id,
      document: doc
    });
  } catch (err) {
    console.error('Failed to index email', id, err);
    throw err;
  }
}

/** Get doc by docId (account_messageId-encoded) */
export async function getEmailByDocId(docId: string) {
  try {
    const { body } = await esClient.get({ index: ES_INDEX, id: docId });
    return body;
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return null;
    throw err;
  }
}
