// backend/src/services/imapManager.ts
import { ImapFlow, MailboxLock } from 'imapflow';
import { indexEmail, docExists, docIdFor } from '../lib/esClient';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { parseRawEmail } from './mailParser';
import { decryptString } from '../lib/crypto';
dotenv.config();

const prisma = new PrismaClient();

type AccountRow = {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string; // encrypted
  enabled: boolean;
};

type Worker = {
  client: ImapFlow;
  account: AccountRow;
  connected: boolean;
  reconnectAttempts: number;
  shuttingDown?: boolean;
};

const workers = new Map<number, Worker>();

function rawToText(sourceBuffer?: Buffer): string {
  if (!sourceBuffer) return '';
  try {
    return sourceBuffer.toString('utf8');
  } catch {
    return sourceBuffer.toString('latin1');
  }
}

/** Attempt to extract Message-ID header from ParsedMail or raw */
function extractMessageId(parsed: any, rawText: string) {
  if (parsed && parsed.messageId) return parsed.messageId;
  // try regex from raw
  const m = rawText.match(/^\s*Message-ID:\s*(.+)$/im) || rawText.match(/^\s*Message-Id:\s*(.+)$/im);
  if (m && m[1]) return m[1].trim();
  // fallback to unique synthetic id
  return `<generated-${Date.now()}-${Math.random()}>`;
}

/**
 * Fetch last 30 days for a single mailbox
 */
async function fetchLast30DaysForMailbox(client: ImapFlow, accountId: number, mailbox = 'INBOX') {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  try {
    await client.mailboxOpen(mailbox, { readOnly: true });
    const uids = await client.search({ since });
    if (!uids || uids.length === 0) return;
    for await (const msg of client.fetch(uids, { envelope: true, source: true, internalDate: true, uid: true })) {
      const raw = msg.source as Buffer | undefined;
      const parsed = await parseRawEmail(raw ?? '');
      const rawText = rawToText(raw);
      const messageId = extractMessageId(parsed, rawText);
      // dedupe by messageId + account
      const exists = await docExists(String(accountId), messageId);
      if (exists) continue;
      const doc = {
        messageId,
        accountId: String(accountId),
        folder: mailbox,
        from: (msg.envelope?.from || []).map((f:any)=>f.address).join(', '),
        to: (msg.envelope?.to || []).map((f:any)=>f.address).join(', '),
        subject: parsed.subject || msg.envelope?.subject || '',
        bodyText: parsed.text || rawText,
        bodyHtml: parsed.html || '',
        receivedAt: msg.internalDate ?? new Date(),
        labels: [],
        raw: rawText
      };
      try { await indexEmail(doc); } catch (err) { console.error('Indexing error historical', err); }
    }
  } catch (err) {
    console.error(`Error fetching mailbox ${mailbox}`, err);
  }
}

/**
 * Handle new message in a mailbox by seq number
 */
async function handleNewMessageInMailbox(client: ImapFlow, account: AccountRow, mailbox: string, seqNo: number) {
  try {
    for await (const msg of client.fetch(`${seqNo}:${seqNo}`, { envelope: true, source: true, internalDate: true, uid: true })) {
      const raw = msg.source as Buffer | undefined;
      const parsed = await parseRawEmail(raw ?? '');
      const rawText = rawToText(raw);
      const messageId = extractMessageId(parsed, rawText);
      const exists = await docExists(String(account.id), messageId);
      if (exists) {
        console.log('Duplicate message skipped', messageId);
        return;
      }
      const doc = {
        messageId,
        accountId: String(account.id),
        folder: mailbox,
        from: (msg.envelope?.from || []).map((f:any)=>f.address).join(', '),
        to: (msg.envelope?.to || []).map((f:any)=>f.address).join(', '),
        subject: parsed.subject || msg.envelope?.subject || '',
        bodyText: parsed.text || rawText,
        bodyHtml: parsed.html || '',
        receivedAt: msg.internalDate ?? new Date(),
        labels: [],
        raw: rawText
      };
      try {
        await indexEmail(doc);
        console.log(`Indexed new message ${doc.messageId} for account ${account.id} mailbox ${mailbox}`);
      } catch (err) {
        console.error('Indexing error for new message', err);
      }
    }
  } catch (err) {
    console.error('Error fetching new message by seq', err);
  }
}

/**
 * Start worker for account: enumerates mailboxes, fetch last 30 days for each,
 * and registers event listeners to handle new messages per selected mailbox.
 */
export async function startWorkerForAccount(account: AccountRow) {
  if (workers.has(account.id)) {
    console.log(`Worker already running for account ${account.id}`);
    return;
  }

  // decrypt password before connecting
  let passwordPlain = account.password;
  try {
    // if it looks base64 (our encrypt output), try decrypt; else assume plain
    if (process.env.EMAILS_MASTER_KEY) {
      try {
        passwordPlain = decryptString(account.password);
      } catch (e) {
        // if decryption fails, assume stored plaintext (backwards compatibility)
        passwordPlain = account.password;
      }
    }
  } catch (err) {
    console.warn('Could not decrypt password, using stored value (fallback).', err);
  }

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.username, pass: passwordPlain },
    logger: false
  });

  const worker: Worker = { client, account, connected: false, reconnectAttempts: 0 };
  workers.set(account.id, worker);

  async function connectAndListen() {
    if (worker.shuttingDown) return;
    try {
      await client.connect();
      worker.connected = true;
      worker.reconnectAttempts = 0;
      console.log(`IMAP connected for account ${account.id} (${account.name})`);

      // enumerate mailboxes
      try {
        const boxes = await client.listMailboxes();
        // flatten nested mailbox structures into names array
        const mailboxNames: string[] = [];
        function recurse(box: any) {
          if (box && box.name) mailboxNames.push(box.name);
          if (box && box.children) box.children.forEach((c: any) => recurse(c));
        }
        recurse(boxes);

        // For each mailbox: fetch last 30 days and setup a listener
        for (const m of mailboxNames) {
          try {
            // open mailbox (read-only for historical)
            await fetchLast30DaysForMailbox(client, account.id, m);
            // select mailbox (read-write) to receive events for new messages in it
            await client.mailboxOpen(m);
            // listen for 'exists' event — but it fires for currently selected mailbox only
            // To capture events across many mailboxes we attach a per-mailbox listener by opening them when needed.
            client.on('exists', async (count) => {
              // since 'exists' applies to currently selected mailbox, check which one is selected
              try {
                const mb = await client.mailboxOpen(m);
                const total = mb.exists;
                if (!total || total <= 0) return;
                await handleNewMessageInMailbox(client, account, m, total);
              } catch (e) {
                // ignore
              }
            });
          } catch (err) {
            console.warn(`Could not fetch or subscribe mailbox ${m} for account ${account.id}`, err);
          }
        }
      } catch (err) {
        console.warn('Could not list mailboxes:', err);
      }

      client.on('error', (err) => {
        console.error(`IMAP client error for account ${account.id}:`, err);
      });

      client.on('close', async () => {
        console.warn(`IMAP connection closed for account ${account.id}`);
        worker.connected = false;
        if (!worker.shuttingDown) retryConnect();
      });

      client.on('end', () => {
        console.warn(`IMAP connection ended for account ${account.id}`);
        worker.connected = false;
        if (!worker.shuttingDown) retryConnect();
      });

    } catch (err) {
      console.error(`Failed to connect IMAP for account ${account.id}:`, err);
      worker.connected = false;
      retryConnect();
    }
  }

  function retryConnect() {
    if (worker.shuttingDown) return;
    worker.reconnectAttempts = (worker.reconnectAttempts || 0) + 1;
    const delay = Math.min(30000, 1000 * Math.pow(2, worker.reconnectAttempts)); // exp backoff up to 30s
    console.log(`Reconnecting to IMAP for account ${account.id} in ${delay}ms`);
    setTimeout(() => {
      if (!worker.shuttingDown) connectAndListen();
    }, delay);
  }

  connectAndListen().catch(err => {
    console.error('Unhandled error starting worker', err);
  });
}

export async function stopWorkerForAccount(accountId: number) {
  const w = workers.get(accountId);
  if (!w) return;
  w.shuttingDown = true;
  try {
    await w.client.logout();
  } catch (err) {
    console.warn('Error logging out IMAP client:', err);
  }
  workers.delete(accountId);
  console.log(`Worker stopped for account ${accountId}`);
}

export async function startAllWorkers() {
  const accounts = await prisma.account.findMany({ where: { enabled: true } });
  for (const a of accounts) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    startWorkerForAccount(a as AccountRow).catch(err => {
      console.error('startWorkerForAccount error', err);
    });
  }
}
