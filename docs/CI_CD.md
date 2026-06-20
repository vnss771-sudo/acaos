# CI/CD

This repo now uses two GitHub Actions workflows:

- `CI` — every push to `main`/`master`, every pull request, and manual runs.
- `Release` — semver tags (`v*.*.*`) and manual packaging runs.

## Required branch protection check

Configure branch protection to require exactly this status check:

- `required`

That job is a stable aggregator for the full CI graph. Individual matrix jobs can expand to names like `Standalone build (api)` or `Docker image (worker)`, but branch protection should point at the single stable `required` job so the protected check name does not drift when the matrix changes.

## CI design

`CI` enforces:
- dependency install via `npm ci`
- npm cache via `actions/setup-node`
- Prisma generation before any TypeScript or build step
- static gates: audit, boundaries, frontend mutation guard, lint, typecheck
- fast unit/backend coverage tests and frontend tests
- production build from the repo root
- standalone service builds for `apps/api` and `apps/worker` (matrix)
- a deterministic offline build (`build-deterministic`): installs with the
  Prisma postinstall suppressed, then generates explicitly and builds, proving
  the build never depends on a live engine download
- Docker image assembly for API, worker, and web (matrix), with runtime
  boot-smoke + Trivy scans on the API and worker images
- DB-backed tests against PostgreSQL (plus a schema-drift check)
- Redis-backed tests against Redis + PostgreSQL
- Playwright browser smoke tests with cached Playwright browser binaries
- a stable `required` aggregator job that fails if any of the above did not
  succeed — this is the single check to require in branch protection

## Release flow

### Normal release
1. Merge to `main` with green CI.
2. Create a semver tag:
   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```
3. GitHub Actions runs the `Release` workflow, re-verifies the repo, builds `dist-pack/acaos-source.zip`, uploads it as a workflow artifact, and publishes or refreshes the GitHub Release asset.

### Manual dry-run
Use **Actions → Release → Run workflow** to package any branch, tag, or SHA without publishing a GitHub Release.

### Manual republish of an existing tag
Use **Actions → Release → Run workflow**, set:
- `publish = true`
- `release_tag = vX.Y.Z`
- `ref = vX.Y.Z`

That rebuilds the release asset from the existing tag and updates the GitHub Release attachment.

## Environments and approvals

Create these GitHub environments in repository settings:

- `staging`
- `production`

Configure `production` with:
- required reviewers
- prevent self-review
- environment secrets needed for real deployments

The `Release` workflow targets:
- `staging` for manual packaging runs
- `production` for tag-driven releases

## Local preflight

Before cutting a release locally:

```bash
npm run release:preflight -- v1.2.3
```

That script checks for a clean git tree, runs the `verify` gate (static + unit +
build — i.e. `npm run verify`), builds the tracked-files source archive, and
prints the tag push command. Note this is the no-services gate: it does **not**
reproduce the DB/Redis/Docker/e2e CI jobs, so a green preflight is necessary but
not sufficient — the PR's CI `required` check is the authority.
