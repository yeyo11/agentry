// The modules the app reaches from `src/main.tsx`, for the drift net of the web packages split.
//
// A node is identified by its file basename and its sorted export names, so a file that moves with
// the same surface is the same node. A shim (a module made only of `export … from`) is collapsed:
// an import of it is an import of what it re-exports. The lazy chunks are the dynamic-import edges.
//
//   tsx scripts/module-graph.ts --write   regenerates test/fixtures/module-graph.json
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(WEB, '../..');
export const FIXTURE = path.join(WEB, 'test/fixtures/module-graph.json');
const ENTRY = path.join(WEB, 'src/main.tsx');

export interface ModuleGraph {
  /** `basename [export, …]`, one per reachable module, sorted, duplicates kept */
  nodes: string[];
  /** `from -> to` for every dynamic import, sorted */
  lazy: string[];
  /** Reachable non-shim files with the same content as another, as paths; a copy instead of a move */
  duplicates: string[];
}

interface Node {
  type: string;
  [key: string]: unknown;
}

interface Module {
  file: string;
  exports: string[];
  statics: string[];
  dynamics: string[];
  /** True when every statement is an `export … from` */
  shim: boolean;
}

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

/** Relative paths and the `exports` of the workspace's own packages; everything else is external */
function resolveImport(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) {
    const base = path.resolve(path.dirname(from), specifier);
    if (isFile(base) && /\.tsx?$/.test(base)) return base;
    return EXTENSIONS.map((ext) => base + ext).find(isFile);
  }
  const match = /^@agentry\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return undefined;
  const dir = path.join(REPO, 'packages', match[1] as string);
  if (!existsSync(path.join(dir, 'package.json'))) return undefined;
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string | Record<string, string>> };
  const target = pkg.exports?.[`.${match[2] ?? ''}`];
  const relative = typeof target === 'string' ? target : target?.default ?? target?.import;
  // A stylesheet a package exports is not a module of the graph
  return relative && /\.tsx?$/.test(relative) ? path.resolve(dir, relative) : undefined;
}

function exportName(node: unknown): string {
  const n = node as { name?: string; value?: string };
  return (n.name ?? n.value) as string;
}

function declaredNames(declaration: Node): string[] {
  if (declaration.type === 'VariableDeclaration') {
    return (declaration.declarations as Node[]).flatMap((d) => bindingNames(d.id as Node));
  }
  const id = declaration.id as { name?: string } | null | undefined;
  return id?.name ? [id.name] : [];
}

function bindingNames(pattern: Node): string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name as string];
    case 'ObjectPattern':
      return (pattern.properties as Node[]).flatMap((p) => bindingNames((p.type === 'RestElement' ? p.argument : p.value) as Node));
    case 'ArrayPattern':
      return (pattern.elements as (Node | null)[]).flatMap((e) => (e ? bindingNames(e) : []));
    case 'AssignmentPattern':
      return bindingNames(pattern.left as Node);
    case 'RestElement':
      return bindingNames(pattern.argument as Node);
    default:
      return [];
  }
}

function read(file: string): Module {
  const code = readFileSync(file, 'utf8');
  const { program } = parseSync(file, code, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const exports: string[] = [];
  const statics: string[] = [];
  const dynamics: string[] = [];
  const body = program.body as unknown as Node[];
  for (const statement of body) {
    const source = (statement.source as { value?: string } | null | undefined)?.value;
    switch (statement.type) {
      case 'ImportDeclaration':
        if (statement.importKind !== 'type' && source) statics.push(source);
        break;
      case 'ExportAllDeclaration':
        if (source && statement.exportKind !== 'type') statics.push(source);
        exports.push(statement.exported ? exportName(statement.exported) : `* from ${path.basename(source ?? '')}`);
        break;
      case 'ExportNamedDeclaration':
        if (source && statement.exportKind !== 'type') statics.push(source);
        if (statement.declaration) exports.push(...declaredNames(statement.declaration as Node));
        for (const specifier of statement.specifiers as Node[]) exports.push(exportName(specifier.exported));
        break;
      case 'ExportDefaultDeclaration':
        exports.push('default');
        break;
      default:
        break;
    }
  }
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as Node;
    if (n.type === 'ImportExpression') {
      const source = n.source as Node;
      if (source.type === 'Literal' && typeof source.value === 'string') dynamics.push(source.value);
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(program);
  const shim = body.length > 0 && body.every((s) => (s.type === 'ExportAllDeclaration' || s.type === 'ExportNamedDeclaration') && Boolean(s.source));
  return { file, exports: [...new Set(exports)].sort(), statics, dynamics, shim };
}

export function moduleGraph(): ModuleGraph {
  const modules = new Map<string, Module>();
  const load = (file: string): Module => {
    let module = modules.get(file);
    if (!module) {
      module = read(file);
      modules.set(file, module);
    }
    return module;
  };
  const id = (module: Module): string => `${path.basename(module.file).replace(/\.tsx?$/, '')} [${module.exports.join(', ')}]`;
  /** The real modules an import of `file` stands for: itself, or what a shim re-exports */
  const collapse = (file: string, seen = new Set<string>()): string[] => {
    const module = load(file);
    if (!module.shim) return [file];
    if (seen.has(file)) return [];
    seen.add(file);
    return module.statics.flatMap((specifier) => {
      const target = resolveImport(file, specifier);
      return target ? collapse(target, seen) : [];
    });
  };

  const reachable = new Set<string>();
  const lazy = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reachable.has(file)) continue;
    reachable.add(file);
    const module = load(file);
    for (const specifier of [...module.statics, ...module.dynamics]) {
      const target = resolveImport(file, specifier);
      if (!target) continue;
      const real = collapse(target);
      for (const next of real) queue.push(next);
      if (module.dynamics.includes(specifier) && !module.statics.includes(specifier)) {
        for (const next of real) lazy.add(`${id(module)} -> ${id(load(next))}`);
      }
    }
  }

  const byContent = new Map<string, string[]>();
  for (const file of reachable) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    byContent.set(hash, [...(byContent.get(hash) ?? []), path.relative(REPO, file)]);
  }
  const sort = (items: string[]): string[] => items.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    nodes: sort([...reachable].map((file) => id(load(file)))),
    lazy: sort([...lazy]),
    duplicates: sort([...byContent.values()].filter((files) => files.length > 1).flat()),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(FIXTURE, `${JSON.stringify(moduleGraph(), null, 1)}\n`);
}
