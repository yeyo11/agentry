import type { AssistantResourceKind, ConfigScopeKind } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, keys } from '../../../api';

/**
 * The name a proposed resource is saved under: the one the assistant chose, or, when a file of its
 * kind already has it in that scope, the first `<name>-2`, `-3`… that is free. The API refuses to
 * overwrite a file, so a proposal named like an existing one could otherwise never be saved as it came.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/-\d+$/, '').slice(0, 60);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The content with its frontmatter's `name:` following a rename, where it named the resource as proposed. */
export function renamedContent(content: string, from: string, to: string): string {
  if (from === to) return content;
  const head = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0];
  if (!head) return content;
  const quoted = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const renamed = head.replace(new RegExp(`^(name:\\s*)(["']?)${quoted}\\2\\s*$`, 'm'), `$1$2${to}$2`);
  return renamed + content.slice(head.length);
}

/** The names a kind already has in a scope: the project's `.claude/` or the user's. */
export function useTakenNames(projectId: string, kind: AssistantResourceKind, scope: ConfigScopeKind): ReadonlySet<string> {
  const where = scope === 'project' ? { projectId } : {};
  const list = useQuery({ queryKey: keys.resources(where, kind), queryFn: () => api.resources(where, kind) });
  return useMemo(() => new Set((list.data ?? []).map((resource) => resource.name)), [list.data]);
}
