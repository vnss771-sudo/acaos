-- Mailbox reply-sync cursor: persist the highest processed IMAP UID per workspace
-- so sync fetches strictly above it instead of a fixed last-200 window — no reply
-- can be silently skipped after an outage or on a busy inbox. lastUidValidity pins
-- the mailbox UIDVALIDITY so a mailbox reset invalidates a now-stale cursor.
-- Additive: new columns only.
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "lastSyncedUid" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkspaceEmailConfig" ADD COLUMN "lastUidValidity" INTEGER;
