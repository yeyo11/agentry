// The shape of the built bundle, for the drift net of the web packages split: which JS chunks
// exist (hashes removed) and which assets `index.html` asks for, which is the service worker's
// shell. A lazy chunk that became eager, or a primitive that dragged the highlighter into the
// shell, shows up here. Run it after `pnpm build`.
//
//   tsx scripts/bundle-shape.ts --check   compares dist/ with test/fixtures/bundle-shape.json
//   tsx scripts/bundle-shape.ts --write   regenerates the fixture
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB, 'dist');
const FIXTURE = path.join(WEB, 'test/fixtures/bundle-shape.json');

export interface BundleShape {
  /** JS chunk names, hashes removed, sorted */
  chunks: string[];
  /** What `index.html` references, hashes removed, in document order */
  shell: string[];
}

/** `Chat-Bx3k9Q_a.js` → `Chat.js`: Vite's hash is 8 characters of base64url before the extension */
function unhash(name: string): string {
  return name.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1');
}

export function bundleShape(): BundleShape {
  const chunks = readdirSync(path.join(DIST, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .map(unhash)
    .sort();
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const shell = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((match) => unhash(match[1] as string));
  return { chunks, shell };
}

function lines(shape: BundleShape): string[] {
  return [...shape.chunks.map((name) => `chunk ${name}`), ...shape.shell.map((name, i) => `shell ${i} ${name}`)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shape = bundleShape();
  if (process.argv.includes('--write')) {
    writeFileSync(FIXTURE, `${JSON.stringify(shape, null, 1)}\n`);
  } else if (process.argv.includes('--check')) {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BundleShape;
    const expected = new Set(lines(fixture));
    const actual = new Set(lines(shape));
    const removed = [...expected].filter((line) => !actual.has(line));
    const added = [...actual].filter((line) => !expected.has(line));
    if (removed.length > 0 || added.length > 0) {
      for (const line of removed) console.error(`- ${line}`);
      for (const line of added) console.error(`+ ${line}`);
      console.error('The bundle changed shape: update test/fixtures/bundle-shape.json only if the task changes it on purpose.');
      process.exit(1);
    }
    console.log(`bundle shape unchanged: ${shape.chunks.length} chunks, ${shape.shell.length} shell assets`);
  } else {
    console.error('usage: bundle-shape.ts --check | --write');
    process.exit(2);
  }
}
