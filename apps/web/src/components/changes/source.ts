import type { ChangeSummary, EditStep, FileDiff } from '@agentry/shared';
import type { ChangeScope, DiffOptions } from '../../api';

/**
 * Where a review reads from: a chat, a task, or an orchestration's integration branch. The screen
 * is the same for the three; only these loaders, the way back and what is live differ.
 */
export interface ReviewSource {
  kind: 'chat' | 'task' | 'integration';
  /** Names the source in the browser's "seen" store */
  storageKey: string;
  /** The summary of a scope; null when there is no git checkout to compare (a chat outside git) */
  summary: (scope: ChangeScope) => { queryKey: readonly unknown[]; queryFn: () => Promise<ChangeSummary | null> };
  diff: (path: string, opts: DiffOptions) => { queryKey: readonly unknown[]; queryFn: () => Promise<FileDiff> };
  /** The transcript's edits; null where there is no transcript (the integration branch) */
  steps: { queryKey: readonly unknown[]; queryFn: () => Promise<EditStep[]> } | null;
  /** The chat whose transcript the steps come from, for "See it in the conversation" */
  conversation: string | null;
  /** Something is still working on it, so it is read again on the events and a slow timer */
  live: boolean;
  back: { to: string; label: string };
  /** The chat's first prompt, the task's name: what the work was about */
  subject: string | null;
  /** What the agent is running now, to find the file it is editing */
  activity: { target: string | null; cwd: string | null; top: string | null } | null;
}

/** How often a live source is read again besides the events */
export const LIVE_REFRESH_MS = 8_000;
