#!/usr/bin/env bash
set -euo pipefail

# ACAOS controlled-pilot release gate.
# Run against the exact archive/commit intended for deployment, with disposable
# Postgres/Redis available and production-like provider credentials configured.
#
# The policy contract deliberately runs FIRST: an unsafe production configuration
# must fail before we spend time on the expensive verification suites.

ARTIFACT_DIR="${PREFLIGHT_ARTIFACT_DIR:-dist-pack/preflight}"

mkdir -p "$ARTIFACT_DIR"

echo "== ACAOS pilot preflight =="
echo "0/7 strict production policy contract"
node scripts/preflight-contract.mjs --out-dir "$ARTIFACT_DIR"

echo "1/7 static/unit/web/build verification"
npm run verify

echo "2/7 DB + Redis service-backed verification"
npm run verify:services

echo "3/7 browser E2E"
npm run test:e2e

echo "4/7 live OpenAI adapter smoke"
npm run smoke:ai-provider

echo "5/7 live discovery-source smoke"
npm run smoke:discovery-sources

echo "6/7 release identity"
npm run release:metadata

echo "7/7 deployed release smoke (required when SMOKE_API_URL/SMOKE_WORKER_URL are configured)"
if [[ -n "${SMOKE_API_URL:-}" || -n "${SMOKE_WORKER_URL:-}" || -n "${SMOKE_WEB_URL:-}" ]]; then
  # Bind the smoke test to this exact candidate rather than merely checking that
  # *some* healthy ACAOS release is deployed.
  eval "$(npm run --silent release:metadata:env)"
  export EXPECT_VERSION="$ACAOS_RELEASE_VERSION"
  export EXPECT_COMMIT="$ACAOS_RELEASE_SHA"
  export EXPECT_RELEASE_ID="$ACAOS_RELEASE_ID"
  npm run smoke:deploy
else
  echo "WARN: no SMOKE_* deployment URLs supplied; post-deploy API/worker release matching was not checked by this run."
fi

echo "PASS: controlled-pilot code/test/provider policy gate is green."
echo "Preflight artifacts: ${ARTIFACT_DIR}/release-preflight.json and ${ARTIFACT_DIR}/release-preflight.md"
echo "Operational drills (rollback/restore and a real mailbox send→reply→unsubscribe flow) still require target-environment execution and evidence."
