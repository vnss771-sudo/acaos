# Database migrations & safe deploys

## TL;DR

The API must start with **`node scripts/start-with-migrations.mjs`**.
Do **not** use `prisma db push` in production — it can silently drop columns and
constraints when the schema changes (it once tried to drop the `Workspace`
unique index and crash-looped the API).

## What the startup script does

`scripts/start-with-migrations.mjs`:

1. Runs `prisma migrate deploy` — applies only the reviewed, versioned
   migrations in `packages/db/prisma/migrations/`.
2. **One-time auto-baseline:** if the database was first created with `db push`
   it has no migration history, so Prisma raises **P3005** on a non-empty DB.
   The script then marks the existing migrations as already-applied (this writes
   only to the `_prisma_migrations` ledger — it never touches table data) and
   retries the deploy.
3. Starts the server (`apps/api/dist/server.js`). If migrations can't be
   applied, it **exits non-zero and does not start** — a half-migrated API is
   worse than a failed deploy.

## Railway: switch the API service start command

Railway currently builds with Nixpacks and uses a custom start command that runs
`prisma db push --accept-data-loss`. Replace it:

1. API service → **Settings → Deploy → Custom Start Command**
2. Set it to exactly:

   ```
   node scripts/start-with-migrations.mjs
   ```

3. Redeploy.

On the first deploy with this command, you'll see `baselining N existing
migrations as applied…` in the logs (the one-time P3005 path). Every deploy
after that just runs `migrate deploy` and applies anything new.

### Rollback

If a deploy fails, revert the Custom Start Command to the previous value and
redeploy. The script only ever **adds** to the migration ledger, so reverting is
safe; no data is mutated by the baseline step.

## Day-to-day: creating a new migration

When you change `packages/db/prisma/schema.prisma`:

```bash
npx prisma migrate dev --name <change> --schema packages/db/prisma/schema.prisma
```

Commit the generated folder under `packages/db/prisma/migrations/`. The next
deploy applies it automatically via the startup script.
