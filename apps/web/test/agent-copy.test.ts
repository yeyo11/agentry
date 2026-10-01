import assert from 'node:assert/strict';
import test from 'node:test';
import { en, es } from '../src/i18n/resources.ts';

// docs/plans/multi-provider.md, "The copy rule": a string about a chat, a run or an edit names the
// chat's agent through {{agent}}, so a Codex chat never reads "Claude is editing it". A string about
// a Claude-only feature keeps the name, and is listed here with the reason, so adding "Claude" to
// the copy of a chat screen is a decision someone makes on purpose.

/** The namespaces whose strings are about a chat, a run or an edit of any provider. */
const CHAT_SCOPED = ['chat', 'primitives', 'changes', 'components', 'chats', 'observe', 'schedules', 'home', 'usage', 'workItem', 'suggestion'] as const;

/** `namespace:key` prefixes that are Claude's own feature, or name every provider, with the reason. */
const CLAUDE_ONLY: readonly string[] = [
  // The status bar's row for the Claude Code CLI itself: its version
  'components:shell.claudeCode',
  // The environment panel reads Claude's system/init
  'components:environment.empty',
  // Claude keeps its memory per project
  'home:settings.memory',
  // The list of agents Agentry looks for
  'home:activity.noAgentHint',
];

/**
 * Chat-scoped keys of `chats.json` and `components.json` that still say "Claude". Those two files
 * belong to the chat-page task (`u2`), which turns them into "the agent" or `{{agent}}`; remove
 * each line here with its change.
 */
const PENDING_CHAT_PAGE: readonly string[] = ['chats:list.emptyBody', 'chats:new.subtitle', 'chats:new.promptPlaceholder', 'components:palette.newChatHint', 'components:diff.unexplained'];

function strings(tree: object, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : strings(value as object, `${prefix}${key}.`),
  );
}

for (const [locale, resources] of [
  ['en', en],
  ['es', es],
] as const) {
  test(`${locale}: no chat-scoped string names Claude unless it is a Claude-only feature`, () => {
    const offenders: string[] = [];
    for (const ns of CHAT_SCOPED) {
      const tree = (resources as Record<string, object>)[ns];
      assert.ok(tree, `${ns} is a namespace`);
      for (const [key, text] of strings(tree)) {
        if (!/Claude/.test(text)) continue;
        const id = `${ns}:${key}`;
        if ([...CLAUDE_ONLY, ...PENDING_CHAT_PAGE].some((prefix) => id.startsWith(prefix))) continue;
        offenders.push(`${id}: ${text}`);
      }
    }
    assert.deepEqual(offenders, [], 'name the chat\'s agent with {{agent}} (or "the agent"), or list the key as Claude-only');
  });
}

test('the keys that take {{agent}} keep it in both languages', () => {
  for (const key of ['legendLive', 'row.live', 'steps.pendingPatch', 'steps.count_one', 'steps.countShort_other', 'steps.intentLabel', 'steps.noIntent']) {
    const path = key.startsWith('steps.') || key.startsWith('row.') ? key : `map.${key}`;
    for (const resources of [en, es]) {
      const text = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], resources.changes);
      assert.equal(typeof text, 'string', `changes:${path}`);
      assert.match(text as string, /\{\{agent\}\}/, `changes:${path}`);
    }
  }
});
