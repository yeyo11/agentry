import assert from 'node:assert/strict';
import test from 'node:test';
import type { Chat, ChatExport, ChatSummary, Project, ProjectExport, TranscriptEntry } from '@agentry/shared';
import { byStart, projectExportFilename, projectToJson, projectToMarkdown, type ProjectExportSource } from '../src/project-export.ts';

const project: Project = { id: '9f1c2d3e-0000-4000-8000-000000000000', name: 'Billing API', path: '/work/billing', worktrees: [], exists: true, chatCount: 3, lastActivity: null };
const tokens = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheCreation: 0, total: 2 * n });

const chatFor = (id: string, over: Partial<Chat> = {}): Chat =>
  ({
    id,
    title: `Chat ${id}`,
    project: { id: project.id, name: project.name },
    cwd: project.path,
    model: 'claude-opus-5',
    startedAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T10:05:00Z',
    cost: { usd: 0.5, tokens: [{ model: 'claude-opus-5', ...tokens(10) }], total: tokens(10) },
    ...over,
  }) as Chat;

const said = (uuid: string, role: 'user' | 'assistant', text: string): TranscriptEntry => ({
  uuid,
  role,
  timestamp: '2026-03-10T10:00:00Z',
  model: role === 'assistant' ? 'claude-opus-5' : null,
  isSidechain: false,
  parentToolUseId: null,
  blocks: [{ type: 'text', text }],
});

function source(chats: Chat[], opts: { missing?: string[] } = {}): ProjectExportSource & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    exportedAt: '2026-03-12T09:00:00Z',
    project,
    chats: chats as ChatSummary[],
    loaded,
    load: async (id): Promise<ChatExport> => {
      loaded.push(id);
      if (opts.missing?.includes(id)) throw new Error('chat not found');
      const chat = chats.find((c) => c.id === id) as Chat;
      return { exportedAt: '2026-03-12T09:00:00Z', chat, entries: [said(`${id}-u`, 'user', `question of ${id}`), said(`${id}-a`, 'assistant', `answer of ${id}`)] };
    },
  };
}

async function collect(pieces: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of pieces) out.push(piece);
  return out;
}

test('the Markdown export opens with the project, the dates, the models and the cost the CLI reported, then a section per chat', async () => {
  const chats = [
    chatFor('aaaa1111', { startedAt: '2026-03-01T08:00:00Z', updatedAt: '2026-03-01T09:00:00Z' }),
    chatFor('bbbb2222', { model: 'claude-haiku-4-5', cost: { usd: 0.25, tokens: [{ model: 'claude-haiku-4-5', ...tokens(5) }], total: tokens(5) } }),
    // Born in a terminal: no cost, and none is worked out from its tokens
    chatFor('cccc3333', { startedAt: '2026-03-11T12:00:00Z', updatedAt: '2026-03-11T13:30:00Z', cost: { usd: null, tokens: [{ model: 'claude-sonnet-5', ...tokens(100) }], total: tokens(100) } }),
  ];
  const md = (await collect(projectToMarkdown(source(chats)))).join('');
  assert.match(md, /^# Billing API\n/);
  assert.match(md, /\*\*Directory:\*\* `\/work\/billing`/);
  assert.match(md, /\*\*Range:\*\* 2026-03-01T08:00:00Z to 2026-03-11T13:30:00Z/);
  assert.match(md, /\*\*Chats:\*\* 3/);
  assert.match(md, /\*\*Models:\*\* `claude-haiku-4-5`, `claude-opus-5`, `claude-sonnet-5`/);
  assert.match(md, /\*\*Cost:\*\* \$0\.75 \(as reported by the CLI; 1 chat started outside Agentry reported none and is not in it\)/);
  assert.match(md, /\*\*Tokens:\*\* 230 /);
  assert.match(md, /^1\. Chat aaaa1111 · `aaaa1111` · 2026-03-01T08:00:00Z · \$0\.50$/m);
  assert.match(md, /^3\. Chat cccc3333 · `cccc3333` · 2026-03-11T12:00:00Z$/m);

  // Every chat is a section a level down, rendered the way a single chat's export is
  assert.equal((md.match(/^## Chat /gm) ?? []).length, 3);
  assert.equal((md.match(/^### User/gm) ?? []).length, 3);
  assert.equal((md.match(/^### Assistant \(claude-opus-5\)/gm) ?? []).length, 3);
  assert.ok(md.indexOf('answer of aaaa1111') < md.indexOf('answer of bbbb2222'), 'in the order given');
  assert.ok(md.indexOf('answer of bbbb2222') < md.indexOf('answer of cccc3333'));
});

test('the Markdown export reads one transcript at a time, and names a chat that went away in its place', async () => {
  const chats = [chatFor('aaaa1111'), chatFor('bbbb2222'), chatFor('cccc3333')];
  const src = source(chats, { missing: ['bbbb2222'] });
  const pieces = projectToMarkdown(src)[Symbol.asyncIterator]();
  await pieces.next();
  assert.deepEqual(src.loaded, [], 'the header is written before any transcript is read');
  await pieces.next();
  assert.deepEqual(src.loaded, ['aaaa1111']);
  const rest = [];
  for (let next = await pieces.next(); !next.done; next = await pieces.next()) rest.push(next.value);
  assert.match(rest.join(''), /## Chat bbbb2222\n\n_The chat `bbbb2222` could not be read: chat not found\._/);
  assert.match(rest.join(''), /answer of cccc3333/);
});

test('a project with no chats and no reported cost says so', async () => {
  const md = (await collect(projectToMarkdown(source([])))).join('');
  assert.match(md, /\*\*Chats:\*\* 0/);
  assert.match(md, /\*\*Cost:\*\* not reported/);
  assert.doesNotMatch(md, /Range|## Chats|---/);
});

test('the JSON export is a ProjectExport written a chat at a time, leaving out a chat that went away', async () => {
  const chats = [chatFor('aaaa1111'), chatFor('bbbb2222'), chatFor('cccc3333')];
  const pieces = await collect(projectToJson(source(chats, { missing: ['aaaa1111'] })));
  assert.ok(pieces.length >= 4, 'more than one piece');
  const parsed = JSON.parse(pieces.join('')) as ProjectExport;
  assert.equal(parsed.exportedAt, '2026-03-12T09:00:00Z');
  assert.deepEqual(parsed.project, project);
  assert.deepEqual(parsed.chats.map((c) => c.chat.id), ['bbbb2222', 'cccc3333']);
  assert.deepEqual(parsed.chats[0]?.entries.map((e) => e.uuid), ['bbbb2222-u', 'bbbb2222-a']);

  assert.deepEqual(JSON.parse((await collect(projectToJson(source([])))).join('')).chats, []);
});

test('chats go oldest first, the undated last, and the file is named after the project', () => {
  const sorted = [chatFor('late', { startedAt: '2026-03-02T00:00:00Z' }), chatFor('none', { startedAt: null, updatedAt: null }), chatFor('early', { startedAt: '2026-03-01T00:00:00Z' })]
    .map((c) => c as ChatSummary)
    .sort(byStart);
  assert.deepEqual(sorted.map((c) => c.id), ['early', 'late', 'none']);
  assert.equal(projectExportFilename(project, 'markdown'), 'billing-api-9f1c2d3e.md');
  assert.equal(projectExportFilename({ id: project.id, name: '../..' }, 'json'), 'project-9f1c2d3e.json');
});
