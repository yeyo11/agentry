import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { opencodeDbPath, PINNED_MIGRATIONS } from '../src/providers/opencode/opencode-db.ts';
import { OpencodeTranscripts } from '../src/providers/opencode/transcripts.ts';
import { TranscriptUnavailable } from '../src/providers/transcripts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const recording = join(here, 'fixtures/recordings/opencode/1.18.34');
const writerPath = join(here, 'opencode-writer.mjs');

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentry-opencode-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The recorded schema, as OpenCode's own migrations leave it, with sessions and a conversation in it. */
function fixtureDb(opts: { migrations?: string[]; layout?: 'message' | 'session_message'; journal?: string } = {}): string {
  const path = join(tmp(), 'opencode.db');
  // the recording ends with the dump of two tables and an exit line, which are not SQL
  const schema = readFileSync(join(recording, 'schema.sql'), 'utf8')
    .split('\n')
    .filter((l) => !/^(data_migration|migration) \[|^exit \d/.test(l))
    .join('\n');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${opts.journal ?? 'wal'}`);
  const firstTable = schema.indexOf('-- table');
  // the recording lists indexes first; they need their tables
  db.exec(schema.slice(firstTable));
  db.exec(schema.slice(schema.indexOf('-- index'), firstTable));
  for (const id of opts.migrations ?? PINNED_MIGRATIONS) db.prepare('INSERT INTO migration (id, time_completed) VALUES (?, ?)').run(id, 1);
  db.prepare('INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, 1, 1, ?)').run('prj_1', '/work/app', '[]');
  const session = db.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, model, cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write, time_created, time_updated, parent_id) VALUES (?, 'prj_1', ?, ?, ?, '1.18.34', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  session.run('ses_1', 'one', '/work/app', 'Fix the build', 'opencode/big-pickle', 0.25, 100, 20, 5, 10, 2, 1000, 3000, null);
  session.run('ses_2', 'two', '/work/other', 'Other', null, 0, 0, 0, 0, 0, 0, 500, 2000, null);
  session.run('ses_sub', 'sub', '/work/app', 'Subtask', null, 0, 0, 0, 0, 0, 0, 900, 2500, 'ses_1');
  if (opts.layout === 'session_message') {
    const m = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    m.run('sm_1', 'ses_1', 'user', 1, 1000, 1000, JSON.stringify({ text: 'run the build' }));
    m.run('sm_2', 'ses_1', 'compaction', 2, 1100, 1100, JSON.stringify({ weird: true }));
  } else {
    const m = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
    const p = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)');
    m.run('msg_1', 'ses_1', 1000, 1000, JSON.stringify({ role: 'user' }));
    p.run('prt_1', 'msg_1', 'ses_1', 1000, 1000, JSON.stringify({ type: 'text', text: 'run the build' }));
    m.run('msg_2', 'ses_1', 1100, 1100, JSON.stringify({ role: 'assistant', providerID: 'opencode', modelID: 'big-pickle' }));
    const parts: unknown[] = [
      { type: 'step-start' },
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'pnpm build' }, output: 'built ok' } },
      { type: 'tool', callID: 'call_2', tool: 'edit', state: { status: 'error', input: {}, error: 'no such file' } },
      { type: 'patch', hash: 'abc', files: ['a.ts'] },
      { type: 'snapshot', snapshot: 'x' },
      { type: 'text', text: 'The build passes.' },
      { type: 'step-finish', tokens: { input: 1 } },
    ];
    parts.forEach((data, i) => p.run(`prt_2${i}`, 'msg_2', 'ses_1', 1100, 1100, JSON.stringify(data)));
  }
  db.close();
  return path;
}

test('lists top-level sessions of a project and reads a summary with usage', async () => {
  const store = new OpencodeTranscripts({ dbPath: fixtureDb() });
  const all = await store.list();
  assert.deepEqual(all.map((s) => s.id), ['ses_1', 'ses_2'], 'newest first, subagent sessions left out');
  assert.deepEqual((await store.list('/work/app')).map((s) => s.id), ['ses_1']);
  const s = await store.summary('ses_1');
  assert.equal(s?.title, 'Fix the build');
  assert.equal(s?.projectPath, '/work/app');
  assert.equal(s?.firstPrompt, 'run the build');
  assert.equal(s?.messageCount, 2);
  assert.equal(s?.startedAt, new Date(1000).toISOString());
  assert.equal(s?.usage.total.input, 100);
  assert.equal(s?.usage.total.output, 25, 'reasoning tokens count as output');
  assert.equal(s?.usage.total.cacheRead, 10);
  assert.deepEqual(await store.cost('ses_1'), { cost: 0.25, tokens: s?.usage.total });
  assert.equal(await store.summary('ses_nope'), null);
});

test('maps parts to blocks and shows an unknown type instead of dropping it', async () => {
  const store = new OpencodeTranscripts({ dbPath: fixtureDb() });
  const page = await store.page('ses_1');
  assert.ok(page);
  assert.equal(page.total, 2);
  const [user, assistant] = page.entries;
  assert.equal(user?.role, 'user');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.model, 'opencode/big-pickle');
  assert.deepEqual(assistant?.blocks, [
    { type: 'thinking', text: 'thinking about it' },
    { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'pnpm build' } },
    { type: 'tool_result', toolUseId: 'call_1', content: 'built ok', isError: false },
    { type: 'tool_use', id: 'call_2', name: 'edit', input: {} },
    { type: 'tool_result', toolUseId: 'call_2', content: 'no such file', isError: true },
    { type: 'tool_use', id: 'abc', name: 'patch', input: { files: ['a.ts'] } },
    { type: 'text', text: '[opencode part: snapshot]' },
    { type: 'text', text: 'The build passes.' },
  ]);
  const older = await store.page('ses_1', { before: 1, limit: 5 });
  assert.equal(older?.from, 0);
  assert.equal(older?.entries.length, 1);
  const hits = await store.search('ses_1', 'build');
  assert.deepEqual(hits?.hits.map((h) => h.index), [0, 1]);
});

test('reads the session_message layout, an unknown row shown by its type', async () => {
  const store = new OpencodeTranscripts({ dbPath: fixtureDb({ layout: 'session_message' }) });
  const page = await store.page('ses_1');
  assert.equal(page?.total, 2);
  assert.deepEqual(page?.entries[0]?.blocks, [{ type: 'text', text: 'run the build' }]);
  assert.deepEqual(page?.entries[1]?.blocks, [{ type: 'text', text: '[opencode message: compaction]' }]);
});

test('the schema pin: a different migration set is untested, a newer one reads as degraded', async () => {
  const changed = [...PINNED_MIGRATIONS.slice(0, 10), '20260101000000_other', ...PINNED_MIGRATIONS.slice(11)];
  await assert.rejects(new OpencodeTranscripts({ dbPath: fixtureDb({ migrations: changed }) }).list(), (e) => e instanceof TranscriptUnavailable && e.reason === 'schema-untested');
  await assert.rejects(new OpencodeTranscripts({ dbPath: fixtureDb({ migrations: PINNED_MIGRATIONS.slice(0, 20) }) }).list(), (e) => e instanceof TranscriptUnavailable && e.reason === 'schema-untested');
  const newer = new OpencodeTranscripts({ dbPath: fixtureDb({ migrations: [...PINNED_MIGRATIONS, '20261201000000_next'] }) });
  assert.equal(await newer.schemaState(), 'degraded');
  assert.equal((await newer.list()).length, 2, 'a newer migration still reads');
  assert.equal(await new OpencodeTranscripts({ dbPath: fixtureDb() }).schemaState(), 'ok');
});

test('a missing database is an empty list, not an error', async () => {
  const store = new OpencodeTranscripts({ dbPath: join(tmp(), 'nope.db') });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.summary('ses_1'), null);
});

test('finds the file the way OpenCode does', () => {
  assert.equal(opencodeDbPath({ OPENCODE_DB: '/x/o.db', XDG_DATA_HOME: '/data' }), '/x/o.db');
  assert.equal(opencodeDbPath({ XDG_DATA_HOME: '/data' }), '/data/opencode/opencode.db');
  assert.equal(opencodeDbPath({ XDG_DATA_HOME: '/data' }, 'latest'), '/data/opencode/opencode.db');
  assert.equal(opencodeDbPath({ XDG_DATA_HOME: '/data' }, 'dev'), '/data/opencode/opencode-dev.db');
});

test('only the allowed tables are ever selected', () => {
  const src = [join(here, '../src/providers/opencode/transcripts.ts'), join(here, '../src/providers/opencode/opencode-db.ts')]
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const allowed = new Set(['session', 'message', 'part', 'session_message', 'project', 'todo', 'migration']);
  const tables = new Set<string>();
  for (const m of src.matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_]+)`?/g)) tables.add(m[1]!);
  assert.ok(tables.size > 0);
  for (const t of tables) assert.ok(allowed.has(t), `reads ${t}`);
  for (const secret of ['account', 'control_account', 'credential', 'session_share']) {
    assert.ok(!tables.has(secret));
  }
});

class Writer {
  private readonly lines: string[] = [];
  private waiting: ((l: string) => void) | null = null;
  readonly child: ChildProcessWithoutNullStreams;
  constructor(db: string, mode: string) {
    this.child = spawn(process.execPath, [writerPath, db, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (l) => (this.waiting ? this.waiting(l) : this.lines.push(l)));
  }
  private next(): Promise<string> {
    const queued = this.lines.shift();
    return queued !== undefined ? Promise.resolve(queued) : new Promise((resolve) => (this.waiting = (l) => ((this.waiting = null), resolve(l))));
  }
  async ready(): Promise<void> {
    assert.equal(await this.next(), 'ready');
  }
  async send(cmd: string): Promise<void> {
    this.child.stdin.write(`${cmd}\n`);
    assert.equal(await this.next(), 'ok');
  }
  async quit(): Promise<void> {
    const closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdin.write('quit\n');
    // a writer that does not answer is killed rather than left holding the database
    const killer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(killer);
  }
}

test('busy: retried until the writer lets go, and "busy" when it does not', async () => {
  const path = fixtureDb({ journal: 'delete' });
  const writer = new Writer(path, 'delete');
  await writer.ready();
  try {
    const store = new OpencodeTranscripts({ dbPath: path });
    await writer.send('lock');
    // released while the read is on its second try
    const released = new Promise<void>((resolve) => setTimeout(() => void writer.send('unlock').then(resolve), 400));
    assert.equal((await store.list()).length, 2);
    await released;
    await writer.send('lock');
    await assert.rejects(store.list(), (e) => e instanceof TranscriptUnavailable && e.reason === 'busy');
    await writer.send('unlock');
  } finally {
    await writer.quit();
  }
});

test('reads see what the writer wrote, and leave the file and its -wal byte for byte as they were', async () => {
  const path = fixtureDb();
  const writer = new Writer(path, 'wal');
  await writer.ready();
  try {
    await writer.send('write first words');
    const store = new OpencodeTranscripts({ dbPath: path });
    const wal = `${path}-wal`;
    const snapshot = () => ({
      db: readFileSync(path),
      walSize: existsSync(wal) ? statSync(wal).size : 0,
      wal: existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0),
    });
    assert.ok(snapshot().walSize > 0, 'the writer left changes in the -wal');
    const before = snapshot();
    for (let i = 0; i < 3; i++) {
      await store.list();
      await store.page('ses_1');
      await store.search('ses_1', 'words');
    }
    const after = snapshot();
    assert.ok(before.db.equals(after.db), 'the database file is unchanged');
    assert.equal(after.walSize, before.walSize, 'the -wal did not grow or shrink');
    assert.ok(before.wal.equals(after.wal), 'the -wal is unchanged');
    assert.equal((await store.search('ses_1', 'first words'))?.hits.length, 1, 'the WAL content is read');
  } finally {
    await writer.quit();
  }
});

test('watch signals a change of the database, debounced', async () => {
  const path = fixtureDb();
  const store = new OpencodeTranscripts({ dbPath: path });
  let calls = 0;
  const stop = store.watch(() => void calls++);
  try {
    const db = new DatabaseSync(path);
    db.exec(`UPDATE session SET title = 'x'`);
    db.exec(`UPDATE session SET title = 'y'`);
    db.close();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(calls, 1);
  } finally {
    stop();
  }
});
