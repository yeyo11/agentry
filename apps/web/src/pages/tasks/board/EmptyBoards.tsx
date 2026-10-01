import type { Project } from '@agentry/shared';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ICON_SM } from '@agentry/ui/components/icons';
import { FabStandIn } from '../../../components/shell/Fab';
import { Card, Empty } from '@agentry/ui/components/ui';
import { firstKey } from '../../../lib/work-items';

/** What Tasks shows instead of a board: the module off, no project with one, an empty board, a filter that finds nothing. */

/** A desktop frames the state in a card under the page's glow; a phone draws it as the page itself. */
const frame = (phone: boolean) => (phone ? 'workitem-empty is-phone' : 'card glow-top workitem-empty');

export function BoardOff({ project, phone }: { project: Project; phone: boolean }) {
  const { t } = useTranslation('tasks');
  return (
    <section className={frame(phone)}>
      {/* Nothing can be started on a board that is off: no New task button floats over it */}
      <FabStandIn />
      <Empty
        illustration="board"
        illustrationText={firstKey(project)}
        size={phone ? 'md' : 'lg'}
        title={t('empty.offTitle')}
        action={
          <Link to="/projects" className="btn">
            {t('empty.offAction')}
          </Link>
        }
      >
        {t('empty.offBody', { project: project.name })}
      </Empty>
    </section>
  );
}

export function NoBoards({ phone }: { phone: boolean }) {
  const { t } = useTranslation('tasks');
  return (
    <section className={frame(phone)}>
      <FabStandIn />
      <Empty
        illustration="board"
        size={phone ? 'md' : 'lg'}
        title={t('empty.noneTitle')}
        action={
          <Link to="/projects" className="btn btn-primary">
            {t('empty.noneAction')}
          </Link>
        }
      >
        {t('empty.noneBody')}
      </Empty>
    </section>
  );
}

export function EmptyBoard({ project, phone, onNew }: { project: Project | null; phone: boolean; onNew: () => void }) {
  const { t } = useTranslation('tasks');
  return (
    <section className={frame(phone)}>
      {/* Its own primary is New task: the same action twice, one floating over the other, is noise */}
      <FabStandIn />
      <Empty
        illustration="board"
        illustrationText={firstKey(project)}
        size={phone ? 'md' : 'lg'}
        title={t('empty.title')}
        action={
          <button type="button" className="btn btn-primary workitem-empty-new" onClick={onNew}>
            <Plus {...ICON_SM} />
            {t('empty.action')}
          </button>
        }
      >
        {t(phone ? 'empty.bodyShort' : 'empty.body', { project: project?.name ?? '' })}
      </Empty>
      {!phone && (
        <p className="workitem-empty-hint">
          <kbd className="palette-kbd">N</kbd> {t('empty.hint')}
        </p>
      )}
    </section>
  );
}

export function NothingFiltered({ phone, onReset }: { phone: boolean; onReset: () => void }) {
  const { t } = useTranslation('tasks');
  return (
    <Card>
      <Empty
        illustration="no-results"
        size={phone ? 'sm' : 'md'}
        title={t('empty.filteredTitle')}
        action={
          <button type="button" className="btn" onClick={onReset}>
            {t('toolbar.reset')}
          </button>
        }
      >
        {t('empty.filteredBody')}
      </Empty>
    </Card>
  );
}
