import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// A Core holds a database, watchers, timers and child processes; a test file that builds one and
// never shuts it down can keep the test runner alive after its last test (CW-27: `apps/api` hung in
// CI after documents.test.ts, whose teardown only closed the app). `app.close()` does not shut the
// Core down, so every file that makes one says `.shutdown()` too.
const dir = new URL('.', import.meta.url);

test('every test file that builds a Core shuts one down', () => {
  const missing = readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts') && name !== 'teardown.test.ts')
    .filter((name) => {
      const text = readFileSync(new URL(name, dir), 'utf8');
      const built = text.split('new Core(').length - 1;
      const shut = text.split('.shutdown()').length - 1;
      return built > 0 && shut === 0;
    });
  assert.deepEqual(missing, []);
});
