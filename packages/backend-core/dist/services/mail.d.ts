import nodemailer from 'nodemailer';
export declare function detectBounceRecipients(subject: string, fromAddress: string, body: string): string[];
export type SmtpConfig = {
    smtpHost?: string | null;
    smtpPort?: number | null;
    smtpSecure?: boolean | null;
    smtpUser?: string | null;
    smtpPass?: string | null;
    smtpFrom?: string | null;
};
export type ImapConfig = {
    imapHost?: string | null;
    imapPort?: number | null;
    imapSecure?: boolean | null;
    imapUser?: string | null;
    imapPass?: string | null;
};
export declare function isMailConfigured(cfg?: SmtpConfig | null): boolean;
export declare function isMailboxConfigured(cfg?: ImapConfig | null): boolean;
export declare function buildTransport(cfg?: SmtpConfig | null): nodemailer.Transporter<import("nodemailer/lib/smtp-transport/index.js").SentMessageInfo, import("nodemailer/lib/smtp-transport/index.js").Options>;
export declare function sendMail(to: string, subject: string, html: string, cfg?: SmtpConfig | null): Promise<import("nodemailer/lib/smtp-transport/index.js").SentMessageInfo>;
/**
 * Atomically record a processed inbound email and, when it maps to a non-
 * terminal lead, advance that lead to REPLIED. Extracted from syncMailboxOnce so
 * the integrity-critical persistence is testable without an IMAP server.
 *
 * Idempotent on `uid`: the processed-email insert is the gate. If this message
 * was already recorded (e.g. two mailbox syncs race past the caller's seen-uid
 * pre-filter), the unique constraint fires, the transaction rolls back, and we
 * return `{ advanced: false }` WITHOUT re-advancing the lead or signalling the
 * caller to re-enqueue reply analysis (which would double-spend AI).
 */
export declare function recordProcessedReply(params: {
    uid: number;
    messageId: string | null;
    fromAddress: string;
    workspaceId: string;
    lead: {
        id: string;
        stage: string;
    } | null;
}): Promise<{
    advanced: boolean;
}>;
export declare function syncMailboxOnce(cfg?: ImapConfig | null, workspaceId?: string): Promise<{
    inspected: number;
    matched: number;
    queued: number;
    skipped: number;
    bounced: number;
}>;
