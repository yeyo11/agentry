#!/bin/sh
# Docker marks a container unhealthy but never restarts it, whatever the restart policy says: the
# policy only reacts to an exit. So after a run of failed probes this script ends the server
# itself, the container exits and `restart:` brings it back. A single slow probe is not a failure
# worth a restart, hence the counter.
#
# Only liveness is probed. /api/health answers 200 even when Claude is logged out, on purpose: a
# restart would not fix a missing credential.
set -u

port="${PORT:-8787}"
limit="${AGENTRY_HEALTH_RESTART_AFTER:-3}"
pidfile="${AGENTRY_PID_FILE:-/tmp/agentry.pid}"
counter="${pidfile}.failures"

if curl -fsS --max-time 4 "http://localhost:${port}/api/health" >/dev/null 2>&1; then
  rm -f "$counter"
  exit 0
fi

failures=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))
echo "$failures" > "$counter"

if [ "$failures" -ge "$limit" ] && [ -r "$pidfile" ]; then
  pid=$(cat "$pidfile")
  # SIGTERM lets the server stop its chats and close the store; a wedged event loop never gets to
  # run that handler, so SIGKILL follows
  kill -TERM "$pid" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL "$pid" 2>/dev/null
  rm -f "$counter"
fi
exit 1
