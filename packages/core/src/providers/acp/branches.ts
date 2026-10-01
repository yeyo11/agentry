import type { TranscriptEntry } from '@agentry/shared';
import type { BackgroundTask, SubagentInfo, WorkflowRun } from '../../cli-facts.ts';
import type { BranchTracker } from '../driver.ts';

/**
 * What an ACP agent delegated: nothing Agentry can see. ACP has no background tasks, subagents or
 * workflows, so the maps stay empty and the chat's branches list nothing for these providers.
 */
export class AcpBranches implements BranchTracker {
  readonly tasks = new Map<string, BackgroundTask>();
  readonly foregroundTasks = new Map<string, BackgroundTask>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly workflows = new Map<string, WorkflowRun>();
  sessionId = '';

  message(_entry: TranscriptEntry): void {}
  task(_change: string, _raw: Record<string, unknown>): void {}
  endAll(_at: string): void {}
}
