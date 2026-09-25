import type { ChatOrchestration } from '@agentry/shared';
import { Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOrchestration } from '../../api';
import { ICON_SM } from '../../components/icons';
import { ProgressBar } from '../../components/ProgressBar';
import { orchestrationProgress, taskStage } from '../../lib/orchestration-steps';

/**
 * The way back from a worker's chat to the graph it works for: the orchestration's name, the stage
 * its task is in, and how far the whole graph has got. The chat already names its orchestration;
 * the stages and the progress come from the orchestration itself, read under the key its own page
 * uses, so the two pages share one request and one cache entry.
 */
export function PartOf({ link }: { link: ChatOrchestration }) {
  const { t } = useTranslation(['chat', 'orchestration']);
  const { data: orch } = useOrchestration(link.id);
  const stage = orch && link.taskId !== null ? taskStage(orch.tasks, link.taskId) : null;
  const where = link.taskId === null ? t('view.synthesis') : stage ? t('view.partOf.stage', { n: stage.at, total: stage.of }) : null;
  return (
    <div className="chat-part-of">
      <Workflow {...ICON_SM} className="chat-part-of-icon" aria-hidden />
      <span className="chat-part-of-text">
        <span className="muted">{t('view.partOf.label')}</span>{' '}
        <Link to={`/orchestration/${link.id}`} className="chat-part-of-name">
          {link.name}
        </Link>
        {where && <span className="chat-part-of-where mono"> · {where}</span>}
      </span>
      {orch && orch.tasks.length > 0 && (
        <ProgressBar variant="segments" counts={orchestrationProgress(orch.tasks)} unit={t('orchestration:board.tasksUnit')} className="chat-part-of-progress" />
      )}
    </div>
  );
}
