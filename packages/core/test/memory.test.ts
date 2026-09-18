import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryStore } from '../src/memory.ts';
import { tempConfig } from './helpers.ts';

test('memory files CRUD with parsed frontmatter', async () => {
  const config = tempConfig();
  const memory = new MemoryStore(config);
  assert.deepEqual(await memory.list('-work-demo'), []);

  const fact = await memory.save(
    '-work-demo',
    'code-style.md',
    '---\nname: code-style\ndescription: Prefers tabs\nmetadata:\n  type: feedback\n---\n\nUse tabs.\n',
  );
  assert.equal(fact.path, join(config.projectsDir, '-work-demo', 'memory', 'code-style.md'));
  assert.deepEqual([fact.description, fact.type, fact.isIndex], ['Prefers tabs', 'feedback', false]);

  await memory.save('-work-demo', 'MEMORY.md', '- [Code style](code-style.md) — tabs\n');
  assert.deepEqual((await memory.list('-work-demo')).map((f) => f.name), ['MEMORY.md', 'code-style.md']); // index first

  await memory.remove('-work-demo', 'code-style.md');
  await assert.rejects(memory.remove('-work-demo', 'code-style.md'), /not found/);
  await assert.rejects(memory.save('-work-demo', '../escape.md', 'x'), /invalid memory file name/);
  await assert.rejects(memory.save('-work-demo', 'notes.txt', 'x'), /invalid memory file name/);
  await assert.rejects(memory.list('../etc'), /invalid project id/);
});
