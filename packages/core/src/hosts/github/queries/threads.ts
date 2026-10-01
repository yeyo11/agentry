// The review threads of a pull request (recorded by r0 as `work/threads.graphql`, with `gh api
// --paginate`). `$endCursor` and `pageInfo` are what makes `--paginate` follow the threads; it does
// not follow the comments inside a thread (recorded), so a thread with more than 100 comments is
// read on with THREAD_COMMENTS_QUERY from the cursor this one ended at.
//
// Like the other queries it is an inline module string, not a `.graphql` file: the API is bundled
// with esbuild, and the classifier reads the document from the `-f query=` argument, so it starts
// with `query`.

export const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $endCursor: String) {
  rateLimit { cost remaining resetAt used }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: $first, after: $endCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
          resolvedBy { login } viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id databaseId body author { login } createdAt outdated diffHunk replyTo { databaseId } pullRequestReview { databaseId state } }
          }
        }
      }
    }
  }
}`;

export const THREAD_COMMENTS_QUERY = `query($id: ID!, $first: Int!, $endCursor: String) {
  rateLimit { cost remaining resetAt used }
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      comments(first: $first, after: $endCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { id databaseId body author { login } createdAt replyTo { databaseId } }
      }
    }
  }
}`;

export const RESOLVE_MUTATION = `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }`;

export const UNRESOLVE_MUTATION = `mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }`;
