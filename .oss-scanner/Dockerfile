# syntax=docker/dockerfile:1
# Build environment for the OSS Scanner (https://github.com/anthropics/oss-scanner).
# Mirrors .github/workflows/ci.yml: Node 22, pnpm from "packageManager", a real PostgreSQL for the
# integration tests (UNIORA never tests its Postgres adapter against mocks), SQLite and in-memory.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    npm_config_update_notifier=false

# build-essential/python3: fallback toolchain for better-sqlite3 if no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates build-essential git python3 pkg-config \
        postgresql postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Exact pnpm version pinned by package.json ("packageManager").
RUN npm install --global "$(node -p "require('./package.json').packageManager.split('+')[0]")"

# Dependencies come from the lockfile; all downloads happen here, while the network is available.
RUN pnpm install --frozen-lockfile

# The packages consume each other through dist/, so build before anything else.
RUN pnpm -r build

# Local PostgreSQL for the test suite. The credentials only exist inside this throwaway image.
# TEST_DATABASE_URL is a DIFFERENT database from DATABASE_URL because the suite truncates its tables.
ENV DATABASE_URL=postgresql://postgres:uniora@127.0.0.1:5432/uniora \
    TEST_DATABASE_URL=postgresql://postgres:uniora@127.0.0.1:5432/uniora_test

RUN <<'SETUP'
set -eu
cat > /usr/local/bin/uniora-pg <<'SCRIPT'
#!/usr/bin/env bash
# usage: uniora-pg start|stop   (the scanner has no network, but PostgreSQL only needs loopback)
set -euo pipefail
case "${1:-}" in
  start)
    service postgresql start >/dev/null
    for _ in $(seq 1 30); do pg_isready -q -h 127.0.0.1 -p 5432 && exit 0; sleep 1; done
    echo "postgres did not become ready" >&2; exit 1 ;;
  stop) service postgresql stop >/dev/null ;;
  *) echo "usage: uniora-pg start|stop" >&2; exit 2 ;;
esac
SCRIPT
chmod +x /usr/local/bin/uniora-pg
SETUP

RUN uniora-pg start \
    && su postgres -c "psql -v ON_ERROR_STOP=1 -c \"alter user postgres password 'uniora'\" -c 'create database uniora'" \
    && uniora-pg stop

# Run the whole suite so you know the image works (typecheck + tests against Postgres, SQLite and memory),
# but do not let a failing test abort the build. Re-run it from /src with: uniora-pg start && pnpm -r test
RUN uniora-pg start \
    && (pnpm -r typecheck && pnpm -r test || echo "WARNING: typecheck/tests reported failures") \
    ; uniora-pg stop

CMD ["bash"]
