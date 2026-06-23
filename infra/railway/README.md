# Railway Deployment Notes

Create services for:
- Postgres
- Redis
- API
- Worker
- Web

Recommended order:
1. Provision Postgres and Redis
2. Deploy API with env vars
3. Deploy worker
4. Deploy web
5. Attach Stripe webhook URL to Railway API

## Database migrations

Do **not** run `prisma migrate` manually against Railway Postgres. The API
container starts with `node scripts/start-with-migrations.mjs` (see
`Dockerfile.api`), which runs versioned `prisma migrate deploy` on every boot —
applying only pending, reviewed migrations, with a one-time auto-baseline for a
database originally created via `db push`. If migrations cannot be applied the
container exits non-zero and refuses to start, rather than serving traffic
against an unmigrated schema.

A manual `prisma migrate` step is therefore redundant and risks racing the
startup migration. Just deploy the API; migrations apply themselves.
