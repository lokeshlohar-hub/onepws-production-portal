#!/bin/bash
# Start the extractor sidecar (localhost-only) then the Node backend in the
# foreground. If either process dies, the container exits and Cloud Run
# restarts it — no half-alive state.
set -e

/opt/extractor-venv/bin/python /app/extractor/run.py &
EXTRACTOR_PID=$!

cd /app/backend
node src/server.js &
NODE_PID=$!

# Exit when the first of the two exits.
wait -n $EXTRACTOR_PID $NODE_PID 2>/dev/null || wait $NODE_PID
exit $?
