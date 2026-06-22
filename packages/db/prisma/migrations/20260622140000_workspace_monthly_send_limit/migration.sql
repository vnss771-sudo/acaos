-- Opt-in monthly send ceiling. Additive and non-destructive: a nullable column, so
-- every existing workspace stays null = no monthly ceiling and send behaviour is
-- unchanged. A coarse backstop to the daily cap against sustained high volume.

ALTER TABLE "WorkspaceICP" ADD COLUMN "monthlySendLimit" INTEGER;
