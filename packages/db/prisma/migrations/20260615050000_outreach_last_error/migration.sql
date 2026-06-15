-- Add lastError for auditable FAILED sends in the outbox lifecycle.
ALTER TABLE "OutreachSent" ADD COLUMN "lastError" TEXT;
