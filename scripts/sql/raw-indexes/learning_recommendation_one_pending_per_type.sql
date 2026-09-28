-- From migration 20260929000000_learning_recommendations (keep identical).
-- At most one PENDING recommendation per (workspace, type) (processors.ts relies on it).
CREATE UNIQUE INDEX IF NOT EXISTS "LearningRecommendation_one_pending_per_type"
  ON "LearningRecommendation" ("workspaceId", "type")
  WHERE "status" = 'PENDING';
