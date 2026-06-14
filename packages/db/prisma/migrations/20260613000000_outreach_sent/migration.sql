-- OutreachSent: closed-loop email tracking for campaigns.
-- Stores every email dispatched via the campaign send feature, with a
-- unique SMTP Message-ID column for inbound reply correlation.

CREATE TABLE "OutreachSent" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId"  TEXT,
    "leadId"      TEXT,
    "toEmail"     TEXT NOT NULL,
    "subject"     TEXT NOT NULL,
    "body"        TEXT NOT NULL,
    "messageId"   TEXT,
    "status"      TEXT NOT NULL DEFAULT 'SENT',
    "repliedAt"   TIMESTAMP(3),
    "replyIntent" TEXT,
    "sentAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachSent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutreachSent_messageId_key" ON "OutreachSent"("messageId");
CREATE INDEX "OutreachSent_workspaceId_idx"      ON "OutreachSent"("workspaceId");
CREATE INDEX "OutreachSent_campaignId_idx"        ON "OutreachSent"("campaignId");
CREATE INDEX "OutreachSent_leadId_idx"            ON "OutreachSent"("leadId");
CREATE INDEX "OutreachSent_toEmail_idx"           ON "OutreachSent"("toEmail");

ALTER TABLE "OutreachSent"
    ADD CONSTRAINT "OutreachSent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutreachSent"
    ADD CONSTRAINT "OutreachSent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OutreachSent"
    ADD CONSTRAINT "OutreachSent_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
