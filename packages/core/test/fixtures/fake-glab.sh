#!/bin/sh
# A stand-in for GitLab's CLI in the merge request tests: it answers as glab 1.120.0 did, from the
# recorded runs in recordings/glab/1.120.0 (stdout, stderr and exit code of each, stream by stream),
# and writes down every call it gets, in $FAKE_GLAB_STATE:
#   calls          one line per call, the arguments joined by spaces
#   body-<iid>     the description a `mr create` was given on stdin (the only call that reads it, so
#                  a caller that leaves stdin open does not hang the fake)
# Switches are files in $FAKE_GLAB_STATE:
#   unauth-<host>  `auth status --hostname <host>` exits 1
#   dup            `mr create` fails as when one exists for the branch, and `mr list` finds merge
#                  request !<content of the file, default 7>
#   notfound       `mr view` answers the recorded 404
#   fail           `mr view` and `mr list` fail as a host that cannot be reached
#   view.json      what `mr view` prints, in place of the recorded object
#   list.json      what `mr list` prints, in place of the derived answer
#   next           the iid the next `mr create` gets (default 4)
state="$FAKE_GLAB_STATE"
rec="$(dirname "$0")/recordings/glab/1.120.0"
echo "$*" >> "$state/calls"
# The golden tests also keep the order of every call, with what the execution layer set around it
# and the body it was given on stdin (only `mr create` reads one), as fake-gh does.
if [ -n "$AGENTRY_CALL_LOG" ]; then
  {
    echo "glab $*"
    echo "  cwd: $PWD"
    for v in GIT_TERMINAL_PROMPT GLAB_NO_PROMPT GLAB_CHECK_UPDATE GLAB_SEND_TELEMETRY NO_PROMPT GITLAB_HOST GL_HOST NO_COLOR LC_ALL; do
      eval "set_=\${$v+set}"
      if [ -n "$set_" ]; then eval "echo \"  env: $v=\$$v\""; else echo "  env: $v=<unset>"; fi
    done
  } >> "$AGENTRY_CALL_LOG"
fi

# What a recorded run printed, on each stream, and its exit code
replay() { cat "$rec/$1.out"; cat "$rec/$1.err" >&2; exit "$(cat "$rec/$1.rc")"; }

# The value after a flag
flag() {
  want="$1"; shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$want" ]; then echo "$2"; return; fi
    shift
  done
}

case "$1 $2" in
  "version "*) replay version ;;
  "auth status")
    host=$(flag --hostname "$@")
    if [ -f "$state/unauth-$host" ]; then replay unknown_hostname; fi
    cat "$rec/authst.err" >&2; exit 0 ;;
  "repo view") replay repoview ;;
  "mr create")
    if [ -f "$state/dup" ]; then replay mr_dup; fi
    iid=$(cat "$state/next" 2>/dev/null || echo 4)
    cat > "$state/body-$iid"
    if [ -n "$AGENTRY_CALL_LOG" ]; then { echo "  stdin:"; sed 's/^/    | /' "$state/body-$iid"; echo; } >> "$AGENTRY_CALL_LOG"; fi
    url=$(flag -R "$@")
    head=$(flag --source-branch "$@")
    printf '\nCreating merge request for %s into %s in %s\n\n' "$head" "$(flag --target-branch "$@")" "${url#https://*/}" >&2
    echo "$url/-/merge_requests/$iid"
    echo $((iid + 1)) > "$state/next"
    echo "$iid" > "$state/created-$(echo "$head" | tr / _)"
    exit 0 ;;
  "mr list")
    if [ -f "$state/fail" ]; then replay unknown_repo_host; fi
    if [ -f "$state/list.json" ]; then cat "$state/list.json"; exit 0; fi
    url=$(flag -R "$@")
    head=$(flag -s "$@" | tr / _)
    found=""
    if [ -f "$state/dup" ]; then found=$(cat "$state/dup"); [ -n "$found" ] || found=7; fi
    if [ -f "$state/created-$head" ]; then found=$(cat "$state/created-$head"); fi
    if [ -n "$found" ]; then
      printf '[{"iid":%s,"web_url":"%s/-/merge_requests/%s","state":"opened"}]\n' "$found" "$url" "$found"
    else
      echo '[]'
    fi
    exit 0 ;;
  "mr view")
    if [ -f "$state/fail" ]; then replay unknown_repo_host; fi
    if [ -f "$state/notfound" ]; then replay view404; fi
    if [ -f "$state/view.json" ]; then cat "$state/view.json"; exit 0; fi
    sed "s/\"iid\":4,/\"iid\":$3,/; s#/merge_requests/4\"#/merge_requests/$3\"#" "$rec/mrview4.out"
    exit 0 ;;
esac
echo "unknown command $*" >&2
exit 1
