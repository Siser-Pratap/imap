// backend/src/lib/crypto.ts
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const MASTER_KEY = process.env.EMAILS_MASTER_KEY;
if (!MASTER_KEY) {
  console.warn('EMAILS_MASTER_KEY is not set. Password encryption will fail if used.');
}

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // 256-bit

function getKey() {
  if (!MASTER_KEY) throw new Error('EMAILS_MASTER_KEY not set in env');
  // normalize key to 32 bytes using SHA256
  return crypto.createHash('sha256').update(MASTER_KEY).digest().slice(0, KEY_LEN);
}

export function encryptString(plain: string) {
  const iv = crypto.randomBytes(12); // 96-bit recommended for GCM
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // return base64 of iv + tag + cipher
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptString(ciphertextB64: string) {
  const data = Buffer.from(ciphertextB64, 'base64');
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28); // 16 bytes tag
  const encrypted = data.slice(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
