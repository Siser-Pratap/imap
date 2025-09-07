// backend/src/types/email.d.ts
export interface EmailDoc {
  messageId: string;
  accountId: string;
  folder: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  receivedAt: string | Date;
  labels?: string[];
  raw?: string;
}
