-- Workspace business context: free-text seller facts included in AI prompts.
-- Additive only.
ALTER TABLE "WorkspaceICP" ADD COLUMN "businessContext" TEXT;
