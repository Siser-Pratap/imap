// backend/src/services/mailParser.ts
import { simpleParser, ParsedMail } from 'mailparser';

export async function parseRawEmail(raw: Buffer | string): Promise<{ text: string; html: string; subject?: string }> {
  try {
    const parsed: ParsedMail = await simpleParser(raw);
    const text = parsed.text || parsed.textAsHtml || '';
    const html = parsed.html || '';
    const subject = parsed.subject || '';
    return { text, html, subject };
  } catch (err) {
    // fallback: return raw as text
    const rawText = typeof raw === 'string' ? raw : raw.toString('utf8');
    return { text: rawText, html: '', subject: '' };
  }
}
