#!/usr/bin/env bash
#
# Run a test command with the tenant guard enforcing, and fail if the guard
# blocked any query. The guard logs every block before it throws, so this also
# catches a block whose error a best-effort caller swallowed (`.catch(() => {})`),
# which would otherwise pass the test that ran it.
#
# Usage: bash scripts/with-tenant-guard.sh npm run test:db
#
# CI runs the database, Redis and browser tiers through this script, since
# production runs with TENANT_GUARD_MODE=enforce.
set -uo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

TENANT_GUARD_MODE=enforce "$@" 2>&1 | tee "$log"
status=$?

if grep -q '\[tenant-guard\]' "$log"; then
  echo "::error::The tenant guard blocked a query during this run. Search the output above for [tenant-guard] and scope that query to its workspace."
  exit 1
fi
exit "$status"
