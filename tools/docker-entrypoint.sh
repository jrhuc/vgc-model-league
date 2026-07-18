#!/bin/sh
set -eu

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  exec litestream replicate -config /app/litestream.yml -restore-if-db-not-exists -exec "node dist/src/cli.js gui"
fi

exec node dist/src/cli.js gui
