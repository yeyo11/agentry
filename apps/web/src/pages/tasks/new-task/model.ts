import type { WorkItemAssignee, WorkItemPriority, WorkItemRef, WorkItemRelationType, WorkItemStatus, WorkItemType } from '@agentry/shared';

export interface Draft {
  type: WorkItemType;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  assignee: WorkItemAssignee | null;
  epicId: string | null;
  milestoneId: string | null;
  labels: string[];
  relations: Array<{ type: WorkItemRelationType; item: WorkItemRef }>;
  criteria: string[];
}

export type SetDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

export const blank = (status: WorkItemStatus, type: WorkItemType): Draft => ({
  type,
  title: '',
  description: '',
  status,
  priority: 'medium',
  assignee: null,
  epicId: null,
  milestoneId: null,
  labels: [],
  relations: [],
  criteria: [],
});
