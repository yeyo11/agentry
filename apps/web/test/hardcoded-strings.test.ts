import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// Vite re-exports rolldown's (oxc) parser, so the scan reads a real TSX syntax tree instead of
// guessing with regexes: `a > b` is not JSX text and `Array<Foo>` is not a tag.
import { parseSync } from 'vite';

const SRC = path.join(import.meta.dirname, '..', 'src');

/** Attributes and object keys the person reads on screen. */
const VISIBLE_ATTRS = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'content',
  'description',
  'hint',
  'label',
  'placeholder',
  'summary',
  'title',
]);
const VISIBLE_PROPS = new Set(['body', 'cancelLabel', 'confirmLabel', 'description', 'hint', 'label', 'message', 'placeholder', 'summary', 'title', 'tooltip']);

/**
 * Every string here is English on purpose. A new one needs a reason, not just a line: if it is text
 * a person reads, it belongs in `src/i18n/locales/`.
 */
const ALLOWED: ReadonlyArray<{ text: string; why: string }> = [
  { text: 'Agentry', why: 'the product name, the same in every language' },
  { text: 'Claude', why: "the assistant's name, as Claude Code writes it in a transcript" },
  { text: 'Esc', why: 'the key as it is engraved on the keyboard' },
  { text: 'Ctrl', why: 'the key as it is engraved on the keyboard' },
  { text: 'The user declined to answer', why: 'the default deny reason, read by the model and not by a person' },
  { text: 'The user wants to keep planning', why: 'the default plan feedback, read by the model and not by a person' },
];

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : files(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Text a reader would notice, as opposed to an identifier, a path, a flag or a code sample: a
 * sentence, or a single capitalised word like a button's "Save".
 */
function isUserVisible(raw: string): boolean {
  const value = raw.trim();
  if (!/\p{L}/u.test(value)) return false;
  if (/[<>{}$@\\/_=;|`~#&*+[\]()]/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length > 1) return true;
  return /^\p{Lu}\p{Ll}+[.!?…]?$/u.test(value);
}

/** The literals of a node that could carry text: a string, a template's parts, a ternary's arms. */
function literals(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as Node;
  switch (n.type) {
    case 'Literal':
      return typeof n.value === 'string' ? [n.value] : [];
    case 'TemplateLiteral':
      return (n.quasis as Array<{ value: { cooked: string } }>).map((q) => q.value.cooked);
    case 'JSXExpressionContainer':
      return literals(n.expression);
    case 'ConditionalExpression':
      return [...literals(n.consequent), ...literals(n.alternate)];
    case 'LogicalExpression':
      return [...literals(n.right)];
    default:
      return [];
  }
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(file: string): Finding[] {
  const code = readFileSync(file, 'utf8');
  const { program } = parseSync(file, code, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const found: Finding[] = [];
  const add = (node: Node, texts: string[]) => {
    for (const text of texts) {
      if (!isUserVisible(text)) continue;
      found.push({ file: path.relative(SRC, file), line: code.slice(0, node.start).split('\n').length, text: text.trim() });
    }
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as Node;
    switch (n.type) {
      case 'JSXText':
        add(n, [n.value as string]);
        break;
      case 'JSXAttribute': {
        const name = (n.name as { name?: string }).name;
        if (name && VISIBLE_ATTRS.has(name)) add(n, literals(n.value));
        break;
      }
      case 'JSXElement':
      case 'JSXFragment':
        for (const child of n.children as Node[]) if (child.type === 'JSXExpressionContainer') add(child, literals(child));
        break;
      case 'Property': {
        const key = n.key as { name?: string; value?: unknown };
        const name = key.name ?? (typeof key.value === 'string' ? key.value : undefined);
        if (name && VISIBLE_PROPS.has(name)) add(n, literals(n.value));
        break;
      }
      case 'CallExpression': {
        const callee = n.callee as { type: string; name?: string; object?: { name?: string } };
        const target = callee.type === 'MemberExpression' ? callee.object?.name : callee.name;
        if (target === 'toast' || target === 'confirm' || target === 'alert') add(n, (n.arguments as unknown[]).flatMap(literals));
        break;
      }
      default:
        break;
    }
    for (const value of Object.values(n)) walk(value);
  };
  walk(program);
  return found;
}

test('no user-visible English is hard-coded outside the i18n resources', () => {
  const allowed = new Set(ALLOWED.map((entry) => entry.text));
  const findings = files(SRC).flatMap(scan);
  const offenders = findings.filter((finding) => !allowed.has(finding.text));
  assert.deepEqual(
    offenders.map((f) => `${f.file}:${f.line} ${JSON.stringify(f.text)}`),
    [],
    'move these strings to src/i18n/locales/, or add them to ALLOWED with the reason they stay English',
  );
});

test('every allowed string is still there', () => {
  const found = new Set(files(SRC).flatMap(scan).map((finding) => finding.text));
  assert.deepEqual(
    ALLOWED.filter((entry) => !found.has(entry.text)).map((entry) => entry.text),
    [],
    'these exceptions no longer match anything: drop them from ALLOWED',
  );
});
