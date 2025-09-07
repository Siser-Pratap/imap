// backend/src/server.ts
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

import { ensureIndex } from './lib/esClient';
import { getEmailByDocId } from './lib/esClient';
import { startWorkerForAccount, startAllWorkers, stopWorkerForAccount } from './services/imapManager';
import { encryptString } from './lib/crypto';

const prisma = new PrismaClient();
const app = express();
app.use(bodyParser.json());

const PORT = Number(process.env.PORT || 3000);

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date() }));

/**
 * Create IMAP account
 * body: { name, host, port, secure, username, password }
 * Password will be encrypted before saving (requires EMAILS_MASTER_KEY set).
 */
app.post('/api/accounts', async (req, res) => {
  try {
    const { name, host, port, secure, username, password } = req.body;
    if (!name || !host || !port || !username || !password) {
      return res.status(400).json({ error: 'name, host, port, username, password are required' });
    }
    let passwordToStore = password;
    try {
      if (process.env.EMAILS_MASTER_KEY) {
        passwordToStore = encryptString(password);
      }
    } catch (e) {
      console.warn('Failed to encrypt password; storing plaintext (not recommended).', e);
      passwordToStore = password;
    }

    const account = await prisma.account.create({
      data: { name, host, port: Number(port), secure: !!secure, username, password: passwordToStore }
    });

    // start worker
    startWorkerForAccount(account as any).catch(err => {
      console.error('Failed to start worker for newly created account', err);
    });

    return res.json({ account });
  } catch (err: any) {
    console.error('Create account error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/api/accounts', async (_req, res) => {
  const accounts = await prisma.account.findMany();
  res.json({ accounts });
});

app.post('/api/accounts/:id/disable', async (req, res) => {
  const id = Number(req.params.id);
  await prisma.account.update({ where: { id }, data: { enabled: false }});
  await stopWorkerForAccount(id);
  res.json({ ok: true });
});

/**
 * Search endpoint (unchanged)
 */
import { esClient, ES_INDEX } from './lib/esClient';
app.get('/api/emails', async (req, res) => {
  try {
    const { q, account, folder, label, fromDate, toDate } = req.query;
    const size = Math.min(100, Number(req.query.size || 50));
    const must: any[] = [];

    if (q) {
      must.push({
        multi_match: {
          query: String(q),
          fields: ['subject', 'bodyText', 'bodyHtml', 'from', 'to']
        }
      });
    }
    if (account) must.push({ term: { accountId: String(account) }});
    if (folder) must.push({ term: { folder: String(folder) }});
    if (label) must.push({ term: { labels: String(label) }});
    if (fromDate || toDate) {
      const range: any = {};
      if (fromDate) range.gte = String(fromDate);
      if (toDate) range.lte = String(toDate);
      must.push({ range: { receivedAt: range }});
    }

    const query = must.length ? { bool: { must } } : { match_all: {} };

    const resp = await esClient.search({
      index: ES_INDEX,
      size,
      query
    });

    const hits = resp.hits.hits.map((h:any) => ({ id: h._id, ...h._source }));
    res.json({ total: resp.hits.total, hits });
  } catch (err) {
    console.error('Search error', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/emails/:id
 * - id should be the canonical docId (accountId_base64MessageId) OR
 * - if the caller passes raw messageId, we accept that and construct docId automatically (accountId required as query param).
 *
 * Two modes:
 * 1) /api/emails/:docId -> returns doc by docId directly
 * 2) /api/emails/:messageId?account=123 -> server computes docId and returns
 */
app.get('/api/emails/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const account = req.query.account as string | undefined;
    let docId = id;
    if (account && !id.includes('_')) {
      // assume id is raw messageId, compute doc id
      // use same encoding as esClient.docIdFor -> import helper
      const { docIdFor } = await import('./lib/esClient');
      docId = docIdFor(account, id);
    }
    const result = await getEmailByDocId(docId);
    if (!result) return res.status(404).json({ error: 'not found' });
    // result._source is in result._source
    return res.json({ id: result._id, source: result._source });
  } catch (err) {
    console.error('Get email error', err);
    return res.status(500).json({ error: String(err) });
  }
});

async function boot() {
  try {
    await ensureIndex();
    await startAllWorkers();
    app.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Boot error', err);
    process.exit(1);
  }
}

boot().catch(err => {
  console.error('Unexpected boot failure', err);
});
