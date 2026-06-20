# GitHub Admin Checklist

These settings finish the last repo-governance gap that cannot be flipped from git
alone. The workflows and docs in this repo assume the repository is configured as
follows.

## Optional bootstrap script

To automate most one-time setup from a terminal with `gh` auth:

```bash
bash scripts/configure-github-admin.sh
```

The script configures branch protection, creates `staging`/`production`
environments, and prompts for smoke URLs + optional `METRICS_TOKEN` per
environment.

## Branch protection / ruleset

Apply this to the default branch (`main`, or `master` if that remains the default):

- Require a pull request before merging.
- Require approvals before merging.
- Dismiss stale approvals when new commits are pushed.
- Require status checks before merging.
- Mark **`required`** as the single mandatory status check.
- Require branches to be up to date before merging.
- Block force pushes.
- Block branch deletion.
- Include administrators.

Why `required`? The CI matrix intentionally fans out into variable job names. The
stable `required` aggregator gives branch protection one durable check name.

## Environments

Create these environments:

### `staging`
- No production secrets.
- Optional reviewer gate.
- Add environment variables `SMOKE_API_URL` and `SMOKE_WORKER_URL`.
- Optional: add `SMOKE_WEB_URL` and secret `METRICS_TOKEN` for deeper smoke coverage.
- Used by manual packaging runs in `Release` and `Post-deploy smoke`.

### `production`
- Add required reviewers from the release-owning group.
- Restrict secrets to the production deploy/release path only.
- Add environment variables `SMOKE_API_URL` and `SMOKE_WORKER_URL`.
- Optional: add `SMOKE_WEB_URL` and secret `METRICS_TOKEN`.
- Used by semver tag releases in `Release` and `Post-deploy smoke`.

## Security features

Enable these repository features in GitHub settings:

- Dependabot alerts
- Dependabot security updates
- Dependency graph
- Code scanning — once enabled in GitHub settings, the CodeQL workflow is
  already configured to upload its SARIF results to the Security tab.
- Secret scanning, if your plan supports it

## First run after enabling

1. Merge this branch.
2. Enable the settings above in the GitHub UI.
3. Trigger `CI`, `CodeQL`, and a manual `Release` dry run.
4. Protect the default branch with the `required` check.
5. Verify Dependabot opens grouped PRs for npm, Docker, and GitHub Actions.
6. Run `Post-deploy smoke` once against `staging`, then once against `production`, and confirm the runtime reports the intended `releaseId`.
