#!/usr/bin/env bash
set -euo pipefail

echo "[1/5] Generate Prisma client"
npm run prisma:generate

echo "[2/5] Build web"
npm run build

echo "[3/5] Ensure env file exists"
[ -f .env ] || (echo ".env missing" && exit 1)

echo "[4/5] Reminder: run Prisma migrate manually in target environment"
echo "[5/5] Reminder: verify Stripe webhook and mailbox credentials"

echo "Release checklist script completed."
