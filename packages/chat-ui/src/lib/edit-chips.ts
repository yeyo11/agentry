import type { EditStep } from '@agentry/shared';
import type { StepPart } from './chat-steps';

/*
 * The edit chips of a transcript: one per file a tool group edited. Apart from changes-summary so
 * the chat package can use them without the review screen's helpers; changes-summary re-exports.
 */

const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit']);

export const isEditTool = (name: string | null | undefined): boolean => EDIT_TOOLS.has((name ?? '').toLowerCase());

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1) || path;

export interface EditChip {
  /** The file as the call named it */
  file: string;
  name: string;
  /** The last call on the file in this group: the step the chip opens */
  stepId: string;
  /** Null until the chat's steps are known, or when none of the calls is a step */
  additions: number | null;
  deletions: number | null;
}

function editedPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const { file_path: file, notebook_path: notebook } = input as Record<string, unknown>;
  const path = typeof file === 'string' ? file : typeof notebook === 'string' ? notebook : null;
  return path?.trim() || null;
}

/**
 * One chip per file a tool group edited. A call that failed made no step, so it gets no chip; one
 * still waiting does, since the step it becomes is the one the chip opens.
 */
export function editChips(parts: readonly StepPart[], steps: ReadonlyMap<string, EditStep> | null): EditChip[] {
  const chips = new Map<string, EditChip>();
  for (const part of parts) {
    if (part.kind !== 'call' || !isEditTool(part.name) || part.result?.isError) continue;
    const file = editedPath(part.input);
    if (!file) continue;
    const chip = chips.get(file) ?? { file, name: baseName(file), stepId: part.id, additions: null, deletions: null };
    chip.stepId = part.id;
    const step = steps?.get(part.id);
    if (step) {
      chip.additions = (chip.additions ?? 0) + step.additions;
      chip.deletions = (chip.deletions ?? 0) + step.deletions;
    }
    chips.set(file, chip);
  }
  return [...chips.values()];
}
