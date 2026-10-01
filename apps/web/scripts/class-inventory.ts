// The class names the web UI defines and uses, read from the source, for the drift net of the web
// packages split: a move that loses, renames or reorders a stylesheet changes this inventory.
//
//   tsx scripts/class-inventory.ts --write   regenerates test/fixtures/class-names.json
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(WEB, '../..');
export const FIXTURE = path.join(WEB, 'test/fixtures/class-names.json');

export interface ClassInventory {
  /** Every class selector of every stylesheet, sorted */
  selectors: string[];
  /** Every static token of a `className`, sorted */
  classNames: string[];
  /** Stylesheet basenames in the order the app imports them, each after the sheets it `@import`s */
  stylesheets: string[];
}

/** `apps/web/src` and the `src` of every package, the places a stylesheet or a component can live */
export function sourceRoots(): string[] {
  const packages = readdirSync(path.join(REPO, 'packages')).map((name) => path.join(REPO, 'packages', name, 'src'));
  return [path.join(WEB, 'src'), ...packages].filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    })
    .sort();
}

/** Selectors live in the text before a `{`; declarations, strings and comments are not read */
export function selectorsOf(css: string): string[] {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\([^)]*\)/g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const found = new Set<string>();
  let buffer = '';
  for (const char of clean) {
    if (char === '{') {
      if (!buffer.trimStart().startsWith('@')) for (const match of buffer.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(match[1] as string);
      buffer = '';
    } else if (char === '}' || char === ';') buffer = '';
    else buffer += char;
  }
  return [...found];
}

interface Node {
  type: string;
  [key: string]: unknown;
}

/** Every string a `className` can be made of: literals and the parts of template literals */
function stringsIn(node: unknown, into: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) stringsIn(item, into);
    return;
  }
  const n = node as Node;
  if (n.type === 'Literal' && typeof n.value === 'string') into.push(n.value);
  else if (n.type === 'TemplateElement') into.push((n.value as { cooked?: string; raw: string }).cooked ?? (n.value as { raw: string }).raw);
  for (const value of Object.values(n)) stringsIn(value, into);
}

export function classNamesOf(file: string, code: string): string[] {
  const { program } = parseSync(file, code, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as Node;
    if (n.type === 'JSXAttribute' && (n.name as { name?: string }).name === 'className') stringsIn(n.value, found);
    if (n.type === 'Property') {
      const key = n.key as { name?: string; value?: unknown };
      if ((key.name ?? key.value) === 'className') stringsIn(n.value, found);
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(program);
  return found.flatMap((text) => text.split(/\s+/)).filter(Boolean);
}

function importsOf(css: string): string[] {
  return [...css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)].map((match) => match[1] as string);
}

/** A relative path, or a workspace package's subpath (`@agentry/ui/styles/tokens.css`, by its `exports`) */
function resolveSheet(from: string, specifier: string): string {
  const match = /^@agentry\/([^/]+)\/(.+)$/.exec(specifier);
  if (!match) return path.resolve(path.dirname(from), specifier);
  const dir = path.join(REPO, 'packages', match[1] as string);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports: Record<string, string> };
  return path.resolve(dir, pkg.exports[`./${match[2]}`] as string);
}

/** A sheet, preceded by the sheets it imports */
function sheetOrder(file: string, into: string[]): void {
  for (const target of importsOf(readFileSync(file, 'utf8'))) sheetOrder(resolveSheet(file, target), into);
  into.push(path.basename(file));
}

export function classInventory(): ClassInventory {
  const files = sourceRoots().flatMap(walk);
  const selectors = new Set<string>();
  const classNames = new Set<string>();
  for (const file of files) {
    if (file.endsWith('.css')) for (const selector of selectorsOf(readFileSync(file, 'utf8'))) selectors.add(selector);
    else if (/\.tsx?$/.test(file)) for (const token of classNamesOf(file, readFileSync(file, 'utf8'))) classNames.add(token);
  }
  const main = readFileSync(path.join(WEB, 'src/main.tsx'), 'utf8');
  const stylesheets: string[] = [];
  for (const match of main.matchAll(/^import\s+['"]((?:\.|@agentry\/)[^'"]+\.css)['"]/gm)) sheetOrder(resolveSheet(path.join(WEB, 'src', 'main.tsx'), match[1] as string), stylesheets);
  const sort = (set: Set<string>): string[] => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { selectors: sort(selectors), classNames: sort(classNames), stylesheets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(FIXTURE, `${JSON.stringify(classInventory(), null, 1)}\n`);
}
