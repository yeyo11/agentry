#!/bin/sh
# A stand-in for GitHub's CLI in the pull request tests: it answers as gh would, from files in
# $FAKE_GH_STATE, and writes down every call it gets.
state="$FAKE_GH_STATE"
echo "$*" >> "$state/calls"
case "$1 $2" in
  "--version "*) echo "gh version 2.60.0"; exit 0 ;;
  "auth status")
    if [ -f "$state/unauth" ]; then echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; fi
    exit 0 ;;
  "repo view") echo "main"; exit 0 ;;
  "pr create")
    n=$(cat "$state/next" 2>/dev/null || echo 7)
    cat > "$state/body-$n"
    echo "$@" > "$state/create-$n"
    echo "https://github.com/acme/shop/pull/$n"; exit 0 ;;
  "pr view")
    if [ -f "$state/fail" ]; then echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; fi
    case "$3" in
      task/*)
        n=$(cat "$state/next" 2>/dev/null || echo 7)
        printf '{"number":%s,"url":"https://github.com/acme/shop/pull/%s","state":"OPEN"}\n' "$n" "$n"; exit 0 ;;
      *)
        if [ -f "$state/view.json" ]; then cat "$state/view.json"
        else printf '{"state":"OPEN","mergedAt":null,"statusCheckRollup":[],"url":"https://github.com/acme/shop/pull/%s"}\n' "$3"; fi
        exit 0 ;;
    esac ;;
esac
echo "unknown command $*" >&2
exit 1
