# ACAOS — Full Codebase Analysis Report

**Generated:** 2026-06-05  
**Repository:** vnss771-sudo/acaos  
**Branch at analysis:** main (HEAD `76ef40f`)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Structure](#2-repository-structure)
3. [Technology Stack](#3-technology-stack)
4. [Architecture Overview](#4-architecture-overview)
5. [Key Modules & Components](#5-key-modules--components)
6. [Database Schema](#6-database-schema)
7. [API Surface](#7-api-surface)
8. [Frontend Architecture](#8-frontend-architecture)
9. [Background Workers](#9-background-workers)
10. [Configuration & Environment](#10-configuration--environment)
11. [Testing](#11-testing)
12. [Deployment & Infrastructure](#12-deployment--infrastructure)
13. [Dependencies](#13-dependencies)
14. [Security Analysis](#14-security-analysis)
15. [Code Quality & Observations](#15-code-quality--observations)
16. [Known Gaps & Recommendations](#16-known-gaps--recommendations)

---

## 1. Executive Summary

**ACAOS** is a full-stack, multi-tenant **B2B SaaS application scaffold** built for AI-powered sales outreach automation. It implements the complete lifecycle of lead generation and email outreach: prospect management, AI-driven research and message generation, background email sync, Stripe billing, and a React-based dashboard.

**Key characteristics:**
- Monorepo with three independently deployable services (API, Web, Worker)
- Multi-tenant workspace model with role-based membership
- OpenAI integration for lead research, outreach drafting, and reply classification
- Stripe billing with subscription management
- BullMQ job queues for reliable asynchronous processing
- Docker-first local development; Railway + Vercel for production

**Current maturity:** Production-ready scaffolding — all routes, services, and workers are wired, but some business-logic bodies are at template/stub level (notably AI prompts and IMAP sync).

---

## 2. Repository Structure

```
acaos/
├── apps/
│   ├── api/                        # Express backend API (Node.js / TypeScript)
│   │   └── src/
│   │       ├── server.ts           # Entry point, Express app bootstrap
│   │       ├── routes/             # Route handlers (auth, leads, campaigns, billing, …)
│   │       ├── middleware/         # Auth JWT verification, rate limiting
│   │       ├── lib/                # Shared utilities (jwt, validation, prisma, queues)
│   │       ├── services/           # External service wrappers (openai, stripe, mail)
│   │       └── types/              # TypeScript interfaces
│   ├── web/                        # React / Vite SPA
│   │   └── src/
│   │       ├── main.tsx            # React DOM entry point
│   │       ├── App.tsx             # Root component, routing, auth state
│   │       ├── components/         # Shared UI (AuthScreen, Sidebar, Toast, Spinner)
│   │       ├── views/              # Page-level components (6 views)
│   │       ├── hooks/              # Custom React hooks (useApi, useToast)
│   │       └── types.ts            # Shared frontend TypeScript types
│   └── worker/                     # BullMQ background job processor
│       └── src/
│           ├── worker.ts           # Worker entry point, queue consumers
│           └── lib/queue.ts        # Shared Redis connection config
├── packages/
│   └── db/                         # Prisma schema and generated client (shared)
│       └── prisma/schema.prisma
├── infra/
│   ├── railway/                    # Railway deployment documentation
│   └── render/                     # Render deployment config
├── scripts/                        # Utility scripts
├── tests/                          # Test suite
│   └── api-validation.test.ts      # Unit tests for validation and auth logic
├── docs/                           # Project documentation
├── Dockerfile.api                  # API container image (Node 22-alpine)
├── Dockerfile.web                  # Web container (multi-stage: build → Nginx)
├── Dockerfile.worker               # Worker container image (Node 22-alpine)
├── docker-compose.local.yml        # Local dev: Postgres + Redis + 3 services
├── nginx.conf                      # Nginx reverse proxy config for SPA
├── vercel.json                     # Vercel SPA routing config
├── railway.json                    # Railway platform config
├── .env.example                    # All required environment variables documented
└── package.json                    # Monorepo root (npm workspaces)
```

---

## 3. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Runtime** | Node.js | 22.x (Docker base) |
| **Language** | TypeScript | 5.5.4 |
| **Frontend** | React | 18.3.1 |
| **Build tool** | Vite | 8.0.7 |
| **Backend** | Express.js | 4.19.2 |
| **ORM** | Prisma | 5.18.0 |
| **Database** | PostgreSQL | (via Prisma) |
| **Job Queue** | BullMQ | 5.12.12 |
| **Cache/Queue Broker** | Redis (via ioredis) | 5.4.1 |
| **Auth** | jsonwebtoken + bcryptjs | 9.0.2 / 2.4.3 |
| **AI** | OpenAI API | v6.0.0 client |
| **Payments** | Stripe | 16.8.0 |
| **Email (outbound)** | Nodemailer | 8.0.5 |
| **Email (inbound)** | imapflow | 1.0.181 |
| **Containerization** | Docker + Docker Compose | — |

---

## 4. Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                           │
│                    React + Vite (port 5173)                     │
└──────────────────────────┬─────────────────────────────────────┘
                           │ HTTPS / REST
┌──────────────────────────▼─────────────────────────────────────┐
│                     Express API (port 4000)                     │
│  Routes: auth · leads · campaigns · ai · billing · mailbox     │
│  Middleware: JWT auth · rate limiting · CORS                    │
│  Services: OpenAI · Stripe · Nodemailer                        │
│  Lib: Prisma client · BullMQ queues · JWT · validation         │
└───────────┬──────────────────────────┬──────────────────────────┘
            │ PostgreSQL               │ Redis (job enqueue)
┌───────────▼────────────┐  ┌─────────▼──────────────────────────┐
│   PostgreSQL Database  │  │         BullMQ Worker              │
│   (Prisma ORM)         │  │  Queues: research-lead             │
│                        │  │          generate-outreach         │
│   Users · Workspaces   │  │          analyze-reply             │
│   Leads · Campaigns    │  │          sync-mailbox              │
│   OutreachDrafts       │  │                                    │
│   RefreshTokens        │  │  Calls: OpenAI · IMAP · Prisma     │
└────────────────────────┘  └────────────────────────────────────┘
```

### Multi-Tenancy Model

- **User** authenticates globally; belongs to one or more **Workspaces** via **Membership**
- All domain objects (Leads, Campaigns, OutreachDrafts) are scoped to a **Workspace**
- API enforces workspace membership checks on every protected route via `userBelongsToWorkspace()`
- Workspace has its own Stripe `customerId` and `subscriptionId` for per-tenant billing

---

## 5. Key Modules & Components

### 5.1 API Server (`apps/api/src/`)

#### Routes

| File | LOC | Responsibility |
|------|-----|----------------|
| `routes/auth.ts` | ~199 | Signup, login, logout, token refresh, current user |
| `routes/leads.ts` | ~228 | CRUD, filtering, pagination, bulk import, stage updates |
| `routes/campaigns.ts` | ~116 | Campaign CRUD, lead association |
| `routes/billing.ts` | ~193 | Stripe checkout, subscription info, webhook handler |
| `routes/ai.ts` | ~65 | Trigger AI research, generate outreach, analyze replies |
| `routes/mailbox.ts` | ~43 | Mailbox config save, manual sync trigger |
| `routes/workspaces.ts` | ~156 | Workspace CRUD, member management |
| `routes/stats.ts` | ~118 | Dashboard metrics, analytics aggregation |
| `routes/jobs.ts` | ~133 | Job status polling, queue inspection |

#### Middleware

| File | Responsibility |
|------|----------------|
| `middleware/auth.ts` | Extracts Bearer token, verifies JWT, attaches `req.user` |
| `middleware/rateLimit.ts` | Request rate limiting per IP/route |

#### Library Utilities

| File | Responsibility |
|------|----------------|
| `lib/http.ts` | `ApiError`, `asyncHandler`, 404 and error handler middleware |
| `lib/jwt.ts` | `signAccessToken`, `signRefreshToken`, `verifyAccessToken`, refresh token hashing |
| `lib/validation.ts` | Email normalization, password rules, slug sanitization |
| `lib/workspaces.ts` | `userBelongsToWorkspace`, slug uniqueness checks |
| `lib/prisma.ts` | Prisma client singleton |
| `lib/env.ts` | Required environment variable validation at startup |
| `lib/queues.ts` | BullMQ `Queue` factory, shared Redis connection |

#### Services

| File | Responsibility |
|------|----------------|
| `services/openai.ts` | `researchLead`, `generateOutreach`, `analyzeReply` — OpenAI chat wrappers |
| `services/stripe.ts` | `createCheckoutSession`, `getSubscription`, event parsing |
| `services/mail.ts` | SMTP send via Nodemailer, IMAP sync via imapflow |

---

### 5.2 Frontend (`apps/web/src/`)

#### Views

| View | Responsibility |
|------|----------------|
| `Dashboard.tsx` | Workspace statistics overview |
| `Leads.tsx` | Paginated lead table, filters, detail panel, bulk actions, stage tracking |
| `Campaigns.tsx` | Campaign list, creation, deletion |
| `AiTools.tsx` | Three tabs: research lead, generate outreach, analyze reply |
| `Billing.tsx` | Stripe subscription status, checkout redirect |
| `Settings.tsx` | User profile, workspace settings, mailbox SMTP/IMAP config |

#### Key Hooks

- **`useApi`** — wraps `fetch` with auth header injection, 401 auto-refresh via refresh token, token persistence in `localStorage`
- **`useToast`** — toast queue management (add, auto-dismiss)

#### Shared Components

- **`AuthScreen`** — login / signup form with tab switching
- **`Sidebar`** — navigation links, workspace switcher dropdown
- **`Toast`** — notification overlay container
- **`Spinner`** — loading indicator

---

## 6. Database Schema

### Entities & Relations

```
User
 ├─ id, email (unique), passwordHash
 ├─ createdAt, updatedAt
 └─ → Memberships (many), RefreshTokens (many)

Workspace
 ├─ id, name, slug (unique)
 ├─ stripeCustomerId, stripeSubscriptionId, stripePriceId
 ├─ subscriptionStatus (TRIALING | ACTIVE | PAST_DUE | CANCELED | NONE)
 ├─ mailConfig (JSON: SMTP + IMAP settings)
 └─ → Memberships (many), Leads (many), Campaigns (many)

Membership
 ├─ userId (FK → User), workspaceId (FK → Workspace)
 ├─ role (OWNER | MEMBER)
 └─ unique(userId, workspaceId)

Campaign
 ├─ id, name, workspaceId (FK)
 └─ → Leads (many)

Lead
 ├─ id, email, firstName, lastName, company, title, linkedinUrl, phone, notes
 ├─ stage (NEW | RESEARCHED | OUTREACH_DRAFTED | SENT | REPLIED | CONVERTED | UNSUBSCRIBED)
 ├─ aiResearch (text), aiSummary (text)
 ├─ workspaceId (FK), campaignId (FK, optional)
 └─ → OutreachDrafts (many)

OutreachDraft
 ├─ id, subject, body, followupBody
 ├─ leadId (FK → Lead), workspaceId (FK)
 └─ createdAt

RefreshToken
 ├─ id, tokenHash (unique), userId (FK)
 ├─ expiresAt, createdAt, revokedAt (optional)
 └─ Cascade delete with User
```

### Design Notes
- All FK relationships use `onDelete: Cascade` — deleting a Workspace removes all its children
- `Lead.stage` is a 7-state enum tracking the outreach pipeline
- `Workspace.mailConfig` stored as free-form JSON (allows flexible SMTP/IMAP config)
- Composite unique index on `Membership(userId, workspaceId)` prevents duplicate memberships

---

## 7. API Surface

### Auth (`/api/auth`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/signup` | — | Create user + default workspace |
| POST | `/login` | — | Return access + refresh tokens |
| POST | `/logout` | Bearer | Revoke refresh token |
| POST | `/refresh` | — | Exchange refresh token for new access token |
| GET | `/me` | Bearer | Current user info + workspaces |

### Workspaces (`/api/workspaces`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Bearer | List user's workspaces |
| POST | `/` | Bearer | Create new workspace |
| GET | `/:id` | Bearer | Get workspace details |
| PATCH | `/:id` | Bearer | Update workspace name/slug |
| DELETE | `/:id` | Bearer | Delete workspace |
| GET | `/:id/members` | Bearer | List members |
| DELETE | `/:id/members/:userId` | Bearer | Remove member |

### Leads (`/api/leads`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Bearer | List leads (pagination, filters) |
| POST | `/` | Bearer | Create lead |
| POST | `/bulk` | Bearer | Bulk import leads |
| GET | `/:id` | Bearer | Get lead detail |
| PATCH | `/:id` | Bearer | Update lead fields |
| DELETE | `/:id` | Bearer | Delete lead |
| PATCH | `/:id/stage` | Bearer | Update lead stage |

### Campaigns (`/api/campaigns`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Bearer | List campaigns |
| POST | `/` | Bearer | Create campaign |
| GET | `/:id` | Bearer | Get campaign + leads |
| PATCH | `/:id` | Bearer | Update campaign |
| DELETE | `/:id` | Bearer | Delete campaign |

### AI (`/api/ai`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/research/:leadId` | Bearer | Queue AI research job for lead |
| POST | `/outreach/:leadId` | Bearer | Queue outreach generation job |
| POST | `/analyze/:leadId` | Bearer | Queue reply analysis job |

### Billing (`/api/billing`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/subscription` | Bearer | Get workspace subscription status |
| POST | `/checkout` | Bearer | Create Stripe checkout session |
| POST | `/webhook` | — | Stripe webhook handler (raw body) |

### Mailbox (`/api/mailbox`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/config` | Bearer | Save SMTP/IMAP config to workspace |
| POST | `/sync` | Bearer | Trigger manual IMAP sync job |

### Stats (`/api/stats`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Bearer | Workspace-level dashboard metrics |
| GET | `/leads` | Bearer | Lead stage breakdown |
| GET | `/campaigns` | Bearer | Per-campaign statistics |

### Jobs (`/api/jobs`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Bearer | List recent jobs for workspace |
| GET | `/:jobId` | Bearer | Get specific job status |

---

## 8. Frontend Architecture

### State Management
- **Auth state:** `localStorage` tokens + React `useState` in `App.tsx`
- **Workspace state:** current workspace stored in React state, synced from `/api/auth/me`
- No global state manager (Redux/Zustand) — state is local to components and lifted to `App.tsx`

### Routing
- Client-side routing via conditional rendering in `App.tsx` (no react-router)
- Six named views selected via `currentView` state variable
- Sidebar triggers view changes via `onNavigate` prop

### API Communication
- `useApi` hook wraps native `fetch`
- Injects `Authorization: Bearer <token>` header
- Handles 401 responses by attempting token refresh before retrying
- Persists new tokens to `localStorage` on successful refresh

### Styling
- Centralized design tokens in `styles.ts` (colors, spacing, font sizes)
- All styling via inline CSS objects (no CSS framework, no CSS modules)
- Responsive design implemented inline per component

---

## 9. Background Workers

### Queue Architecture (BullMQ + Redis)

| Queue | Concurrency | Purpose |
|-------|-------------|---------|
| `research-lead` | 2 | AI-powered lead research via OpenAI |
| `generate-outreach` | 2 | Generate subject, email body, followup |
| `analyze-reply` | 2 | Classify incoming email replies |
| `sync-mailbox` | 1 | IMAP mailbox sync per workspace |

### Job Lifecycle
1. API route enqueues job with `leadId` / `workspaceId` payload
2. BullMQ delivers job to worker
3. Worker executes processor, calls OpenAI/IMAP, updates Prisma records
4. Progress tracked via BullMQ job state (waiting → active → completed/failed)
5. Failed jobs tracked with error message via `job.log()`

### Retry Policy
- `sync-mailbox`: custom exponential backoff delay
- Other queues: BullMQ default retry behavior

### Graceful Shutdown
- SIGTERM/SIGINT caught by worker process
- All workers call `worker.close()` before exit
- 10-second timeout for in-flight job completion

---

## 10. Configuration & Environment

### Required Environment Variables

| Category | Variable | Description |
|----------|----------|-------------|
| **Server** | `PORT` | API listen port (default 4000) |
| | `NODE_ENV` | `development` / `production` |
| | `API_URL` | Public API base URL |
| | `WEB_URL` | Public web app URL |
| **Auth** | `JWT_SECRET` | Access token signing secret |
| | `JWT_EXPIRES_IN` | Access token TTL (e.g. `15m`) |
| | `REFRESH_TOKEN_SECRET` | Refresh token signing secret |
| | `REFRESH_TOKEN_EXPIRES_IN` | Refresh token TTL (e.g. `7d`) |
| **Database** | `DATABASE_URL` | PostgreSQL connection string |
| **Redis** | `REDIS_URL` | Redis connection URL |
| **OpenAI** | `OPENAI_API_KEY` | OpenAI secret key |
| | `OPENAI_MODEL` | Model name (e.g. `gpt-4o`) |
| **Stripe** | `STRIPE_SECRET_KEY` | Stripe API key |
| | `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| | `STRIPE_PRICE_ID` | Subscription price ID |
| **Mail (SMTP)** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Outbound email |
| **Mail (IMAP)** | `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` | Inbound mailbox sync |

### Local Development (Docker Compose)
```
docker-compose -f docker-compose.local.yml up
```
Services: Postgres (5432) + Redis (6379) + API (4000) + Worker + Web (5173)

---

## 11. Testing

### Framework
- **Node.js built-in test runner** (`node:test`) with `assert/strict`
- Executed via `tsx` (TypeScript-native runner)

### Coverage (single file: `tests/api-validation.test.ts`, 171 LOC)

| Area | Tests |
|------|-------|
| Email validation and normalization | 3 |
| Password strength validation | 1 |
| String helper utilities | 3 |
| Workspace name and slug generation | 5 |
| JWT signing and verification | 4 |
| JWT tamper detection | 1 |
| Refresh token generation, hashing, uniqueness | 4 |
| **Total** | **21** |

### Gaps
- No integration tests (API routes, database, queues)
- No frontend tests (component or E2E)
- No load/performance tests
- No coverage reporting configured

---

## 12. Deployment & Infrastructure

### Local Development
- **Docker Compose** (`docker-compose.local.yml`)
- Spins up: PostgreSQL, Redis, API, Worker, Web (with live-reload)
- Health checks configured for Postgres and Redis

### Production: Railway (Primary)
- Three Railway services: `api`, `worker`, `web`
- Each has its own `Dockerfile` and `railway.toml`
- Railway injects environment variables from dashboard
- Deployment sequence: provision Postgres + Redis → deploy API → deploy Worker → deploy Web
- `railway run npx prisma migrate deploy` for database migrations

### Production: Vercel (Web Frontend)
- `vercel.json` configures SPA routing (all paths rewrite to `/index.html`)
- Build command: `npm run build` in `apps/web`
- Suitable for CDN-edge delivery of static assets

### Production: Render (Alternative)
- `infra/render/` directory contains Render-specific config
- Backup deployment option if Railway is not preferred

### Container Images
| Image | Base | Notes |
|-------|------|-------|
| `Dockerfile.api` | node:22-alpine | Includes Prisma client generation |
| `Dockerfile.web` | node:22-alpine → nginx:alpine | Multi-stage, static asset serve |
| `Dockerfile.worker` | node:22-alpine | Copies `apps/api/src` for shared imports |

---

## 13. Dependencies

### Production

| Package | Version | Purpose |
|---------|---------|---------|
| express | 4.19.2 | HTTP web framework |
| cors | 2.8.5 | CORS header middleware |
| prisma / @prisma/client | 5.18.0 | ORM and DB access |
| bcryptjs | 2.4.3 | Password hashing |
| jsonwebtoken | 9.0.2 | JWT auth tokens |
| dotenv | 16.4.5 | Environment variable loading |
| openai | 6.0.0 | OpenAI API client |
| stripe | 16.8.0 | Stripe billing SDK |
| nodemailer | 8.0.5 | SMTP email sending |
| imapflow | 1.0.181 | IMAP mailbox sync |
| bullmq | 5.12.12 | Redis-backed job queues |
| ioredis | 5.4.1 | Redis client |
| tsx | 4.16.2–4.20.6 | TypeScript execution |
| react / react-dom | 18.3.1 | UI library |

### Dev / Build

| Package | Version | Purpose |
|---------|---------|---------|
| typescript | 5.5.4 | Static type checking |
| vite | 8.0.7 | Frontend build tool |
| @vitejs/plugin-react | 6.0.1 | Vite React plugin |
| @types/* | various | TypeScript definitions |

---

## 14. Security Analysis

### Implemented Controls

| Control | Implementation |
|---------|---------------|
| **Password storage** | bcryptjs hashing (industry-standard) |
| **Authentication** | Short-lived JWT access tokens (configurable TTL) |
| **Token refresh** | Refresh tokens stored as SHA-256 hashes, not plaintext |
| **CORS** | Restricted to `WEB_URL`, `railway.app`, `vercel.app` origins in production |
| **Rate limiting** | Per-route rate limiting middleware |
| **Input validation** | Email normalization, password strength checks, slug sanitization |
| **Error masking** | Internal errors masked in production (`NODE_ENV === 'production'`) |
| **Workspace isolation** | `userBelongsToWorkspace()` check on all tenant-scoped routes |
| **Stripe webhooks** | Webhook signature verification via Stripe SDK |
| **Env validation** | Required env vars checked at startup; process exits on missing vars |

### Security Considerations

| Area | Observation | Risk |
|------|-------------|------|
| **Refresh token revocation** | No revocation list — tokens remain valid until expiry even after logout | Medium |
| **SQL injection** | Prisma ORM with parameterized queries — not directly vulnerable | Low |
| **XSS** | React renders safely by default; no `dangerouslySetInnerHTML` visible | Low |
| **Secrets in code** | `.gitignore` excludes `.env`; `.env.example` has no real values | Low |
| **IMAP credentials** | Stored as JSON in `Workspace.mailConfig` in database — encryption at rest depends on DB config | Medium |
| **JWT secret strength** | No minimum entropy enforced on `JWT_SECRET`; operator responsibility | Low |
| **Refresh token rotation** | No automatic rotation on use — same token reused until expiry | Low-Medium |
| **CORS wildcard** | `railway.app`/`vercel.app` are broad — any Railway/Vercel tenant could match | Low |

---

## 15. Code Quality & Observations

### Strengths

- **Clear separation of concerns** — routes, services, lib, middleware are well-organized
- **TypeScript throughout** — strict typing reduces runtime errors
- **Centralized error handling** — `asyncHandler` + `ApiError` + global error middleware
- **Async/await patterns** — consistent, no callback pyramids
- **Multi-stage Docker builds** — smaller production images
- **Monorepo workspace** — shared `packages/db` avoids schema duplication
- **Graceful shutdown** — both API and Worker handle SIGTERM correctly
- **Environment validation** — startup fails fast on missing configuration
- **21 unit tests** — core validation and auth logic covered

### Areas to Improve

| Area | Detail |
|------|--------|
| **Test coverage** | Only unit tests for lib utilities; no route/integration/E2E tests |
| **Frontend state** | No centralized state manager; prop-drilling to deeply nested components |
| **Frontend routing** | No react-router; routing is manual conditional rendering |
| **Worker processors** | AI job processor bodies are template-level; prompts need production tuning |
| **Hard-coded values** | Rate limit thresholds and CORS origins embedded in code, not config |
| **No OpenAPI spec** | No machine-readable API docs (Swagger/OpenAPI) |
| **No logging library** | Uses `console.log/error`; no structured logging (Winston, Pino) |
| **No monitoring hooks** | No APM, health metric exports, or alerting integration |

---

## 16. Known Gaps & Recommendations

### High Priority

1. **Integration tests** — Add tests for API routes using a test database to prevent regressions
2. **Structured logging** — Replace `console.*` with Pino or Winston for production observability
3. **Refresh token rotation** — Rotate refresh token on each use and maintain a revocation list
4. **AI prompt quality** — Production-tune OpenAI prompts in worker processors with real examples
5. **IMAP credential encryption** — Encrypt mailbox credentials before storing in the database

### Medium Priority

6. **React Router** — Adopt react-router for proper URL-based navigation and browser history
7. **Global state management** — Add Zustand or Context API for shared app state
8. **OpenAPI documentation** — Generate API spec with tools like `zod-openapi` or `swagger-jsdoc`
9. **Rate limit configuration** — Move thresholds to environment variables
10. **Database connection pooling** — Evaluate and configure Prisma connection pool size for load

### Low Priority

11. **Frontend testing** — Add Vitest + React Testing Library for component tests
12. **E2E testing** — Add Playwright tests for critical user flows (signup → create lead → AI research)
13. **CI/CD pipeline** — Add GitHub Actions for typecheck, test, and build on every PR
14. **CORS tightening** — Use exact domain matching instead of suffix matching for `railway.app`/`vercel.app`
15. **Stripe metered billing** — Extend billing to usage-based pricing for AI API calls

---

*End of report.*
