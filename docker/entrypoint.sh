#!/bin/sh
# Starts the image's own tailscaled for Settings > Remote access, then becomes the server.
#
# A container sees neither the host's Tailscale CLI nor its daemon, so the image runs one of its own
# (docs/deploy.md, "The tunnel in Docker"): userspace networking, which needs no root, no NET_ADMIN
# and no /dev/net/tun, as the image's user; its state on the /data volume, so a replaced container
# keeps its node and its sign-in; its socket where the CLI looks by default. The person signs it in
# from the app (docs/setup.md), and AGENTRY_TAILSCALE_MANAGED tells the server this daemon is its own
# to sign in and out. With AGENTRY_TUNNEL off nothing is started and the server offers no tunnel.
#
# The server is exec'd, so it receives `docker stop` itself; tailscaled is left to end with the
# container, and writes its state as it changes, so nothing waits on it.
set -eu

case "$(printf '%s' "${AGENTRY_TUNNEL:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  off | 0 | false) tunnel=off ;;
  # Unset or empty is the default, on; a value that is neither on nor off is the server's to refuse
  *) tunnel=on ;;
esac

if [ "$tunnel" = on ] && command -v tailscaled >/dev/null 2>&1; then
  state="${AGENTRY_TAILSCALE_STATE_DIR:-${AGENTRY_DATA_DIR:-/data}/tailscale}"
  socket=/run/tailscale/tailscaled.sock
  mkdir -p "$state"
  chmod 700 "$state"
  # A daemon from an earlier start of this same container left its socket behind
  rm -f "$socket"
  # One log per start, in the state folder, so it neither fills the container's output nor grows
  # without end across restarts. TS_LOGS_DIR keeps its log buffer there too, instead of under
  # XDG_DATA_HOME, which the image points at the agents' homes.
  TS_LOGS_DIR="$state" tailscaled --tun=userspace-networking --statedir="$state" --state="$state/tailscaled.state" --socket="$socket" \
    >"$state/tailscaled.log" 2>&1 &
  export AGENTRY_TAILSCALE_MANAGED=1
  # The first status the server reads should find the socket; it reads again on every request anyway
  waited=0
  while [ ! -S "$socket" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
fi

exec "$@"
