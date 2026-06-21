# GitHub Admin Checklist

These settings finish the last repo-governance gap that cannot be flipped from git
alone. The workflows and docs in this repo assume the repository is configured as
follows.

## Optional bootstrap script

To automate most one-time setup from a terminal with `gh` auth:

```bash
bash scripts/configure-github-admin.sh
```

The script configures branch protection, enables `ENABLE_CODE_SCANNING`, creates
`staging`/`production` environments, and prompts for smoke URLs + optional
`METRICS_TOKEN` per environment.

## Branch protection / ruleset

Apply this to the default branch (`main`, or `master` if that remains the default):

- Require a pull request before merging.
- Require approvals before merging.
- Dismiss stale approvals when new commits are pushed.
- Require status checks before merging.
- Mark these as the mandatory status checks:
  - **`required`** — the stable CI aggregator (from `ci.yml`).
  - **`Dependency review`** — the PR supply-chain dependency gate (from `security-pr.yml`).
  - **`Secret scan (gitleaks)`** — the PR committed-secret gate (from `security-pr.yml`).
- Require branches to be up to date before merging.
- Block force pushes.
- Block branch deletion.
- Include administrators.

Why `required`? The CI matrix intentionally fans out into variable job names. The
stable `required` aggregator gives branch protection one durable check name.

Why also list `Dependency review` and `Secret scan (gitleaks)` separately? Those
two checks live in a **separate workflow** (`security-pr.yml`), not in `ci.yml`,
so they cannot join the `required` aggregator's `needs:` graph. They must be
named as their own required contexts (using their exact GitHub check-run names,
i.e. the workflow job `name:` fields) or a PR that introduces a vulnerable
dependency or a committed secret could still merge. `configure-github-admin.sh`
sets all three contexts.

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
- Code scanning — after enabling, set the repository variable
  `ENABLE_CODE_SCANNING=true` so the CodeQL workflow uploads its SARIF results
  to the Security tab. Until that variable is set the analysis still runs on
  every PR but does not upload (upload would 403 and redden CI before code
  scanning is on).
- Secret scanning, if your plan supports it

## First run after enabling

1. Merge this branch.
2. Enable the settings above in the GitHub UI.
3. Trigger `CI`, `CodeQL`, and a manual `Release` dry run.
4. Protect the default branch with the `required`, `Dependency review`, and `Secret scan (gitleaks)` checks.
5. Verify Dependabot opens grouped PRs for npm, Docker, and GitHub Actions.
6. Run `Post-deploy smoke` once against `staging`, then once against `production`, and confirm the runtime reports the intended `releaseId`.
