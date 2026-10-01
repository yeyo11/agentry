#!/bin/sh
# A stand-in for git in the golden tests: it writes down the arguments of every call to
# $AGENTRY_CALL_LOG (when set) and then runs the real git, which $AGENTRY_REAL_GIT names.
if [ -n "$AGENTRY_CALL_LOG" ]; then
  printf 'git' >> "$AGENTRY_CALL_LOG"
  for a in "$@"; do printf ' %s' "$a" >> "$AGENTRY_CALL_LOG"; done
  printf '\n' >> "$AGENTRY_CALL_LOG"
fi
exec "$AGENTRY_REAL_GIT" "$@"
