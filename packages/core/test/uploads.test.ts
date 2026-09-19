import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeMessage } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { RunManager } from '../src/runner.ts';
import { UploadStore, safeName, sniffMediaType } from '../src/uploads.ts';
import { tempConfig } from './helpers.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

test('names and types are what the bytes say, and nothing escapes the upload folder', () => {
  assert.equal(sniffMediaType(PNG, 'x.jpg'), 'image/png');
  assert.equal(sniffMediaType(PDF, 'x'), 'application/pdf');
  assert.equal(sniffMediaType(Buffer.from('a,b'), 'data.csv'), 'text/csv');
  assert.equal(sniffMediaType(Buffer.from('<svg/>'), 'logo.svg'), 'image/svg+xml');
  assert.equal(safeName('../../.ssh/id_rsa'), 'id_rsa');
  assert.equal(safeName('..'), 'file');
  const store = new UploadStore(tempConfig().dataDir);
  // SVG is not an image Claude can see; it travels as a file
  assert.equal(store.save('logo.svg', Buffer.from('<svg/>')).kind, 'file');
  assert.throws(() => store.get('../meta'), /not found/);
});

test('transcript image and document blocks keep what they are and drop the bytes', () => {
  const entry = normalizeMessage({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' }, title: 'spec.pdf' },
        { type: 'text', text: 'look' },
      ],
    },
  });
  assert.deepEqual(entry?.blocks, [
    { type: 'image', mediaType: 'image/png' },
    { type: 'document', mediaType: 'application/pdf', name: 'spec.pdf' },
    { type: 'text', text: 'look' },
  ]);
});

test('a turn with attachments sends images and PDFs as blocks and names every file by path', async () => {
  const config = tempConfig();
  // Reports what it was given: its arguments and the content of the first message
  const fake = join(mkdtempSync(join(tmpdir(), 'agentry-fake-')), 'claude');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.once('line', (line) => {
  const content = JSON.parse(line).message.content;
  const report = { args: process.argv.slice(2), content: Array.isArray(content) ? content.map((b) => ({ type: b.type, media: b.source && b.source.media_type, title: b.title, text: b.text })) : content };
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) }) + '\\n');
});
rl.on('close', () => process.exit(0));
`,
  );
  chmodSync(fake, 0o755);
  const db = new Db(config);
  const runs = new RunManager({ ...config, claudeBin: fake }, db);
  const uploads = new UploadStore(config.dataDir);
  runs.uploads = uploads;
  const image = uploads.save('shot.png', PNG);
  const pdf = uploads.save('spec.pdf', PDF);
  const zip = uploads.save('src.zip', Buffer.from('PK\u0003\u0004'));

  const run = runs.start({ prompt: 'what is in these?', attachments: [image.id, pdf.id, zip.id], keepAlive: false });
  const report = JSON.parse((await runs.waitForResult(run.id)).result) as {
    args: string[];
    content: Array<{ type: string; media?: string; title?: string; text?: string }>;
  };

  assert.equal(report.args[report.args.indexOf('--add-dir') + 1], uploads.dir);
  assert.deepEqual(
    report.content.map((b) => b.type),
    ['image', 'document', 'text'],
  );
  assert.equal(report.content[1]?.title, 'spec.pdf');
  const text = report.content[2]?.text ?? '';
  assert.match(text, /^what is in these\?/);
  // The zip reaches Claude only by its path, which is readable thanks to --add-dir
  for (const a of [image, pdf, zip]) assert.ok(text.includes(a.path), `${a.name} is not named`);
  db.close();
});
