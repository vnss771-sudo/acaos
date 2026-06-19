#!/usr/bin/env bash
# Reproducible release gate from a clean state — the answer to A+ review finding
# P0-1 ("builds must be reproducible even in constrained CI/container envs").
#
# Starts from no node_modules and no generated Prisma client, then runs the full
# offline gate. It deliberately does NOT run the service-backed suites
# (test:db / test:redis), Playwright e2e, or the Docker builds — those need a live
# Postgres/Redis/browser/Docker and are gated separately (npm run verify:services
# and the CI docker/e2e jobs). Run this on a clean checkout to prove the build is
# reproducible; CI caches the Prisma engine + node_modules for speed.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }

step "Clean (node_modules, generated Prisma client, dist)"
rm -rf node_modules apps/*/dist packages/*/dist

step "npm ci"
npm ci

step "Prisma generate"
npm run prisma:generate

step "Boundaries"
npm run check:boundaries

step "Lint"
npm run lint

step "Typecheck (all packages)"
npm run typecheck

step "Backend unit/integration tests (no live services)"
npm test

step "Web tests"
npm run test:web

step "Build (api + worker + web)"
npm run build

printf '\n\033[1;32m✓ Clean reproducible build + offline gate passed\033[0m\n'
printf 'Next, against live infra: npm run verify:services  (Postgres + Redis)\n'
printf '                          npm run test:e2e         (Playwright)\n'
