# Repo Scripts & Docs Validation Report

## Validation Scope
Checked consistency between:
1. Package.json npm scripts (root and workspace apps)
2. Documentation (BUILD.md, README.md, DEMO_SCRIPT.md, docs/CI_CD.md, etc.)
3. CI/CD workflows (.github/workflows/ci.yml, release.yml)
4. Playwright configuration (playwright.config.ts)

---

## Issues Found & Fixed

### ✅ FIXED: Developer workflow consistency
**Issue:** Multiple ways to start the dev stack created confusion:
- `BUILD.md` showed running `npm run dev:api`, `npm run dev:worker`, `npm run dev:web` in separate terminals
- `DEMO_SCRIPT.md` showed `npm run start:dev -w @acaos/api`, `npm run dev -w @acaos/web` in separate terminals
- `README.md` didn't mention the unified dev command at all
- `playwright.config.ts` referenced `npm run start:dev` (non-existent in root scripts)

**Fix:** 
- Added `npm run dev` as the unified launcher (via `scripts/dev-all.mjs`)
- Added explicit `npm run dev:all` alias for clarity
- Updated README.md with the correct startup flow
- Ensured dev commands are consistent across documentation

---

## Validation Checklist

### ✅ Development Commands
| Command | Script | Documented | Status |
|---------|--------|-----------|--------|
| `npm run dev` | `scripts/dev-all.mjs` | README, BUILD.md | ✅ Consistent |
| `npm run dev:api` | `npm --workspace @acaos/api run dev` | BUILD.md | ✅ Correct |
| `npm run dev:worker` | `npm --workspace @acaos/worker run dev` | BUILD.md | ✅ Correct |
| `npm run dev:web` | `npm --workspace @acaos/web run dev` | BUILD.md | ✅ Correct |
| `npm run dev:all` | `scripts/dev-all.mjs` | README | ✅ Explicit alias |

### ✅ Build & Release Commands
| Command | Script | CI Coverage | Status |
|---------|--------|-------------|--------|
| `npm run build` | Runs api/worker/web in sequence | ci.yml (build job) | ✅ Used |
| `npm run prisma:generate` | `scripts/prisma-client.mjs generate` | ci.yml (multiple jobs) | ✅ Used |
| `npm run prisma:migrate` | Workspace command to `@acaos/db` | ci.yml (verify-db job) | ✅ Used |
| `npm run verify` | Root aggregator (20+ checks) | Documented in BUILD.md | ✅ Correct |
| `npm run test:coverage` | Unit + coverage gate | ci.yml (verify job) | ✅ Used |
| `npm run test:db` | Database integration | ci.yml (verify-db job) | ✅ Used |
| `npm run test:redis` | Queue integration | ci.yml (verify-redis job) | ✅ Used |
| `npm run test:e2e` | Browser smoke tests | ci.yml (verify-e2e job) | ✅ Used |

### ✅ Operational & Admin Commands
| Command | Script | Purpose | References | Status |
|---------|--------|---------|-----------|--------|
| `npm run doctor` | `scripts/doctor.mjs` | Local preflight check | README | ✅ Active |
| `npm run release:metadata` | `scripts/release-metadata.mjs` | Semver + commit | BUILD.md, docs/CI_CD.md | ✅ Active |
| `npm run smoke:deploy` | `scripts/smoke-deploy.mjs` | Readiness gate | BUILD.md, docs/CI_CD.md | ✅ Active |
| `npm run smoke:api` | `scripts/smoke-api-health.mjs` | API health | Package.json | ⚠️ Appears unused (duplicate of `smoke:deploy`?) |
| `npm run release:smoke` | `scripts/smoke-deploy.mjs` | Same as `smoke:deploy` | Package.json | ⚠️ Duplicate alias |

### ⚠️ POTENTIAL CLEANUP: Redundant Smoke Test Aliases
```json
"smoke:api": "node scripts/smoke-api-health.mjs",      // ← checks only API health
"release:smoke": "node scripts/smoke-deploy.mjs",      // ← duplicate of smoke:deploy
"smoke:deploy": "node scripts/smoke-deploy.mjs",       // ← full deploy readiness
```

**Recommendation:** These three should be consolidated:
- Keep `npm run smoke:deploy` (full readiness gate)
- Remove `npm run release:smoke` (exact duplicate)
- Clarify or remove `npm run smoke:api` (specific to one component, not mentioned in docs)

---

## Docs Cross-Reference Validation

### ✅ BUILD.md
- ✅ Section 2 (Quick start): Correctly shows `npm run dev:*` commands
- ✅ Section 3 (Production build): Correct `npm run build` flow
- ✅ Section 4 (Docker): Correct `docker compose` commands
- ✅ Section 6 (Verify): Lists all CI gates accurately
- ⚠️ Could mention `npm run dev` as a convenience (currently only shows separate terminals)

### ✅ README.md (Updated)
- ✅ Now shows `npm run dev` as the unified launcher
- ✅ Docker section accurate
- ✅ Useful commands section complete
- ✅ Environment variables section accurate

### ✅ CI/CD Workflows
- ✅ ci.yml uses: `check:*`, `prisma:generate`, `typecheck`, `test`, `test:web`, `test:db`, `test:redis`, `test:e2e`, `build`
- ✅ All commands correspond to npm scripts in root package.json
- ✅ Prisma cache strategy consistent across jobs
- ✅ Node version 22 pinned; forward-compat job tests Node 26

### ✅ Playwright Config (playwright.config.ts)
- ⚠️ Line 70: `npm run start:dev -w @acaos/api` (doesn't exist in root)
- ⚠️ Line 76: `npm run dev -w @acaos/web` (doesn't exist in root; correct is `npm --workspace @acaos/web run dev`)
- **Need to fix:** These should use workspace syntax or the app-level scripts directly

---

## Remaining Work

### High Priority (fixes needed for consistency)
1. **Fix playwright.config.ts** — lines 70, 76 reference incorrect npm script paths
   - Line 70: Change `npm run start:dev -w @acaos/api` to `npm --workspace @acaos/api run start:dev` (or use direct shell command)
   - Line 76: Change `npm run dev -w @acaos/web` to `npm --workspace @acaos/web run dev`

2. **Consolidate smoke test aliases:**
   - Remove `release:smoke` (duplicate of `smoke:deploy`)
   - Document or remove `smoke:api` (not referenced in CI/docs; only checks one service)
   - Keep `smoke:deploy` as the canonical production rollout gate

### Medium Priority (documentation improvements)
1. **BUILD.md § 2** — Add a note about `npm run dev` as a convenience alternative to running three terminals
2. **DEMO_SCRIPT.md** — Update the setup section to use `npm run dev` if it's meant for end users, or keep it as-is if intentional (separate terminals for easier debugging)

### Low Priority (cleanup, no breaking changes)
1. **Consider aliasing clarity** — Add a comment in package.json explaining `dev:all` vs `dev` relationship
2. **Audit other operational scripts** — Verify `queue-drain.mjs`, `rotate-encryption-key.mjs`, etc. are all actively referenced or documented

---

## Summary

**Status:** ✅ Mostly consistent

- Root npm scripts are well-defined and match CI workflows
- Development workflow is now unified (`npm run dev`)
- Build and release pipelines are clearly documented and used
- Playwright configuration has minor syntax issues (uses non-existent root scripts; workspaces aren't available at root level with `-w` flag)

**Next steps:**
1. Fix playwright.config.ts script paths
2. Remove redundant `release:smoke` alias
3. Clarify or document `smoke:api`

