import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkItemHistoryEntry } from '@agentry/shared';
import { Core } from '../src/index.ts';
import { encodeProjectId } from '../src/workspace.ts';
import { tempConfig } from './helpers.ts';

// A chat this process does not run (a terminal chat an item was created from) had no name when its
// link was written; the history names it by its title when it is read. Only scratch directories.

const labels = (history: WorkItemHistoryEntry[]) =>
  history
    .filter((e) => e.change === 'link')
    .map((e) => [e.from && typeof e.from === 'object' && 'label' in e.from ? e.from.label : null, e.to && typeof e.to === 'object' && 'label' in e.to ? e.to.label : null]);

test("a chat Agentry does not run is named in an item's history by its title, not its id", async () => {
  const config = tempConfig();
  const dir = mkdtempSync(join(tmpdir(), 'agentry-history-'));
  const transcripts = join(config.projectsDir, encodeProjectId(dir));
  mkdirSync(transcripts, { recursive: true });
  const at = '2026-09-28T10:00:00Z';
  writeFileSync(
    join(transcripts, 'terminal-chat.jsonl'),
    `${JSON.stringify({ type: 'user', uuid: '1', timestamp: at, cwd: dir, sessionId: 'terminal-chat', message: { role: 'user', content: 'Refactor the cart totals' } })}\n`,
  );
  const core = new Core(config);
  try {
    const project = await core.importProject({ path: dir, name: 'Shop', modules: ['board'] });
    const item = core.workItems.create(project.id, { title: 'Totals in cents' });
    const link = core.workItems.link(item.id, { kind: 'chat', role: 'origin', chatId: 'terminal-chat' });
    // Written as the store could: by the id, since nothing ran the chat here
    assert.deepEqual(labels(core.workItems.history(item.id)), [[null, 'chat terminal-chat']]);
    // A chat nobody can find keeps the label it was written with
    core.workItems.link(item.id, { kind: 'chat', role: 'reference', chatId: 'gone' });
    core.workItems.unlink(link.id);

    const expected = [
      [null, 'Refactor the cart totals'],
      [null, 'chat gone'],
      ['Refactor the cart totals', null],
    ];
    assert.deepEqual(labels(await core.workItemHistory(item.id)), expected);
    assert.deepEqual(labels((await core.workItemDetail(item.id)).history), expected);
    await assert.rejects(core.workItemHistory('nope'), /not found/);
  } finally {
    core.db.close();
  }
});
