-- Opt-in domain warmup. Additive and non-destructive: a nullable column, so every
-- existing workspace stays null = no warmup (unchanged send-cap behaviour). When an
-- operator sets warmupStartedAt, the worker ramps the effective daily cap up from a
-- low ceiling over the warmup schedule instead of allowing the full dailySendLimit
-- on day one.

ALTER TABLE "WorkspaceICP" ADD COLUMN "warmupStartedAt" TIMESTAMP(3);
