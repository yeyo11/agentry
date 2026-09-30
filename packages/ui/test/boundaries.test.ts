import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

/**
 * @agentry/ui is the bottom of the web stack: it may import the shared types, the libraries it
 * declares and itself, and nothing that sits above it. The provider vocabulary stays out too, so
 * the primitives never learn what a model alias or a permission mode is.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

const FORBIDDEN_PACKAGES = ['@agentry/web', '@agentry/chat-ui', '@agentry/core', '@agentry/api', '@agentry/desktop'];
const FORBIDDEN_SHARED_NAMES = ['MODEL_ALIASES', 'PERMISSION_MODES'];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

interface Reference {
  specifier: string;
  names: string[];
}

interface Node {
  type: string;
  [key: string]: unknown;
}

/** Depth-first walk over an ESTree/oxc node; comments are not nodes, so they are never visited. */
export function visit(node: unknown, fn: (node: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, fn);
    return;
  }
  const n = node as Node;
  if (typeof n.type === 'string') fn(n);
  for (const value of Object.values(n)) visit(value, fn);
}

const literalString = (node: unknown): string | undefined => {
  const n = node as Node | undefined;
  return n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : undefined;
};

const nameOf = (node: unknown): string => {
  const n = node as { name?: string; value?: string };
  return n.name ?? n.value ?? '';
};

export function parse(file: string, text: string): unknown {
  return parseSync(file, text, { lang: file.endsWith('x') ? 'tsx' : 'ts' }).program;
}

function tsReferences(file: string): Reference[] {
  const found: Reference[] = [];
  visit(parse(file, readFileSync(file, 'utf8')), (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const specifier = literalString(node.source);
      if (specifier === undefined) return;
      const names = ((node.specifiers as Node[] | undefined) ?? []).map((entry) => nameOf(entry.imported ?? entry.local));
      found.push({ specifier, names });
    } else if (node.type === 'ImportExpression') {
      const specifier = literalString(node.source);
      if (specifier !== undefined) found.push({ specifier, names: [] });
    } else if (node.type === 'TSImportType') {
      const argument = node.argument as Node | undefined;
      const specifier = literalString(argument?.type === 'TSLiteralType' ? argument.literal : argument);
      if (specifier !== undefined) found.push({ specifier, names: [] });
    }
  });
  return found;
}

function cssReferences(file: string): Reference[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/g)].flatMap(([, specifier]) => (specifier ? [{ specifier, names: [] }] : []));
}

export function violations(file: string, references: Reference[], root: string): string[] {
  const bad: string[] = [];
  for (const { specifier, names } of references) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      if (target !== root && !target.startsWith(root + sep)) bad.push(`${specifier} leaves src`);
    } else if (FORBIDDEN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
      bad.push(`${specifier} is above this package`);
    } else if (/(^|\/)apps\//.test(specifier)) {
      bad.push(`${specifier} reaches into apps/`);
    } else if (specifier === '@agentry/shared') {
      for (const name of names) if (FORBIDDEN_SHARED_NAMES.includes(name)) bad.push(`${name} is one provider's vocabulary`);
    }
  }
  return bad.map((message) => `${relative(root, file)}: ${message}`);
}

test('nothing under packages/ui/src reaches above the package', () => {
  const all = walk(SRC).flatMap((file) => violations(file, file.endsWith('.css') ? cssReferences(file) : tsReferences(file), SRC));
  assert.deepEqual(all, []);
});

test('the checker catches what it exists to catch', () => {
  const file = join(SRC, 'a/b.ts');
  const bad = violations(
    file,
    [
      { specifier: '../../outside', names: [] },
      { specifier: '@agentry/web/src/x', names: [] },
      { specifier: '@agentry/chat-ui/components/x', names: [] },
      { specifier: '../../../apps/web/src/x', names: [] },
      { specifier: '@agentry/shared', names: ['MODEL_ALIASES'] },
      { specifier: '@agentry/shared', names: ['RunEvent'] },
      { specifier: '../c', names: [] },
    ],
    SRC,
  );
  assert.equal(bad.length, 5);
});
