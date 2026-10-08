#!/usr/bin/env bash
set -euo pipefail

# ACAOS controlled-pilot release gate.
# Run against the exact archive/commit intended for deployment, with disposable
# Postgres/Redis available and production-like provider credentials configured.

required=(OPENAI_API_KEY)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "pilot-preflight: missing required environment variable: ${name}" >&2
    exit 1
  fi
done

echo "== ACAOS pilot preflight =="
echo "1/6 static/unit/web/build verification"
npm run verify

echo "2/6 DB + Redis service-backed verification"
npm run verify:services

echo "3/6 browser E2E"
npm run test:e2e

echo "4/6 live OpenAI adapter smoke"
npm run smoke:ai-provider

echo "5/6 live discovery-source smoke"
npm run smoke:discovery-sources

echo "6/6 release identity"
npm run release:metadata

echo "PASS: code/test/provider preflight is green."
echo "Still verify the deployed release ID, safe-launch/tenant/reputation settings, rollback, and AusTender cursor→record→match→card flow in the target environment."
