// Answers shaped like the ones Claude writes, for the streaming markdown tests and benchmark.

export const REVIEW = `## Summary

The run failed because the worktree was removed while a task was still writing to it. Three things
line up:

1. The orchestrator marks the task **done** as soon as the \`result\` event arrives.
2. Cleanup runs on that transition, not when the process exits.
3. The CLI keeps flushing \`~/.claude/projects/*.jsonl\` for a few hundred milliseconds.

   That last point is easy to miss: the file is appended *after* the result line.

4. Nothing retries the write.

### What changed

| File | Change | Risk |
| --- | :-: | --: |
| \`orchestrator.ts\` | wait for \`exit\` | low |
| \`worktrees.ts\` | keep dirty trees | medium |
| \`runs.ts\` | no change | — |

> **Note:** removing a worktree with uncommitted changes needs \`--force\`.
>
> The wrapper never passes it, so a dirty tree is kept and reported instead.

- [x] reproduce with a slow disk
- [x] add a regression test
- [ ] document the new \`keepWorktree\` flag

---

See https://git-scm.com/docs/git-worktree for the details, or ask me to open a PR.
`;

export const CODE = `Here is the fix. The key is to await the process exit before cleaning up:

\`\`\`ts
export async function finishTask(task: Task): Promise<void> {
  await task.process.exited;

  // The CLI may still be flushing its session file
  await flushed(task.sessionFile);

  if (await isDirty(task.worktree)) {
    log.warn('keeping dirty worktree', { path: task.worktree });
    return;
  }

  await removeWorktree(task.worktree);
}
\`\`\`

And the test:

\`\`\`ts
test('a dirty worktree is kept', async () => {
  const task = await startTask({ prompt: 'touch x' });

  await finishTask(task);

  assert.ok(existsSync(task.worktree));
});
\`\`\`

Run it with:

\`\`\`bash
pnpm --filter @agentry/core test -- --test-name-pattern worktree
\`\`\`

~~~
plain output

with a blank line
~~~

That should be all.
`;

export const NESTED = `# Plan

Steps, in order:

- **Parse** the transcript
  - read the JSONL
  - skip malformed lines

    Malformed lines happen when the CLI is killed mid-write.

  - keep the offsets
- **Index** it

  \`\`\`json
  { "offset": 0,

    "line": 1 }
  \`\`\`

- **Serve** pages
    1. first page
    2. next pages

1. Ordered
2. List

3. with a loose item

* star list
+ plus list

> A quote
> - with a list
>
> > and a nested quote

Final paragraph with a lazy
continuation line and \`inline code\`.
`;

export const TRICKY = `#

An empty heading above, then setext-looking text
===

Text right before a table
| a | b |
| - | - |
| 1 | 2 |
after the table without a blank line

- item

text after a list that is not indented

- item
  continued

  indented paragraph in the item
- next

    indented code at top level

    still indented
***
___
5. starts at five

6. and goes on

\`\`\`\`md
\`\`\`
nested fence text

\`\`\`
\`\`\`\`

> quote

not quoted
`;

export const ANSWERS = { REVIEW, CODE, NESTED, TRICKY };

/** An answer of about `bytes`, made of the fixtures back to back, for the benchmark. */
export function answerOfSize(bytes: number): string {
  const parts = [REVIEW, CODE, NESTED];
  let text = '';
  for (let index = 0; text.length < bytes; index++) text += `${parts[index % parts.length] ?? ''}\n`;
  return text.slice(0, bytes);
}
