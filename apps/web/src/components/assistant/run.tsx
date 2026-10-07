import type { AssistantFinding, AssistantRun, AssistantSource, ProposedWorkItem } from '@agentry/shared';
import { Check, Circle, Clock, Copy, Sparkle, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOverview } from '../../api';
import { EffortTag } from '../EffortPicker';
import { formatCost, formatDuration, formatNumber, timeAgo } from '@agentry/ui/lib/format';
import { elapsedSince } from '@agentry/ui/lib/live';
import { useClockTick } from '@agentry/ui/lib/motion';
import { ActivityTicker } from '@agentry/ui/components/ActivityTicker';
import { ICON_SM } from '@agentry/ui/components/icons';
import { EpicLabel, PriorityMark, WorkItemTypeIcon } from '../work-item-icons';
import { Spinner } from '@agentry/ui/components/Spinner';

/*
 * The parts every suggestion run draws the same way, whoever started it: the project assistant, "Suggest
 * tasks" on the board and the resources with AI (docs/design-system.md §2, "Assistant, suggestions
 * and resources with AI"). Their classes live in styles/suggestion.css.
 */

/** The assistant's sparkle on a neutral tile; a live run's `.suggestion-run` turns it cyan. */
export function AssistantMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`suggestion-mark ${small ? 'is-sm' : ''}`.trim()} aria-hidden>
      <Sparkle strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/**
 * A run's clock as the references write it, minutes and seconds from the first second: `0:41`,
 * `12:05`, `1:02:05`. The app's other live times read `41s` under a minute; a run's clock ticks
 * beside its verb, where a width that jumps at the minute would shift the line.
 */
export function formatRunClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** A clock that runs while the run does: `0:41`, then its whole duration once it ends. */
export function useElapsed(startedAt: string, running: boolean): string {
  const tick = useClockTick(running ? 1000 : 60_000);
  // The tick is what makes the clock read the time again
  return useMemo(() => formatRunClock(elapsedSince(startedAt)), [startedAt, tick]);
}

/** The model the way the CLI names it ("Sonnet 5"), once the overview has read its list; the alias until then. */
function useModelName(model: string): string {
  const models = useOverview().data?.system.models;
  return models?.find((m) => m.value === model)?.label ?? model;
}

/**
 * Model · time · cost · chat, in mono (`.ai-facts`). The cost is the one fact in `--fg-2`; while the
 * run works it reads "so far", and a run that started no chat says it cost nothing.
 */
export function RunFacts({ run, label, ago = false, showSchema = false }: { run: AssistantRun; label?: string; ago?: boolean; showSchema?: boolean }) {
  const { t } = useTranslation('suggestion');
  const model = useModelName(run.model);
  const running = run.status === 'running';
  const cost = run.chatId === null ? t('facts.noCost') : running ? t('facts.soFar', { cost: formatCost(run.costUsd) }) : formatCost(run.costUsd);
  return (
    <div className="suggestion-facts">
      {label && <span>{label}</span>}
      {run.chatId !== null && <span>{model}</span>}
      {run.chatId !== null && <EffortTag effort={run.effort} />}
      {!running && run.durationMs !== null && run.chatId !== null && <span>{formatDuration(run.durationMs)}</span>}
      <span className="cost">{cost}</span>
      {run.chatId && <Link to={`/chats/${encodeURIComponent(run.chatId)}`}>{t('facts.chat', { id: run.chatId.slice(0, 6) })}</Link>}
      {showSchema && <span>--json-schema</span>}
      {ago && <span>{timeAgo(run.endedAt ?? run.startedAt)}</span>}
    </div>
  );
}

/** What a source's line says at its right: "142 lines", "31 of 48", "does not exist", "after". */
function sourceCount(source: AssistantSource, t: ReturnType<typeof useTranslation<'suggestion'>>['t']): string {
  if (source.state === 'pending') return t('count.pending');
  if (source.state === 'missing') return t('count.missing');
  if (source.count !== null && source.total !== null && (source.state === 'partial' || source.state === 'reading'))
    return t('count.partial', { count: source.count, total: formatNumber(source.total), n: formatNumber(source.count) });
  if (source.kind === 'milestones' && source.names.length > 0) return source.names.join(' · ');
  if (source.count !== null && source.unit !== null) return t(`count.${source.unit}`, { count: source.count, n: formatNumber(source.count) });
  return '';
}

/** What a source is: its path in mono, or the words for what Agentry handed the run. */
function SourceName({ source }: { source: AssistantSource }) {
  const { t } = useTranslation('suggestion');
  if (source.path !== null) {
    const [first, ...rest] = source.names;
    // A group of files read together: "package.json and pnpm-workspace.yaml"
    if ((source.kind === 'file' || source.kind === 'dir') && first !== undefined && rest.length === 1)
      return (
        <>
          <span className="path">{first}</span> {t('source.and')} <span className="path">{rest[0]}</span>
        </>
      );
    return <span className="path">{source.path}</span>;
  }
  return <>{t(`source.${source.kind}`)}</>;
}

/** What the run read (`.ai-steps`): one line per source, the one it is reading now with the braille spinner. */
export function RunSources({ sources, label }: { sources: AssistantSource[]; label?: string }) {
  const { t } = useTranslation('suggestion');
  if (sources.length === 0) return null;
  const list = (
    <ul className="suggestion-steps">
      {sources.map((source, i) => {
        const state = source.state === 'reading' ? 'is-now' : source.state === 'pending' ? 'is-todo' : '';
        return (
          <li key={`${source.kind}:${source.path ?? i}`} className={`suggestion-step ${state}`.trim()}>
            {source.state === 'reading' ? <Spinner /> : source.state === 'pending' ? <Circle {...ICON_SM} /> : <Check {...ICON_SM} />}
            <span className="ellipsis">
              <SourceName source={source} />
              {source.state === 'reading' && <span className="sr-only"> {t('source.reading')}</span>}
            </span>
            <span className="n">{sourceCount(source, t)}</span>
          </li>
        );
      })}
    </ul>
  );
  if (!label) return list;
  return (
    <div className="suggestion-run-part">
      <span className="section-label">{label}</span>
      {list}
    </div>
  );
}

/** What a `project` run found, as neutral mono tags: the stack, and what it lacks ("no CI"). */
export function RunFindings({ findings, label }: { findings: AssistantFinding[]; label?: string }) {
  if (findings.length === 0) return null;
  const tags = (
    <div className="suggestion-found">
      {findings.map((finding) => (
        <span key={`${finding.kind}:${finding.label}`} className="workitem-label">
          {finding.label}
        </span>
      ))}
    </div>
  );
  if (!label) return tags;
  return (
    <div className="suggestion-run-part">
      <span className="section-label">{label}</span>
      {tags}
    </div>
  );
}

/**
 * A live run's head (`.ai-run-head`): the cyan mark, what it is doing ("Reading src/webhooks/stripe.ts")
 * with the braille spinner, how long it has run, and "Stop" when `onStop` is given.
 */
export function LiveRunHead({ run, title, onStop, stopping = false }: { run: AssistantRun; title: string; onStop?: () => void; stopping?: boolean }) {
  const { t } = useTranslation('suggestion');
  const elapsed = useElapsed(run.startedAt, run.status === 'running');
  const activity = run.activity ?? { kind: 'thinking' as const, since: run.startedAt };
  return (
    <div className="suggestion-run-head">
      <AssistantMark />
      <div className="suggestion-run-text">
        <h2 className="suggestion-run-title">{title}</h2>
        <div className="suggestion-run-now">
          <ActivityTicker activity={activity} showElapsed={false} />
        </div>
      </div>
      <span className="suggestion-run-elapsed" aria-label={t('facts.elapsed', { time: elapsed })}>
        {elapsed}
      </span>
      {onStop && (
        <button type="button" className="btn btn-small" disabled={stopping} onClick={onStop}>
          <X {...ICON_SM} />
          {t('stop')}
        </button>
      )}
    </div>
  );
}

/** A section that waits for the reading to end: dashed and still. */
export function SuggestionWait({ children }: { children: ReactNode }) {
  return (
    <div className="suggestion-wait">
      <Clock {...ICON_SM} />
      <span>{children}</span>
    </div>
  );
}

/** A proposed work item's line under its title: type, priority, epic, labels, and what it resembles. */
export function ProposedWorkItemMeta({ item }: { item: ProposedWorkItem }) {
  const { t } = useTranslation(['suggestion', 'tasks']);
  return (
    <div className="suggestion-meta">
      <span className="suggestion-meta-part">
        <WorkItemTypeIcon type={item.type} decorative />
        {t(`tasks:type.${item.type}`)}
      </span>
      <span className="suggestion-meta-part">
        <PriorityMark priority={item.priority} />
        {t(`tasks:priority.${item.priority}`)}
      </span>
      {item.epic && <EpicLabel epic={item.epic} />}
      {item.labels.map((label) => (
        <span key={label} className="workitem-label">
          {label}
        </span>
      ))}
      {item.similarTo && (
        <span className="suggestion-like">
          <Copy {...ICON_SM} />
          {t('similarTo')} <span className="mono">{item.similarTo.key}</span>
        </span>
      )}
    </div>
  );
}
