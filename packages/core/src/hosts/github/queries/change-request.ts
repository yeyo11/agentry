// The watcher's read of a pull request: one GraphQL request instead of `pr view`, so a failed poll
// has a status and rate-limit headers (`gh api -i`). It lives in a module, not a `.graphql` file,
// because the API is bundled with esbuild and a file beside the source would not travel with it.
//
// The classifier reads the document from the `-f query=` argument, so it must stay one inline
// string and start with `query`. Contexts are read to 100 and never paged: GitHub's own rollup
// `state` covers the rest, and the full list comes from the check-runs endpoint.

export const CHANGE_REQUEST_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      url
      state
      mergedAt
      isDraft
      headRefOid
      baseRefName
      mergeable
      mergeStateStatus
      reviewDecision
      autoMergeRequest { enabledAt }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
                  ... on StatusContext { context state targetUrl createdAt }
                }
                pageInfo { hasNextPage }
              }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`;
