# CI/CD

This repo uses four GitHub-native automation layers:

- `CI` — push/PR/manual verification with a stable `required` status check.
- `CodeQL` — scheduled and PR-time static security analysis for JavaScript/TypeScript.
- `Dependabot` — grouped npm, Docker, and GitHub Actions updates.
- `Release` — semver tags (`v*.*.*`) and manual packaging runs.

The last GitHub UI actions that cannot be stored in git are documented in
[`GITHUB_ADMIN.md`](./GITHUB_ADMIN.md).

## Required branch protection check

Configure branch protection to require exactly this status check:

- `required`

That job is a stable aggregator for the full CI graph. Individual matrix jobs can expand to names like `Standalone build (api)` or `Docker image (worker)`, but branch protection should point at the single stable `required` job so the protected check name does not drift when the matrix changes.

## CI design

`CI` enforces:
- workflow action pinning (full-length commit SHAs) + monitoring/runbook/dashboard
  asset consistency (the `repo-hardening` job)
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

## Security automation

### Code scanning
`CodeQL` runs on pushes, pull requests, a weekly schedule, and manual dispatch.
It analyzes the JavaScript/TypeScript source tree with GitHub's
`security-and-quality` query suite. (Requires GitHub code scanning to be enabled
for the repo — see [`GITHUB_ADMIN.md`](./GITHUB_ADMIN.md).)

### Dependency and workflow updates
`Dependabot` is configured for npm workspaces at the repo root, GitHub Actions
workflow dependencies, and Docker base-image references. Updates are grouped to
reduce PR noise while still letting security fixes land quickly.

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

## Release metadata and deploy smoke

`release.yml` now computes immutable release metadata, writes `dist-pack/release-manifest.json`, and carries that metadata into packaging. Docker builds stamp `ACAOS_RELEASE_VERSION`, `ACAOS_RELEASE_SHA`, and `ACAOS_BUILD_TIME` into the API and worker images.

`post-deploy-smoke.yml` is a manual deploy-gate workflow that runs `npm run smoke:deploy` against the API `/api/ready` and worker `/ready` endpoints, optionally enforcing `--expect-version` and `--expect-commit`, and fails on API/worker release drift.
