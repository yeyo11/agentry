import type { ResourceKind } from '@agentry/shared';

/**
 * What would keep the CLI from reading a resource's frontmatter, checked before it is saved. The CLI
 * gives no error for a broken block: an agent without a name or a description, or a `key: value`
 * line YAML cannot parse, is skipped without a word, and the person finds out when the agent never
 * shows up in a chat.
 */
export type FrontmatterProblem = 'missing' | 'unclosed' | 'line' | 'name' | 'description';

/** The fields each kind cannot do without: an agent is picked by its name and description, a skill by its description. */
const REQUIRED: Partial<Record<ResourceKind, readonly ('name' | 'description')[]>> = {
  agents: ['name', 'description'],
  skills: ['description'],
};

const KEY_LINE = /^([A-Za-z][\w-]*):(?:\s+(.*)|\s*)$/;

export function frontmatterProblem(kind: ResourceKind, content: string): FrontmatterProblem | null {
  // A workflow is a script, with its metadata in code
  if (kind === 'workflows') return null;
  const required = REQUIRED[kind] ?? [];
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return required.length > 0 ? 'missing' : null;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end < 0) return 'unclosed';
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    // Blank lines, comments, list items and the indented lines of a block value belong to the key above
    if (!line.trim() || line.trimStart().startsWith('#') || /^\s/.test(line)) continue;
    const match = KEY_LINE.exec(line);
    if (!match?.[1]) return 'line';
    // A colon inside a plain value is left alone: the CLI reads `description: Use it when: …` as written
    fields.set(match[1], (match[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim());
  }
  for (const field of required) if (!fields.get(field)) return field;
  return null;
}
