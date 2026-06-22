-- Make AI prompt provenance find-or-create atomic: one AiPromptVersion row per
-- distinct generator config (workspace, type, promptHash). Additive — the table is
-- newly used (previously dead schema), so no existing rows can violate the unique.
-- A concurrent duplicate-hash insert now collides (P2002) and the resolver re-reads
-- the winner instead of creating a second version for the same hash.

CREATE UNIQUE INDEX "AiPromptVersion_workspaceId_type_promptHash_key"
  ON "AiPromptVersion"("workspaceId", "type", "promptHash");
