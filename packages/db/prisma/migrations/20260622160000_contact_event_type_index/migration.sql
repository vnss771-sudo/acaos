-- Back the sender-reputation guard's per-type windowed counts. evaluateSenderReputation
-- counts ContactEvent rows by (workspaceId, type='SENT'|'BOUNCED', occurredAt >= window)
-- once per send batch; the existing indexes lead with emailKey/campaignId, so a
-- type-only aggregation couldn't use them. Additive, non-destructive (CREATE INDEX).

CREATE INDEX "ContactEvent_workspaceId_type_occurredAt_idx"
  ON "ContactEvent"("workspaceId", "type", "occurredAt");
