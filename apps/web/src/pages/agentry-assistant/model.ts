import { ChartColumn, SquareCheck, Users, Workflow, type LucideIcon } from 'lucide-react';

/** The Agentry assistant's entry screen: a global chat, not one of a project (that is `pages/assistant`). */
export const AGENTRY_ASSISTANT_PATH = '/assistant';

/** What the assistant can do, as the suggestions of the entry screen; each fills the composer and never sends. */
export const STARTERS: ReadonlyArray<{ key: 'board' | 'orchestrations' | 'team' | 'usage'; icon: LucideIcon }> = [
  { key: 'board', icon: SquareCheck },
  { key: 'orchestrations', icon: Workflow },
  { key: 'team', icon: Users },
  { key: 'usage', icon: ChartColumn },
];
