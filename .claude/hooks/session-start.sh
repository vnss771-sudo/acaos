#!/bin/bash
# SessionStart hook for Claude Code on the web: install workspace dependencies
# so lint, typecheck and the unit test tier work from the first prompt.
set -euo pipefail

# Local sessions manage their own node_modules.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `npm install` (not `npm ci`) so the cached container's node_modules is reused.
# postinstall generates the Prisma client, falling back to the checked-in
# offline stub when the engines can't be downloaded.
npm install --no-audit --no-fund
