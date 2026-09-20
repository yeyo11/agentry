import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, 'fixtures/parity');

/**
 * The parity corpus kept with the tests, one directory per language: files copied from this
 * repository, frozen so the floors the test holds do not move when the code does, and snippets of
 * what the repository has little or none of (Python, shell, JSX, HTML). Every file ends in `.txt`
 * so no tool takes it for source of its own.
 */
export function corpusFixtures(lang: string): string[] {
  const dir = join(DIR, lang);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}
