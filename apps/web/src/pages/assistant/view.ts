import type { AssistantRun, AssistantRunDetail, Project, ProjectModule } from '@agentry/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { useToast } from '../../components/Toast';

export type Section = 'tasks' | 'team' | 'resources';

/** Starting a run from this page, and stopping one; every screen of it reads the runs again after. */
export function useRunActions(projectId: string) {
  const { t } = useTranslation('assistant');
  const toast = useToast();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.assistantRunsOf(projectId) });
  const start = useMutation({
    mutationFn: (req: { kind: 'project' | 'work-items'; description?: string; supersede?: boolean }) => api.startAssistantRun(projectId, req),
    onSuccess: (run) => queryClient.setQueryData(keys.assistantRun(run.id), run),
    onSettled: refresh,
    onError: (error) => toast.error(t('startFailed'), error),
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.stopAssistantRun(runId),
    onSuccess: (run) => queryClient.setQueryData(keys.assistantRun(run.id), run),
    onSettled: refresh,
    onError: (error) => toast.error(t('live.stopFailed'), error),
  });
  return { start, stop };
}

export type RunActions = ReturnType<typeof useRunActions>;

export interface ViewProps {
  project: Project;
  run: AssistantRunDetail | null;
  /** For an empty project: the run proposing its first tasks from the description */
  tasksRun: AssistantRunDetail | null;
  following: AssistantRun | null;
  actions: RunActions;
  phone: boolean;
}

const has = (project: Project, module: ProjectModule) => project.modules.includes(module);

/** Which of the three sections this project shows: a module switched off has none. */
export function sectionsOf(project: Project): Section[] {
  return [...(has(project, 'board') ? (['tasks'] as const) : []), ...(has(project, 'team') ? (['team'] as const) : []), 'resources'];
}
