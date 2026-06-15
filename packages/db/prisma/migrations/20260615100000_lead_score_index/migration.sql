-- Composite index to serve the default leads list (filter by workspace, order by
-- score DESC, createdAt DESC) from an index backward-scan instead of a per-request
-- full sort. Additive; no data change.

CREATE INDEX "Lead_workspaceId_score_createdAt_idx" ON "Lead"("workspaceId", "score", "createdAt");
