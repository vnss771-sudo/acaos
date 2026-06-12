#!/usr/bin/env bash
#
# Boot ephemeral PostgreSQL + Redis, apply migrations, run the Redis-backed
# integration tier, then tear everything down.
#
# Usage: npm run test:redis:local
#
# In CI we use Postgres + Redis service containers and run `npm run test:redis`
# directly (see the verify-redis job in .github/workflows/ci.yml).
set -euo pipefail

PGPORT="${TEST_PGPORT:-55432}"
REDIS_PORT="${TEST_REDIS_PORT:-6399}"
PGDATA="$(mktemp -d /tmp/acaos-redisdb.XXXXXX)"
DBNAME="acaos_test"

PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "${PGBIN}" ] || [ ! -x "${PGBIN}/postgres" ]; then
  PGBIN="$(dirname "$(command -v postgres)")"
fi

RUN=()
if [ "$(id -u)" = "0" ]; then
  RUN=(runuser -u postgres --)
  chown -R postgres:postgres "${PGDATA}"
fi

cleanup() {
  "${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" stop -m immediate >/dev/null 2>&1 || true
  redis-cli -p "${REDIS_PORT}" shutdown nosave >/dev/null 2>&1 || true
  rm -rf "${PGDATA}"
}
trap cleanup EXIT

echo "[test-redis] starting redis on port ${REDIS_PORT}"
redis-server --port "${REDIS_PORT}" --daemonize yes --save '' --appendonly no >/dev/null

echo "[test-redis] initializing postgres cluster in ${PGDATA}"
"${RUN[@]}" "${PGBIN}/initdb" -D "${PGDATA}" -U postgres --auth=trust >/dev/null
"${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" \
  -o "-p ${PGPORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" \
  -l "${PGDATA}/server.log" -w start >/dev/null
"${RUN[@]}" "${PGBIN}/createdb" -h 127.0.0.1 -p "${PGPORT}" -U postgres "${DBNAME}"

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DBNAME}"
export REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
echo "[test-redis] applying migrations"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null

echo "[test-redis] running Redis-backed tests"
npm run test:redis
