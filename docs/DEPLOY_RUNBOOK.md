# Deploy Runbook

This is the staging → production promotion path for ACAOS. It assumes the repo is
already green (`npm run verify`), release metadata is stamped, and GitHub
environments exist for `staging` and `production`.

## GitHub environment contract

Configure these **environment variables / secrets** in both GitHub environments:

| Scope | Name | Purpose |
|---|---|---|
| Variable | `SMOKE_API_URL` | Public API base URL, for example `https://api-staging.example.com` |
| Variable | `SMOKE_WORKER_URL` | Public worker health base URL, for example `https://worker-staging.example.com` |
| Secret | `METRICS_TOKEN` | Optional bearer token for `/metrics` smoke checks |

`production` should also require reviewer approval before the workflow can run.

## Release artifact

Every package build writes `dist-pack/release-manifest.json`. Treat this as the
immutable deployment contract:

```json
{
  "version": "1.3.0",
  "commit": "abc123…",
  "releaseId": "1.3.0+abc123def456"
}
```

The same release identity must surface again in:

- `X-Acaos-Release-Id`
- `GET /api/ready`
- `GET /ready`
- `acaos_build_info`

## Staging rollout

1. Merge to the protected default branch with the `required` check green.
2. Package the candidate:
   ```bash
   npm run release:preflight -- v1.3.0
   npm run pack
   ```
3. Deploy that artifact/image to `staging`.
4. Run staged smoke:
   ```bash
   npm run smoke:deploy -- --manifest dist-pack/release-manifest.json
   ```
   or use **Actions → Post-deploy smoke** with the `staging` environment.
5. Confirm:
   - API and worker readiness are `200`
   - `X-Acaos-Release-Id` matches the manifest
   - `version` and `commit` match the manifest
   - API and worker do not drift from each other
   - `/metrics` answers with `acaos_build_info` when `METRICS_TOKEN` is configured

## Production promotion

1. Promote the exact same artifact/config that passed staging.
2. Require `production` environment reviewers in GitHub before deploy/smoke.
3. Re-run the post-deploy smoke against `production`.
4. Watch the burn-rate alerts for at least one evaluation window before resuming
   normal deploy cadence.

## Rollback

Roll back immediately if any of these fail:

- staged smoke returns non-zero
- `X-Acaos-Release-Id` does not match `release-manifest.json`
- API and worker disagree on `releaseId`
- `/api/ready` or `/ready` is not green after rollout
- burn-rate alerts begin firing after deploy

Rollback steps:

1. Re-deploy the last known good artifact.
2. Re-run `smoke:deploy` against the rolled-back targets.
3. Record the failed `releaseId`, incident window, and suspected cause in the
   incident log / changelog.

## GitHub workflow path

Use `.github/workflows/post-deploy-smoke.yml` for remote verification. It supports:

- `workflow_dispatch` for manual staging/production checks
- `workflow_call` so other workflows can reuse the same rollout gate

The workflow defaults to the selected environment's `SMOKE_API_URL` /
`SMOKE_WORKER_URL` values, but allows one-off overrides for incident handling.
