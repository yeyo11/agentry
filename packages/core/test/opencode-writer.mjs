// Stands in for OpenCode as the process that writes its database: the tests read while it holds locks.
// usage: node opencode-writer.mjs <db> <journal-mode>; commands arrive on stdin, one per line, and
// each is answered with one line: `lock` (exclusive write lock), `unlock`, `write <text>`, `quit`.
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const [, , path, mode = 'wal'] = process.argv;
const db = new DatabaseSync(path);
db.exec(`PRAGMA journal_mode = ${mode}`);
// like OpenCode's own: the writer never checkpoints behind the readers' back
db.exec('PRAGMA wal_autocheckpoint = 0');
let n = 0;

const commands = {
  lock: () => db.exec('BEGIN EXCLUSIVE'),
  unlock: () => db.exec('COMMIT'),
  write: (text) => {
    n += 1;
    const id = `msg_w${n}`;
    const now = Date.now();
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'ses_1',
      now,
      now,
      JSON.stringify({ role: 'user' }),
    );
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
      `prt_w${n}`,
      id,
      'ses_1',
      now,
      now,
      JSON.stringify({ type: 'text', text }),
    );
  },
};

console.log('ready');
for await (const line of createInterface({ input: process.stdin })) {
  const [name, ...rest] = line.split(' ');
  if (name === 'quit') break;
  try {
    commands[name]?.(rest.join(' '));
    console.log('ok');
  } catch (e) {
    console.log(`error ${e instanceof Error ? e.message : String(e)}`);
  }
}
db.close();
