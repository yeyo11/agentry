import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useSchedules } from '../api';
import { ICON_SM } from '../components/icons';
import { Empty, ErrorBox, PageHeader, Skeleton } from '../components/ui';
import { useProjectScope } from '../lib/project-scope';
import { ScheduleForm } from './schedules/ScheduleForm';
import '../insights.css';

/**
 * A schedule is created and edited on a page of its own, like a chat or an orchestration: the form
 * is long (timetable, target, tasks) and a dialog over the list left it cramped on a phone.
 */
export function ScheduleEditor() {
  const { t } = useTranslation('schedules');
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { project } = useProjectScope();
  const schedules = useSchedules();
  const schedule = id ? schedules.data?.find((s) => s.id === id) : undefined;
  // The empty page's templates open the editor with a timetable already chosen; only a new one reads it
  const presetCron = id ? undefined : (params.get('cron') ?? undefined);
  const back = () => navigate('/schedules');

  const header = (
    <PageHeader
      title={id ? t('form.editTitle') : t('form.newTitle')}
      subtitle={schedule?.name}
      actions={
        <Link to="/schedules" className="btn">
          <ChevronLeft {...ICON_SM} /> {t('form.back')}
        </Link>
      }
    />
  );

  if (id && schedules.isPending) {
    return (
      <>
        {header}
        <Skeleton rows={4} height={48} />
      </>
    );
  }
  if (id && !schedule) {
    return (
      <>
        {header}
        <ErrorBox error={schedules.error} />
        <div className="card">
          <Empty
            illustration="not-found"
            title={t('form.notFound')}
            action={
              <Link to="/schedules" className="btn">
                {t('form.back')}
              </Link>
            }
          >
            {t('form.notFoundBody')}
          </Empty>
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <div className="schedule-editor">
        {/* Keyed by the schedule, so opening another one starts from its own fields */}
        <ScheduleForm
          key={schedule?.id ?? `new:${presetCron ?? ''}`}
          schedule={schedule}
          initialCron={presetCron}
          defaultCwd={project?.exists ? project.path : undefined}
          onClose={back}
        />
      </div>
    </>
  );
}
