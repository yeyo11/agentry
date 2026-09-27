import type { WorkItemActor, WorkItemActorKind, WorkItemAssignee } from '@agentry/shared';
import { fold } from './work-item-rows.ts';
import type { WorkItemContext } from './work-items.ts';

/** The checks every value goes through before the store writes it, and the refusal they throw. */

/** A refusal the caller can show as it is; `statusCode` is what the API answers with. */
export class WorkItemError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export const PERSON: WorkItemActor = { kind: 'person', role: null };

export const TITLE_MAX = 500;
export const LABEL_MAX = 64;
export const LABELS_MAX = 20;
export const CRITERIA_MAX = 100;
export const ROLE_MAX = 64;

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new WorkItemError(`${field} must be one of ${allowed.join(', ')}`, 400);
  return value as T;
}

export function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('title is required', 400);
  const t = value.trim();
  if (t.length > TITLE_MAX) throw new WorkItemError(`title is longer than ${String(TITLE_MAX)} characters`, 400);
  return t;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WorkItemError(`${field} must be text`, 400);
  return value;
}

/** Trimmed, blanks dropped, and a label repeated in another case kept once, as first written. */
export function labels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WorkItemError('labels must be a list', 400);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new WorkItemError('a label must be text', 400);
    const label = raw.trim();
    if (!label) continue;
    if (label.length > LABEL_MAX) throw new WorkItemError(`a label is longer than ${String(LABEL_MAX)} characters`, 400);
    if (seen.has(fold(label))) continue;
    seen.add(fold(label));
    out.push(label);
  }
  if (out.length > LABELS_MAX) throw new WorkItemError(`an item carries at most ${String(LABELS_MAX)} labels`, 400);
  return out;
}

export function assignee(value: unknown): WorkItemAssignee | null {
  if (value === null) return null;
  if (typeof value === 'object' && value !== null) {
    const v = value as { kind?: unknown; role?: unknown };
    if (v.kind === 'person') return { kind: 'person' };
    if (v.kind === 'role' && typeof v.role === 'string' && v.role.trim() && v.role.trim().length <= ROLE_MAX) return { kind: 'role', role: v.role.trim() };
  }
  throw new WorkItemError('assignee must be the person or a role', 400);
}

export function criterionText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('an acceptance criterion needs its text', 400);
  return value.trim();
}

/** A record rather than a list, so a kind added to the union fails to compile until it is here. */
const ACTOR_KINDS: Record<WorkItemActorKind, true> = { person: true, agent: true, system: true };

function isActorKind(value: unknown): value is WorkItemActorKind {
  return typeof value === 'string' && Object.hasOwn(ACTOR_KINDS, value);
}

/**
 * Checked like any input, though only code passes it: the kind is stored as text and read back by
 * whoever asks "did the person move this?", so a kind nobody knows must never reach a row.
 */
export function actorFrom(ctx: WorkItemContext | undefined): WorkItemActor {
  const actor: { kind?: unknown; role?: unknown } = ctx?.actor ?? PERSON;
  if (!isActorKind(actor.kind)) throw new WorkItemError('actor must be the person, an agent or the system', 400);
  if (actor.role === undefined || actor.role === null) return { kind: actor.kind, role: null };
  if (typeof actor.role !== 'string' || !actor.role.trim() || actor.role.trim().length > ROLE_MAX) {
    throw new WorkItemError(`an actor's role must be text of at most ${String(ROLE_MAX)} characters`, 400);
  }
  return { kind: actor.kind, role: actor.role.trim() };
}

export function milestoneName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('a milestone needs a name', 400);
  if (value.trim().length > TITLE_MAX) throw new WorkItemError(`a milestone name is longer than ${String(TITLE_MAX)} characters`, 400);
  return value.trim();
}
