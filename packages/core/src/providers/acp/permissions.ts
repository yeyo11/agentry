import { isAbsolute, relative } from 'node:path';
import type { PermissionDecision } from '@agentry/shared';
import type { NeutralRequest } from '../../policy-judge.ts';
import type { PermissionQuestion } from '../driver.ts';

/** One choice `session/request_permission` offers. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** A tool call as the agent describes it in a permission request or a `tool_call` update. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path?: unknown }>;
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The files a tool call touches, relative to the project when they are inside it. */
function pathsOf(call: AcpToolCall, cwd: string): string[] {
  const raw = asRecord(call.rawInput);
  const found = [...(call.locations ?? []).map((l) => text(l.path)), text(raw.path), text(raw.file_path), text(raw.filePath)].filter((p): p is string => !!p);
  const inProject = (path: string): string => {
    if (!isAbsolute(path)) return path;
    const rel = relative(cwd, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  };
  return [...new Set(found.map(inProject))];
}

/** The command line of an `execute` call: every agent puts it in `rawInput.command`, else its title. */
function commandOf(call: AcpToolCall): string | undefined {
  const raw = asRecord(call.rawInput);
  const command = raw.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((w) => typeof w === 'string')) return command.join(' ');
  return text(call.title);
}

/**
 * What an agent asks to do, in Agentry's words, for the policy judge: `execute` is a command,
 * `edit`/`delete`/`move` an edit of the paths it names, `read`/`search` a read, `fetch` a fetch,
 * and anything else `other`, which the judge always leaves to a person.
 */
export function neutralRequest(call: AcpToolCall, cwd: string): NeutralRequest {
  switch (call.kind) {
    case 'execute': {
      const command = commandOf(call);
      return command === undefined ? { kind: 'other' } : { kind: 'command', command };
    }
    case 'edit':
    case 'delete':
    case 'move':
      return { kind: 'edit', paths: pathsOf(call, cwd) };
    case 'read':
    case 'search':
      return { kind: 'read', paths: pathsOf(call, cwd) };
    case 'fetch': {
      const url = text(asRecord(call.rawInput).url);
      return { kind: 'fetch', ...(url ? { url } : {}) };
    }
    default:
      return { kind: 'other' };
  }
}

/** The question the host puts to a person, from the agent's request. */
export function questionOf(id: string, call: AcpToolCall, cwd: string): PermissionQuestion {
  const raw = asRecord(call.rawInput);
  const request = neutralRequest(call, cwd);
  return {
    id,
    toolName: call.title || call.kind || 'tool',
    toolUseId: call.toolCallId,
    input: { kind: call.kind ?? 'other', ...raw, ...(call.locations?.length ? { locations: call.locations } : {}) },
    request,
  };
}

/**
 * The option that carries a decision out: the one whose `kind` matches (`allow_once`, or
 * `allow_always` when the person chose "always for this chat", `reject_once`). An agent that
 * offers no such option gets `null`, and the request is answered `cancelled`.
 */
export function optionFor(options: readonly PermissionOption[], decision: PermissionDecision): PermissionOption | null {
  const kinds = decision.behavior === 'allow' ? (decision.updatedPermissions?.length ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']) : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const option = options.find((o) => o.kind === kind);
    if (option) return option;
  }
  return null;
}

export function optionsOf(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const o = asRecord(entry);
    return typeof o.optionId === 'string' && typeof o.kind === 'string' ? [{ optionId: o.optionId, name: typeof o.name === 'string' ? o.name : o.optionId, kind: o.kind }] : [];
  });
}
