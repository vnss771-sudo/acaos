-- Opt-in send window (quiet hours). Additive and non-destructive: nullable hour
-- columns + a defaulted boolean, so every existing workspace stays "no window" and
-- send timing is unchanged. When an operator sets both hours, the worker only sends
-- within [startHour, endHour) local to sendTimezone (optionally weekdays only).

ALTER TABLE "WorkspaceICP" ADD COLUMN "sendWindowStartHour" INTEGER;
ALTER TABLE "WorkspaceICP" ADD COLUMN "sendWindowEndHour" INTEGER;
ALTER TABLE "WorkspaceICP" ADD COLUMN "sendTimezone" TEXT;
ALTER TABLE "WorkspaceICP" ADD COLUMN "sendWeekdaysOnly" BOOLEAN NOT NULL DEFAULT false;
