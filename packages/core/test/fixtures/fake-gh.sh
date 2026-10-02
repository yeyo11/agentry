#!/bin/sh
# A stand-in for GitHub's CLI in the pull request tests: it answers as gh would, from files in
# $FAKE_GH_STATE, and writes down every call it gets.
state="$FAKE_GH_STATE"
echo "$*" >> "$state/calls"
# The golden tests also keep the order of every call, with what the execution layer set around it
# and the body it was given on stdin (only `pr create` reads one).
if [ -n "$AGENTRY_CALL_LOG" ]; then
  {
    echo "gh $*"
    echo "  cwd: $PWD"
    for v in GIT_TERMINAL_PROMPT GH_PROMPT_DISABLED GH_NO_UPDATE_NOTIFIER GH_HOST GH_REPO NO_PROMPT GH_NO_EXTENSION_UPDATE_NOTIFIER GH_SPINNER_DISABLED GH_PAGER GH_TELEMETRY DO_NOT_TRACK NO_COLOR LC_ALL; do
      eval "set_=\${$v+set}"
      if [ -n "$set_" ]; then eval "echo \"  env: $v=\$$v\""; else echo "  env: $v=<unset>"; fi
    done
  } >> "$AGENTRY_CALL_LOG"
fi
case "$1 $2" in
  "--version "*) printf 'gh version 2.92.0 (2026-04-28)\nhttps://github.com/cli/cli/releases/tag/v2.92.0\n'; exit 0 ;;
  "auth status")
    # The adapter's probe: one call lists every host, exit 0 whatever the token's state (recorded on
    # 2.92.0 and 2.102.0). $state/hosts names them (default github.com); $state/unauth-<host> gives
    # that host a bad token, and $state/unauth leaves the list empty.
    if [ "$3" = "--json" ]; then
      if [ -f "$state/unauth" ]; then echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; echo '{"hosts":{}}'; exit 0; fi
      out='{"hosts":{'; sep=''
      for h in $(cat "$state/hosts" 2>/dev/null || echo github.com); do
        if [ -f "$state/unauth-$h" ]; then entry="{\"state\":\"error\",\"error\":\"non-200 OK status code: 401 Unauthorized\",\"active\":true,\"host\":\"$h\",\"login\":\"\",\"tokenSource\":\"GH_TOKEN\",\"gitProtocol\":\"https\"}"
        else entry="{\"state\":\"success\",\"active\":true,\"host\":\"$h\",\"login\":\"octocat\",\"tokenSource\":\"keyring\",\"scopes\":\"repo\",\"gitProtocol\":\"https\"}"; fi
        out="$out$sep\"$h\":[$entry]"; sep=','
      done
      echo "$out}}"; exit 0
    fi
    if [ "$3" = "--hostname" ] && [ -f "$state/unknown-host" ] && [ "$4" = "$(cat "$state/unknown-host")" ]; then echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; fi
    if [ -f "$state/unauth" ]; then echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; fi
    exit 0 ;;
  "repo view") echo "main"; exit 0 ;;
  "api --hostname")
    # The adapter's default branch lookup: the repository object, by a relative path
    case "$4" in
      repos/*/*) printf '{"default_branch":"main","private":true,"permissions":{"push":true}}\n'; exit 0 ;;
    esac ;;
  "pr list")
    # The adapter's lookup after a create, by head and base: the pull request `pr create` made,
    # else $state/list.json, else none
    if [ -f "$state/fail" ]; then echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; fi
    if [ -f "$state/list.json" ]; then cat "$state/list.json"; exit 0; fi
    n=$(cat "$state/next" 2>/dev/null || echo 7)
    if [ -f "$state/create-$n" ]; then
      printf '[{"number":%s,"url":"https://github.com/acme/shop/pull/%s","state":"OPEN","headRefName":"task/cw-1","baseRefName":"main","isCrossRepository":false}]\n' "$n" "$n"
    else echo '[]'; fi
    exit 0 ;;
  "pr create")
    n=$(cat "$state/next" 2>/dev/null || echo 7)
    cat > "$state/body-$n"
    if [ -n "$AGENTRY_CALL_LOG" ]; then { echo "  stdin:"; sed 's/^/    | /' "$state/body-$n"; echo; } >> "$AGENTRY_CALL_LOG"; fi
    echo "$@" > "$state/create-$n"
    if [ -f "$state/exists" ]; then printf 'a pull request for branch "task/cw-1" into branch "main" already exists:\nhttps://github.com/acme/shop/pull/%s\n' "$n" >&2; exit 1; fi
    echo "https://github.com/acme/shop/pull/$n"; exit 0 ;;
  "api -i")
    # The watcher's read (one GraphQL query through `api -i`): the same document `pr view` serves
    # from $state/view.json, put in the shape of the query's answer, with the status line first
    if [ -f "$state/fail" ]; then printf 'HTTP/2.0 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n{"message":"Bad Gateway"}\n'; echo "gh: Bad Gateway (HTTP 502)" >&2; exit 1; fi
    number=$(printf '%s\n' "$@" | sed -n 's/^number=//p')
    printf 'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n'
    NUMBER="$number" VIEW="$state/view.json" node -e '
      const fs = require("node:fs");
      const n = Number(process.env.NUMBER);
      const view = fs.existsSync(process.env.VIEW) ? JSON.parse(fs.readFileSync(process.env.VIEW, "utf8")) : { state: "OPEN", mergedAt: null, statusCheckRollup: [], url: `https://github.com/acme/shop/pull/${n}` };
      const nodes = view.statusCheckRollup ?? [];
      const pullRequest = {
        number: n, url: view.url || `https://github.com/acme/shop/pull/${n}`, state: view.state, mergedAt: view.mergedAt,
        isDraft: false, headRefOid: "0123456789abcdef0123456789abcdef01234567", baseRefName: "main",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, autoMergeRequest: null,
        commits: { nodes: [{ commit: { statusCheckRollup: nodes.length ? { state: "PENDING", contexts: { nodes, pageInfo: { hasNextPage: false } } } : null } }] },
      };
      process.stdout.write(JSON.stringify({ data: { repository: { pullRequest }, rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-10-01T12:00:00Z" } } }) + "\n");
    '
    exit 0 ;;
  "pr view")
    if [ -f "$state/fail" ]; then echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; fi
    case "$*" in
      *"--json closingIssuesReferences") # what the host says the merged request closes; $state/closing.json holds the answer
        if [ -f "$state/closing-fail" ]; then echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; fi
        if [ -f "$state/closing.json" ]; then cat "$state/closing.json"; else echo '{"closingIssuesReferences":[]}'; fi
        exit 0 ;;
    esac
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
