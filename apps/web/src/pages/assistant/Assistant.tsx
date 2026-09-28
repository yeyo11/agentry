import type { AssistantRunDetail, Project } from '@agentry/shared';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAssistantRun, useAssistantRuns, useProjects } from '../../api';
import { Empty, ErrorBox, Skeleton, usePageTitle } from '../../components/ui';
import { NARROW, useMediaQuery } from '../../lib/media';
import { useProjectScope } from '../../lib/project-scope';
import { DesktopAssistant } from './Desktop';
import { followingRun, latestRun } from './model';
import { PhoneAssistant } from './Phone';
import { useRunActions } from './view';

/** `/projects/:id/assistant`: the project assistant of one project. */
export function AssistantPage() {
  const { t } = useTranslation('assistant');
  const { id = '' } = useParams();
  const projects = useProjects(false);
  const project = projects.data?.find((p) => p.id === id);
  usePageTitle(project ? `${t('title')} · ${project.name}` : t('title'));
  if (projects.error && !projects.data) return <ErrorBox error={projects.error} />;
  if (!projects.data) return <Skeleton rows={6} height={20} />;
  if (!project)
    return (
      <Empty illustration="not-found" size="md" title={t('title')} action={<Link to="/projects" className="btn">{t('back')}</Link>}>
        {id}
      </Empty>
    );
  return <ProjectAssistant key={project.id} project={project} />;
}

function ProjectAssistant({ project }: { project: Project }) {
  const phone = useMediaQuery(NARROW);
  const runs = useAssistantRuns(project.id, 'project');
  const run = latestRun(runs.data);
  const detail = useAssistantRun(run?.id ?? null);
  // An empty project's first tasks come from the run its description started, after the first
  const tasksRuns = useAssistantRuns(run?.empty ? project.id : null, 'work-items');
  const following = followingRun(run, tasksRuns.data);
  const followingDetail = useAssistantRun(following?.id ?? null);
  const actions = useRunActions(project.id);
  // The page is about one project, so the top bar's selector names it, as a project page's
  // `?project=` does. Once, on arrival: choosing another project afterwards is the person's choice
  const { select } = useProjectScope();
  useEffect(() => select(project.id), [project.id]);

  if (runs.error && !runs.data) return <ErrorBox error={runs.error} />;
  if (!runs.data || (run && !detail.data)) return <Skeleton rows={6} height={20} />;
  // The detail may still be the last run's for a moment after a new one started
  const shown: AssistantRunDetail | null = detail.data && detail.data.id === run?.id ? detail.data : null;
  const view = { project, run: shown, tasksRun: followingDetail.data ?? null, following, actions, phone };
  return phone ? <PhoneAssistant {...view} /> : <DesktopAssistant {...view} />;
}
