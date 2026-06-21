#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-vnss771-sudo/acaos}"
BRANCH="${BRANCH:-$(gh repo view "${REPO}" --json defaultBranchRef --jq '.defaultBranchRef.name')}"

echo "Configuring branch protection for ${REPO}:${BRANCH}..."
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${BRANCH}/protection" \
  -F required_status_checks[strict]=true \
  -F required_status_checks[contexts][]=required \
  -F enforce_admins=true \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F restrictions=

echo "Setting repository variable ENABLE_CODE_SCANNING=true..."
gh variable set ENABLE_CODE_SCANNING \
  --repo "${REPO}" \
  --body "true"

echo "Creating environments..."
gh api --method PUT "/repos/${REPO}/environments/staging" >/dev/null
gh api --method PUT "/repos/${REPO}/environments/production" >/dev/null

echo "Set staging variables and secrets..."
read -rsp "METRICS_TOKEN (staging, optional): " STAGING_METRICS_TOKEN
echo
read -rp "SMOKE_API_URL (staging): " STAGING_SMOKE_API_URL
read -rp "SMOKE_WORKER_URL (staging): " STAGING_SMOKE_WORKER_URL

gh variable set SMOKE_API_URL --env staging --repo "${REPO}" --body "${STAGING_SMOKE_API_URL}"
gh variable set SMOKE_WORKER_URL --env staging --repo "${REPO}" --body "${STAGING_SMOKE_WORKER_URL}"
if [[ -n "${STAGING_METRICS_TOKEN}" ]]; then
  printf '%s' "${STAGING_METRICS_TOKEN}" | gh secret set METRICS_TOKEN --env staging --repo "${REPO}" --body -
fi

echo "Set production variables and secrets..."
read -rsp "METRICS_TOKEN (production, optional): " PROD_METRICS_TOKEN
echo
read -rp "SMOKE_API_URL (production): " PROD_SMOKE_API_URL
read -rp "SMOKE_WORKER_URL (production): " PROD_SMOKE_WORKER_URL

gh variable set SMOKE_API_URL --env production --repo "${REPO}" --body "${PROD_SMOKE_API_URL}"
gh variable set SMOKE_WORKER_URL --env production --repo "${REPO}" --body "${PROD_SMOKE_WORKER_URL}"
if [[ -n "${PROD_METRICS_TOKEN}" ]]; then
  printf '%s' "${PROD_METRICS_TOKEN}" | gh secret set METRICS_TOKEN --env production --repo "${REPO}" --body -
fi

echo "Verifying configuration..."
gh api "/repos/${REPO}/branches/${BRANCH}/protection" >/dev/null && echo "✓ Branch protection"
gh variable list --repo "${REPO}"
gh api "/repos/${REPO}/environments"
gh variable list --env staging --repo "${REPO}"
gh variable list --env production --repo "${REPO}"
gh secret list --env staging --repo "${REPO}"
gh secret list --env production --repo "${REPO}"

echo "Done."
