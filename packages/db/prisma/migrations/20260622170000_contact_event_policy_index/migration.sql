-- Serve canContactRecipient's per-recipient lookups. The policy checker runs
-- findFirst(type='REPLIED'), findFirst(type='SENT', occurredAt>=gap) and a monthly
-- count(type='SENT', occurredAt>=30d), all keyed on (workspaceId, emailKey, type).
-- The existing (workspaceId, emailKey, occurredAt) index orders occurredAt before
-- type, forcing a post-scan type filter; this composite serves them directly.
-- Additive, non-destructive.

CREATE INDEX "ContactEvent_workspaceId_emailKey_type_occurredAt_idx"
  ON "ContactEvent"("workspaceId", "emailKey", "type", "occurredAt");
