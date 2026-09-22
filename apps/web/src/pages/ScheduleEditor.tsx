import { CalendarClock, ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
  const navigate = useNavigate();
  const { project } = useProjectScope();
  const schedules = useSchedules();
  const schedule = id ? schedules.data?.find((s) => s.id === id) : undefined;
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
        <Empty icon={CalendarClock} title={t('form.notFound')} />
      </>
    );
  }
  return (
    <>
      {header}
      <div className="schedule-editor">
        {/* Keyed by the schedule, so opening another one starts from its own fields */}
        <ScheduleForm key={schedule?.id ?? 'new'} schedule={schedule} defaultCwd={project?.exists ? project.path : undefined} onClose={back} />
      </div>
    </>
  );
}
