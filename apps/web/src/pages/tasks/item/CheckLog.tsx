import type { Check, CheckAnnotation } from '@agentry/shared';
import { useQuery } from '@tanstack/react-query';
import { Ban, Check as CheckIcon, CircleAlert, Clock, ExternalLink, Minus, Play, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError, api, keys } from '../../../api';
import { ICON_SM } from '@agentry/ui/components/icons';
import { Spinner } from '@agentry/ui/components/Spinner';
import { clockOf, checkDurationMs, checkMark } from '../../../lib/change-requests';
import { errorMessage } from '@agentry/ui/lib/format';

/** The lines the runners write for an error: the tail's own windows are cut around the same ones. */
const ERROR_LINE = /##\[error\]|\bERROR:|\bexit code [1-9]\d*/;

const MARK_ICON: Record<Check['state'], LucideIcon> = {
  failed: X,
  running: Clock,
  queued: Clock,
  passed: CheckIcon,
  neutral: Minus,
  skipped: Minus,
  cancelled: Ban,
  manual: Play,
};

/** The row's status mark: the ring only on a running check, an icon in the status colour on the rest. */
export function CheckMarkIcon({ check }: { check: Check }) {
  const { tone } = checkMark(check);
  if (tone === 'live') return <span className="check-mark" aria-hidden><Spinner variant="ring" /></span>;
  const Icon = tone === 'warn' && check.state === 'failed' ? TriangleAlert : MARK_ICON[check.state];
  return (
    <span className={`check-mark ${tone}`} aria-hidden>
      <Icon {...ICON_SM} />
    </span>
  );
}

/** The `badge` class of a mark's tone: live is the "active" badge, and a plain `badge-idle` rests. */
export const markBadge = (tone: ReturnType<typeof checkMark>['tone']): string => `badge badge-${tone === 'live' ? 'active' : tone}`;

const LEVEL_TONE = { failure: 'bad', warning: 'warn', notice: 'idle' } as const;

function Annotation({ note }: { note: CheckAnnotation }) {
  const { t } = useTranslation('checks');
  const where = note.path ? `${note.path}${note.startLine ? `:${note.startLine}` : ''}` : note.title;
  return (
    <div className="check-note">
      <span className={`badge badge-${LEVEL_TONE[note.level]}`}>{t(`log.level.${note.level}`)}</span>
      <span className="check-note-text">
        {where && <span className="where">{where}</span>}
        <span>{note.message}</span>
      </span>
    </div>
  );
}

/**
 * The tail of one check's log, with what the check says about the run above it. The tail is mono
 * and dimmed: no syntax colour and no green or red, only the lines the runner marks as errors are
 * brighter, on a neutral fill. A log the host no longer has, and one that has printed nothing yet,
 * are told apart: the first is a warning, the second is only waiting.
 */
export function CheckLogBody({ changeRequestId, check }: { changeRequestId: string; check: Check }) {
  const { t } = useTranslation('checks');
  const running = check.state === 'running';
  const log = useQuery({
    queryKey: keys.checkLog(changeRequestId, check.id, check.state),
    queryFn: ({ signal }) => api.checkLog(changeRequestId, check.id, { signal }),
    // A running job's trace lags behind it by up to a minute, so the tail is read again while it runs
    refetchInterval: running ? 15_000 : false,
    retry: false,
  });

  if (log.isPending) {
    return (
      <div className="check-quiet" role="status">
        <span className="spinner" aria-hidden />
        <span>{t('log.loading')}</span>
      </div>
    );
  }
  if (log.error) {
    const unavailable = log.error instanceof ApiRequestError && log.error.code === 'log-unavailable';
    return (
      <div className="check-quiet warn" role="note" data-reason={unavailable ? 'log-unavailable' : 'failed'}>
        <CircleAlert {...ICON_SM} />
        <div className="check-quiet-text">
          <span>{unavailable ? t('log.unavailable') : t('log.failed')}</span>
          <span className="detail">{log.error instanceof ApiRequestError && log.error.detail ? log.error.detail : errorMessage(log.error)}</span>
        </div>
      </div>
    );
  }

  const { lines, truncated, noOutputYet, annotations } = log.data;
  return (
    <>
      {annotations.length > 0 && (
        <div className="check-notes">
          <span className="check-label">{t('log.annotations')}</span>
          {annotations.map((note, i) => (
            <Annotation key={`${note.path ?? ''}:${note.startLine ?? i}:${i}`} note={note} />
          ))}
        </div>
      )}
      {noOutputYet || lines.length === 0 ? (
        <div className="check-quiet" role="note">
          <span>{t(noOutputYet ? 'log.noOutputYet' : 'log.empty')}</span>
        </div>
      ) : (
        <>
          <span className="check-label">{t('log.tail')}</span>
          <div className="check-tail" role="log" aria-label={t('log.tail')}>
            {lines.map((line, i) =>
              // The tail marks every place it left lines out with a lone ellipsis
              line === '…' ? (
                <div key={i} className="check-gap">
                  {t('log.gap')}
                </div>
              ) : (
                <div key={i} className={`check-line ${ERROR_LINE.test(line) ? 'hit' : ''}`.trim()}>
                  <span>{line}</span>
                </div>
              ),
            )}
          </div>
          <div className="check-log-foot">
            <span>{truncated ? t('log.footTruncated') : t('log.foot')}</span>
          </div>
        </>
      )}
    </>
  );
}

/** What the log's header says about the check: its id on the host, its stage and how long it ran. */
export function checkFacts(check: Check, now: number): string {
  const ms = checkDurationMs(check, now);
  return [check.id, check.group, ms === null ? null : clockOf(ms)].filter((part): part is string => !!part).join(' · ');
}

/** The desktop's log panel under the list: the check, its word, where it is on the host, and the tail. */
export function CheckLogPanel({
  changeRequestId,
  check,
  hostLabel,
  now,
  onClose,
}: {
  changeRequestId: string;
  check: Check;
  hostLabel: string;
  now: number;
  onClose: () => void;
}) {
  const { t } = useTranslation('checks');
  const mark = checkMark(check);
  return (
    <div className="check-log" id="check-log" role="region" aria-label={t('log.of', { name: check.name })}>
      <div className="check-log-head">
        <CheckMarkIcon check={check} />
        <b>{check.name}</b>
        <span className={markBadge(mark.tone)}>{t(mark.label)}</span>
        <span className="check-log-meta">{checkFacts(check, now)}</span>
        <span className="grow" />
        {check.url && (
          <a className="btn btn-small btn-ghost" href={check.url} target="_blank" rel="noreferrer">
            <ExternalLink {...ICON_SM} />
            {t('openOn', { host: hostLabel })}
          </a>
        )}
        <button type="button" className="icon-btn" aria-label={t('log.close')} onClick={onClose}>
          <X {...ICON_SM} />
        </button>
      </div>
      <CheckLogBody changeRequestId={changeRequestId} check={check} />
    </div>
  );
}
