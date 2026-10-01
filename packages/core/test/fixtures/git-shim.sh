#!/bin/sh
# A stand-in for git in the golden tests: it writes down the arguments of every call to
# $AGENTRY_CALL_LOG (when set) and then runs the real git, which $AGENTRY_REAL_GIT names.
if [ -n "$AGENTRY_CALL_LOG" ]; then
  printf 'git' >> "$AGENTRY_CALL_LOG"
  for a in "$@"; do printf ' %s' "$a" >> "$AGENTRY_CALL_LOG"; done
  printf '\n' >> "$AGENTRY_CALL_LOG"
fi
# The tests' `origin` is a bare repository beside the project, which has no host, and a project with
# a host-less origin is not ready. With $AGENTRY_ORIGIN_URL set, `remote get-url origin` names that
# host while fetch and push still reach the bare repository. A URL a test set itself is left alone.
if [ -n "$AGENTRY_ORIGIN_URL" ] && [ "$3" = remote ] && [ "$4" = get-url ] && [ "$5" = origin ]; then
  url=$("$AGENTRY_REAL_GIT" "$@") || exit $?
  case "$url" in /*) echo "$AGENTRY_ORIGIN_URL" ;; *) echo "$url" ;; esac
  exit 0
fi
exec "$AGENTRY_REAL_GIT" "$@"
