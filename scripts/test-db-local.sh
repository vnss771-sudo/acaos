#!/usr/bin/env bash
#
# Boot an ephemeral local PostgreSQL cluster, apply migrations, run the
# database-backed test tier against it, then tear everything down.
#
# Usage: npm run test:db:local
#
# In CI we instead use a Postgres service container and run `npm run test:db`
# directly (see .github/workflows/ci.yml). This script is for local runs where
# no Postgres is provided.
set -euo pipefail

PGPORT="${TEST_PGPORT:-55432}"
PGDATA="$(mktemp -d /tmp/acaos-testdb.XXXXXX)"
DBNAME="acaos_test"

# Locate the PostgreSQL server binaries (Debian/Ubuntu layout, else PATH).
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "${PGBIN}" ] || [ ! -x "${PGBIN}/postgres" ]; then
  PGBIN="$(dirname "$(command -v postgres)")"
fi

# PostgreSQL refuses to run as root, so when invoked as root (e.g. in a
# container) run the server as the unprivileged `postgres` OS user.
RUN=()
if [ "$(id -u)" = "0" ]; then
  RUN=(runuser -u postgres --)
  chown -R postgres:postgres "${PGDATA}"
fi

cleanup() {
  "${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "${PGDATA}"
}
trap cleanup EXIT

echo "[test-db] initializing cluster in ${PGDATA}"
"${RUN[@]}" "${PGBIN}/initdb" -D "${PGDATA}" -U postgres --auth=trust >/dev/null

echo "[test-db] starting postgres on port ${PGPORT}"
"${RUN[@]}" "${PGBIN}/pg_ctl" -D "${PGDATA}" \
  -o "-p ${PGPORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" \
  -l "${PGDATA}/server.log" -w start >/dev/null

"${RUN[@]}" "${PGBIN}/createdb" -h 127.0.0.1 -p "${PGPORT}" -U postgres "${DBNAME}"

export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${DBNAME}"
# The Prisma schema declares directUrl; mirror DATABASE_URL so the CLI and
# client both resolve it (CI sets DIRECT_URL explicitly on the job).
export DIRECT_URL="${DATABASE_URL}"
echo "[test-db] applying migrations"
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma >/dev/null

echo "[test-db] running database-backed tests"
npm run test:db
