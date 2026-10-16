#!/usr/bin/env bash
#
# LOCAL full-stack run of the technician-to-manager photo workflow (C5e). Starts, on loopback only:
#   * a throwaway S3-compatible server (SeaweedFS in Docker) with a bucket and exact-origin CORS,
#   * an ephemeral PostgreSQL cluster (migrated) and Redis,
#   * the real API and the real worker (BullMQ finalisation), with evidence uploads enabled FOR THIS RUN ONLY,
#   * the production web build behind the production CSP (plus the loopback storage origin, local test only),
# then runs e2e/evidence-workflow.spec.ts in real Chromium and tears everything down.
#
# Needs: Docker (daemon running), postgres + redis-server binaries, Playwright's Chromium (or ACAOS_CHROMIUM).
# Touches no Railway/R2 account, no production credential, and enables nothing outside this process tree.
set -euo pipefail

cd "$(dirname "$0")/.."
RUN_DIR="$(mktemp -d /tmp/acaos-e2e-evidence.XXXXXX)"; chmod 755 "${RUN_DIR}"
PGPORT="${E2E_PGPORT:-55433}"; REDISPORT="${E2E_REDISPORT:-56380}"; S3PORT="${E2E_S3PORT:-8333}"
PGDATA="${RUN_DIR}/pg"; DBNAME="acaos_e2e_evidence"; S3NAME="acaos-e2e-evidence-s3"
PIDS=()

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "${PGBIN}" ] || [ ! -x "${PGBIN}/postgres" ]; then PGBIN="$(dirname "$(command -v postgres)")"; fi
RUN=()
if [ "$(id -u)" = "0" ]; then RUN=(runuser -u postgres --); fi

cleanup() {
  # Each background service runs in its own session, so kill the whole process group (npx/tsx spawn children).
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -- "-$p" >/dev/null 2>&1 || true; done
  "${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" stop -m immediate >/dev/null 2>&1 || true
  docker rm -f "${S3NAME}" >/dev/null 2>&1 || true
  [ "${KEEP_LOGS:-0}" = "1" ] || rm -rf "${RUN_DIR}"
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || { echo "[e2e-evidence] Docker daemon is not running"; exit 1; }

echo "[e2e-evidence] S3-compatible server on 127.0.0.1:${S3PORT}"
mkdir -p "${RUN_DIR}/s3cfg"
cat > "${RUN_DIR}/s3cfg/s3.json" <<JSON
{"identities":[{"name":"acaos-e2e","credentials":[{"accessKey":"AKIAE2ELOCALONLY","secretKey":"e2e-local-only-secret-not-real"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
docker rm -f "${S3NAME}" >/dev/null 2>&1 || true
docker run -d --name "${S3NAME}" -p "127.0.0.1:${S3PORT}:8333" -v "${RUN_DIR}/s3cfg:/cfg:ro" chrislusf/seaweedfs:latest \
  server -dir=/data -s3 -s3.config=/cfg/s3.json -master.volumeSizeLimitMB=64 -volume.max=8 >/dev/null
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${S3PORT}/" || true)" = "403" ] && break; sleep 1; done

echo "[e2e-evidence] PostgreSQL on ${PGPORT}"
mkdir -p "${PGDATA}"; [ "$(id -u)" = "0" ] && chown -R postgres:postgres "${RUN_DIR}/pg"
"${RUN[@]}" "${PGBIN}/initdb" -D "${PGDATA}" -U postgres --auth=trust >/dev/null
"${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" -o "-p ${PGPORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -l "${PGDATA}/server.log" -w start >/dev/null
"${RUN[@]}" "${PGBIN}/createdb" -h 127.0.0.1 -p "${PGPORT}" -U postgres "${DBNAME}"

echo "[e2e-evidence] Redis on ${REDISPORT}"
setsid redis-server --port "${REDISPORT}" --bind 127.0.0.1 --save "" --appendonly no --daemonize no >"${RUN_DIR}/redis.log" 2>&1 & PIDS+=($!)

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DBNAME}"
export DIRECT_URL="${DATABASE_URL}"
export REDIS_URL="redis://127.0.0.1:${REDISPORT}"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null

# Evidence uploads are enabled in THIS process tree only (never in a committed file or a shared environment).
export EVIDENCE_UPLOADS_ENABLED=true
export EVIDENCE_S3_ENDPOINT="http://127.0.0.1:${S3PORT}"
export EVIDENCE_S3_BUCKET=acaos-e2e-evidence
export EVIDENCE_S3_ACCESS_KEY_ID=AKIAE2ELOCALONLY
export EVIDENCE_S3_SECRET_ACCESS_KEY=e2e-local-only-secret-not-real
export EVIDENCE_S3_REGION=us-east-1
export E2E_PAGE_ORIGINS="http://localhost:4173,http://127.0.0.1:4173"
export E2E_S3_ENDPOINT="${EVIDENCE_S3_ENDPOINT}" E2E_S3_BUCKET="${EVIDENCE_S3_BUCKET}"
export NODE_OPTIONS_BASE="--conditions=acaos-src"
NODE_OPTIONS="--conditions=acaos-src" npx tsx scripts/e2e-evidence-s3-setup.ts

export NODE_ENV=development PORT=4000 RATE_LIMIT_DISABLED=true SAFE_LAUNCH_MODE=true
echo "[e2e-evidence] API :4000, worker, production web build :4173"
( cd apps/api && NODE_OPTIONS="--conditions=acaos-src" exec setsid npx tsx src/server.ts ) >"${RUN_DIR}/api.log" 2>&1 & PIDS+=($!)
( cd apps/worker && NODE_OPTIONS="--conditions=acaos-src" WORKER_HEALTH_PORT=9099 exec setsid npx tsx src/worker.ts ) >"${RUN_DIR}/worker.log" 2>&1 & PIDS+=($!)
npm run build -w @acaos/web >"${RUN_DIR}/web-build.log" 2>&1
setsid node scripts/serve-web-csp.mjs --port 4173 --local-storage-origin "${EVIDENCE_S3_ENDPOINT}" >"${RUN_DIR}/web.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 90); do curl -sf http://localhost:4000/api/live >/dev/null && curl -sf http://localhost:4173/ >/dev/null && break; sleep 1; done
curl -sf http://localhost:4000/api/live >/dev/null || { echo "[e2e-evidence] API did not start"; tail -30 "${RUN_DIR}/api.log"; KEEP_LOGS=1; exit 1; }

set +e
E2E_DIAG_DIR="${RUN_DIR}" npx playwright test -c playwright.evidence.config.ts "$@"
CODE=$?
if [ "${CODE}" != "0" ]; then echo "[e2e-evidence] FAILED; logs kept in ${RUN_DIR}"; KEEP_LOGS=1; for f in api worker; do echo "--- ${f}.log"; tail -n 15 "${RUN_DIR}/${f}.log"; done; fi
exit "${CODE}"
