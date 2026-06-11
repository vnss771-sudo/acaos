-- Append-only send ledger + engagement events + signal combination performance tracking

-- MessageSend: one row per sent message, never mutated
CREATE TABLE "MessageSend" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "prospectId"     TEXT NOT NULL,
    "channel"        TEXT NOT NULL,
    "subject"        TEXT,
    "bodyText"       TEXT,
    "recipientEmail" TEXT,
    "sentAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageSend_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageSend_workspaceId_idx"        ON "MessageSend"("workspaceId");
CREATE INDEX "MessageSend_prospectId_idx"         ON "MessageSend"("prospectId");
CREATE INDEX "MessageSend_workspaceId_sentAt_idx" ON "MessageSend"("workspaceId", "sentAt");

ALTER TABLE "MessageSend"
    ADD CONSTRAINT "MessageSend_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageSend"
    ADD CONSTRAINT "MessageSend_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EngagementEvent: append-only open/click/reply/bounce events
CREATE TABLE "EngagementEvent" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId"  TEXT NOT NULL,
    "sendId"      TEXT NOT NULL,
    "eventType"   TEXT NOT NULL,
    "metadata"    JSONB,
    "occurredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EngagementEvent_workspaceId_idx"            ON "EngagementEvent"("workspaceId");
CREATE INDEX "EngagementEvent_sendId_idx"                 ON "EngagementEvent"("sendId");
CREATE INDEX "EngagementEvent_prospectId_idx"             ON "EngagementEvent"("prospectId");
CREATE INDEX "EngagementEvent_workspaceId_eventType_idx"  ON "EngagementEvent"("workspaceId", "eventType");
CREATE INDEX "EngagementEvent_workspaceId_occurredAt_idx" ON "EngagementEvent"("workspaceId", "occurredAt");

ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_prospectId_fkey"
    FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EngagementEvent"
    ADD CONSTRAINT "EngagementEvent_sendId_fkey"
    FOREIGN KEY ("sendId") REFERENCES "MessageSend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SignalCombinationPerformance: outcome counts per signal pattern per workspace
CREATE TABLE "SignalCombinationPerformance" (
    "id"               TEXT NOT NULL,
    "workspaceId"      TEXT NOT NULL,
    "vertical"         TEXT,
    "signalPattern"    TEXT NOT NULL,
    "sentCount"        INTEGER NOT NULL DEFAULT 0,
    "openCount"        INTEGER NOT NULL DEFAULT 0,
    "clickCount"       INTEGER NOT NULL DEFAULT 0,
    "replyCount"       INTEGER NOT NULL DEFAULT 0,
    "meetingCount"     INTEGER NOT NULL DEFAULT 0,
    "unsubscribeCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignalCombinationPerformance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SignalCombinationPerformance_workspaceId_signalPattern_key"
    ON "SignalCombinationPerformance"("workspaceId", "signalPattern");

CREATE INDEX "SignalCombinationPerformance_workspaceId_idx"
    ON "SignalCombinationPerformance"("workspaceId");

CREATE INDEX "SignalCombinationPerformance_workspaceId_replyCount_idx"
    ON "SignalCombinationPerformance"("workspaceId", "replyCount");

ALTER TABLE "SignalCombinationPerformance"
    ADD CONSTRAINT "SignalCombinationPerformance_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
