#!/bin/sh
set -eu

# Railway mounts volumes owned by root, shadowing image-time chown; fix
# ownership at startup and drop to the unprivileged user before exec.
if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$0" "$@"
  fi
  exec runuser -u node -- "$0" "$@"
fi

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  exec litestream replicate -config /app/litestream.yml -restore-if-db-not-exists -exec "node dist/src/cli.js gui"
fi

exec node dist/src/cli.js gui
