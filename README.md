# ACAOS Production Enhanced

This package is a production-oriented scaffold for **Agentic Client Acquisition OS** with a launch kit, safer route handling, and a tested validation layer.

## What is included
- React/Vite frontend with login and dashboard shell
- Express API with JWT auth scaffold
- Prisma schema and repositories
- BullMQ worker + queue definitions
- OpenAI, Stripe, SMTP, and IMAP service scaffolds
- Launch docs, CI workflow, infra templates, and runbook
- Root typecheck, smoke, test, and audit-friendly scripts

## What was hardened
- Fixed signup flow to create user, workspace, and membership through the actual Prisma relations
- Normalized login and signup email handling
- Added async route wrappers and central API error handling
- Stopped leaking unexpected server errors in production responses
- Required a real JWT secret in production instead of silently using the default fallback
- Kept auth middleware from converting unexpected database failures into false 401 responses
- Tightened billing checkout authorization to owner/admin roles and verified checkout URLs
- Added safer service configuration guards and mailbox cleanup handling
- Added a pure-function test suite for validation, slug logic, and JWT secret behavior
- Fixed local Docker wiring for API port mapping, API base URL injection, and DB bootstrapping
- Upgraded the web toolchain so `npm audit` is clean in this environment

## Known limits
- Prisma client generation still depends on external Prisma engine downloads in some environments
- Postgres and Redis are required for full runtime validation
- Worker processors and external services remain scaffolds rather than live business logic
- Stripe webhook handling is still only scaffold-level and not fully implemented end to end

## Local setup
### Option A: local processes
1. Copy `.env.example` to `.env` and fill values
2. Run `npm install`
3. Run `npm run test`
4. Run `npm run typecheck`
5. Start Postgres and Redis
6. Run `npm run prisma:generate`
7. Run `npm run prisma:migrate`
8. Run `npm run dev:api`
9. Run `npm run dev:worker`
10. Run `npm run dev:web`

### Option B: Docker Compose
1. Run `docker compose -f docker-compose.local.yml up --build`
2. Open the web app on `http://localhost:5173`
3. The API will be available on `http://localhost:4000`

## Handy commands
- `npm run build`
- `npm run smoke:api`
- `npm run test`
- `npm run typecheck`
- `npm audit`
