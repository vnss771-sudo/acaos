# Raw-SQL-only indexes

Partial unique indexes that Prisma's schema can't express, re-created
idempotently on every API start by `scripts/start-with-migrations.mjs`, one file
at a time so one failure can't block the others.

A database that was ever managed with `prisma db push` never has them (push only
knows `schema.prisma`, and `--accept-data-loss` drops unknown indexes), and
baselining such a database marks their migrations applied without running them.
On a database built by `migrate deploy` every file is a no-op.

When a migration adds a new raw-SQL-only object, add a file here too, with the
definition copied exactly.
