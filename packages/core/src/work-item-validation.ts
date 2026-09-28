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
/** Room for an agent's report with its logs, short of a body that would bloat every read of the item */
export const COMMENT_MAX = 50_000;
/** A long chat message made into a task still fits; a pasted log that would weigh on every board read does not */
export const DESCRIPTION_MAX = 100_000;
/** A criterion is a sentence someone checks, not a document */
export const CRITERION_MAX = 2_000;
export const MILESTONE_DESCRIPTION_MAX = 10_000;
/** Longer than any id or key the app hands out */
const ID_MAX = 200;

/**
 * The body of a request, which must be an object. Without this, a missing or JSON `null` body
 * reads as a crash on its first field, and the API answers 500 for what is the caller's mistake.
 */
export function body<T extends object>(value: T | null | undefined): Partial<T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WorkItemError('the request body must be an object', 400);
  return value;
}

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

export function text(value: unknown, field: string, max = DESCRIPTION_MAX): string {
  if (typeof value !== 'string') throw new WorkItemError(`${field} must be text`, 400);
  if (value.length > max) throw new WorkItemError(`${field} is longer than ${String(max)} characters`, 400);
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
  if (value.trim().length > CRITERION_MAX) throw new WorkItemError(`an acceptance criterion is longer than ${String(CRITERION_MAX)} characters`, 400);
  return value.trim();
}

/** The checklist as a caller sends it: a list of `{ id?, text }`, at most {@link CRITERIA_MAX} of them. */
export function criteriaList(value: unknown): Array<{ id?: string; text: string }> {
  if (!Array.isArray(value)) throw new WorkItemError('acceptanceCriteria must be a list', 400);
  if (value.length > CRITERIA_MAX) throw new WorkItemError(`an item holds at most ${String(CRITERIA_MAX)} acceptance criteria`, 400);
  return value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new WorkItemError('an acceptance criterion must be an object with its text', 400);
    const { id, text: t } = entry as { id?: unknown; text?: unknown };
    const out = { text: criterionText(t) };
    if (id === undefined || id === null) return out;
    if (typeof id !== 'string' || !id) throw new WorkItemError("an acceptance criterion's id must be text", 400);
    return { ...out, id };
  });
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
/** An id a caller hands in: absent is null, anything present must be non-empty text. */
export function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > ID_MAX) throw new WorkItemError(`${field} must be a non-empty string`, 400);
  return value;
}

/**
 * A filter as a caller builds it from a query string, where a field repeated or left bare can
 * arrive as the wrong shape: lists must be lists of text, the rest text.
 */
export function filterOf<T extends object>(value: T | null | undefined): T {
  if (value === undefined || value === null) return {} as T;
  if (typeof value !== 'object' || Array.isArray(value)) throw new WorkItemError('the filter must be an object', 400);
  const lists = new Set(['status', 'type', 'priority', 'labels', 'assignee']);
  for (const [field, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const ok = lists.has(field) ? Array.isArray(v) && v.every((e) => typeof e === 'string') : typeof v === 'string';
    if (!ok) throw new WorkItemError(lists.has(field) ? `${field} must be a list of text` : `${field} must be text`, 400);
  }
  return value;
}

export function commentBody(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkItemError('a comment needs a body', 400);
  if (value.length > COMMENT_MAX) throw new WorkItemError(`a comment is longer than ${String(COMMENT_MAX)} characters`, 400);
  return value;
}

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
