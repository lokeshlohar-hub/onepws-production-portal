#!/bin/bash
# Start the extractor sidecar (localhost-only) then the Node backend in the
# foreground. If either process dies, the container exits and Cloud Run
# restarts it — no half-alive state.
set -e

# Office database (optional): when PORTAL_DB_TUNNEL_HOST is set, the database is the office PostgreSQL reached
# through the Cloudflare tunnel. cloudflared listens on 127.0.0.1:15432 inside this container and carries each
# connection to the office server, authenticated with the Cloudflare Access service token. DATABASE_URL then points
# at 127.0.0.1:15432. Without the variable nothing changes (the database is wherever DATABASE_URL says).
TUNNEL_PID=
if [ -n "${PORTAL_DB_TUNNEL_HOST:-}" ]; then
  if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    echo "PORTAL_DB_TUNNEL_HOST is set but CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not" >&2
    exit 1
  fi
  TUNNEL_SERVICE_TOKEN_ID="$CF_ACCESS_CLIENT_ID" TUNNEL_SERVICE_TOKEN_SECRET="$CF_ACCESS_CLIENT_SECRET" \
    /usr/local/bin/cloudflared access tcp --hostname "$PORTAL_DB_TUNNEL_HOST" --url 127.0.0.1:15432 --loglevel warn &
  TUNNEL_PID=$!
  # wait (up to 20 s) until the local end of the tunnel accepts connections
  for _ in $(seq 1 40); do
    (exec 3<>/dev/tcp/127.0.0.1/15432) 2>/dev/null && break
    sleep 0.5
  done
fi

/opt/extractor-venv/bin/python /app/extractor/run.py &
EXTRACTOR_PID=$!

cd /app/backend
node src/server.js &
NODE_PID=$!

# Exit when the first of them exits (the tunnel too, when there is one) - Cloud Run then starts a fresh container.
wait -n $EXTRACTOR_PID $NODE_PID $TUNNEL_PID 2>/dev/null || wait $NODE_PID
exit $?
