import type { Orchestration, OrchestrationPhaseName, OrchestrationTimings, TaskWait } from '@agentry/shared';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrchestrationTimings } from '../api';
import { formatDuration } from '@agentry/ui/lib/format';
import { phaseCells, phaseTone, timingsPhaseKey, WAIT_TONE } from '../lib/orchestration-timings';
import { Collapsible } from '@agentry/ui/components/controls';
import { ProgressBar } from '@agentry/ui/components/ProgressBar';
import { Tag } from '@agentry/ui/components/ui';

/**
 * On a link of the critical path, a gap shorter than this is scheduling, not a wait worth a word:
 * the route keeps every second of it, and the totals under "Waits" still count it.
 */
const LINK_WAIT_MIN_MS = 60_000;

/** A duration in mono, tabular figures, as every number of the panel is. */
function Duration({ ms }: { ms: number }) {
  return <span className="mono tnum">{formatDuration(ms)}</span>;
}

/** A wait, in its status colour and always with its word. */
function WaitTag({ wait }: { wait: Pick<TaskWait, 'kind' | 'durationMs'> }) {
  const { t } = useTranslation('orchestrationV2');
  return (
    <Tag tone={WAIT_TONE[wait.kind]}>
      {t(`timings.wait.${wait.kind}`)} · <span className="mono tnum">{formatDuration(wait.durationMs)}</span>
    </Tag>
  );
}

/**
 * The figures themselves, from the timings route. History, not a live surface: no gradient, no
 * energy border and no motion, and status colours only on waits and failed runs.
 */
export function TimingsBody({ timings, running }: { timings: OrchestrationTimings; running: boolean }) {
  const { t } = useTranslation('orchestrationV2');
  const phaseName = (phase: OrchestrationPhaseName): string => t(`timings.phase.${phase}`);
  const parts = timings.phases.map((p) => `${phaseName(p.phase)} ${formatDuration(p.durationMs)}`).join(', ');
  const waitTotals = (['limit', 'slot', 'retry'] as const)
    .map((kind) => ({ kind, durationMs: timings.waits[`${kind}Ms`] }))
    .filter((w) => w.durationMs > 0);
  const v = timings.verification;

  return (
    <div className="orch-timings-body">
      {running && <p className="small muted">{t('timings.running')}</p>}
      <dl className="orch-timings-figures">
        <div>
          <dt className="section-label">{t('timings.total')}</dt>
          <dd>
            <Duration ms={timings.wallMs} />
          </dd>
        </div>
        <div>
          <dt className="section-label">{t('timings.afterTasks')}</dt>
          <dd>
            <Duration ms={timings.afterTasksMs} />
          </dd>
        </div>
        {timings.parallelism !== null && (
          <div>
            <dt className="section-label">{t('timings.parallelism')}</dt>
            <dd className="mono tnum">{timings.parallelism.toFixed(1)}</dd>
          </div>
        )}
      </dl>

      {timings.phases.length > 0 && (
        <div className="orch-timings-phases">
          <h3 className="section-label">{t('timings.phases')}</h3>
          <ProgressBar variant="segments" cells={phaseCells(timings.phases)} label={t('timings.phasesLabel', { parts })} className="orch-timings-bar" />
          <ul className="orch-timings-legend">
            {timings.phases.map((p, i) => (
              <li key={p.phase}>
                <span className={`orch-timings-swatch progress-segbar-cell is-${phaseTone(i)}`} aria-hidden />
                <span className="grow">{phaseName(p.phase)}</span>
                <Duration ms={p.durationMs} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {timings.criticalPath.links.length > 0 && (
        <div className="orch-timings-path">
          <h3 className="section-label">{t('timings.criticalPath')}</h3>
          <p className="small muted">{t('timings.criticalPathLength', { duration: formatDuration(timings.criticalPath.durationMs) })}</p>
          <ol className="orch-timings-links">
            {timings.criticalPath.links.map((link) => (
              <li key={link.taskId} className="orch-timings-link">
                <span className="orch-timings-link-name">{link.taskName}</span>
                <span className="small muted mono tnum">{t('timings.work', { duration: formatDuration(link.workMs) })}</span>
                {link.waitBeforeMs >= LINK_WAIT_MIN_MS && <span className="small muted mono tnum">{t('timings.waitBefore', { duration: formatDuration(link.waitBeforeMs) })}</span>}
                {link.waits.filter((wait) => wait.durationMs >= LINK_WAIT_MIN_MS).map((wait) => (
                  <WaitTag key={`${wait.kind}-${wait.startedAt}`} wait={wait} />
                ))}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="orch-timings-waits">
        <h3 className="section-label">{t('timings.waits')}</h3>
        {waitTotals.length ? (
          <div className="orch-timings-tags">
            {waitTotals.map((wait) => (
              <WaitTag key={wait.kind} wait={wait} />
            ))}
          </div>
        ) : (
          <p className="small muted">{t('timings.noWaits')}</p>
        )}
      </div>

      {v && (
        <div className="orch-timings-checks">
          <h3 className="section-label">{t('timings.checks')}</h3>
          <p className="small muted mono tnum">
            {t('timings.checksTotal', { duration: formatDuration(v.checksMs) })}
            {v.fixes.length > 0 && ` · ${t('timings.fixer', { duration: formatDuration(v.fixerMs), count: v.fixes.length })}`}
          </p>
          <ul className="orch-timings-commands">
            {v.commands.map((command) => (
              <li key={command.command} className="orch-timings-command">
                <code className="mono break">{command.command}</code>
                {command.runs.length ? (
                  <span className="orch-timings-runs">
                    {command.runs.map((run) => (
                      <span key={`${run.pass}-${run.startedAt}`} className={`orch-timings-run${run.status === 'failed' ? ' is-failed' : ''}`}>
                        <span className="mono tnum">{t('timings.pass', { n: run.pass })}</span>
                        <Duration ms={run.durationMs} />
                        {run.status === 'failed' && <Tag tone="bad">{t('timings.failed')}</Tag>}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="small muted">{t('timings.noRuns')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {timings.missing.length > 0 && <p className="small muted">{t('timings.missing')}</p>}
    </div>
  );
}

/**
 * "Where the time went": the graph's phases, its critical path with the waits on it, and every run
 * of its checks. Closed while the graph runs, open once it has ended; read again when the graph
 * moves to another phase.
 */
export function TimingsPanel({ orch }: { orch: Orchestration }) {
  const { t } = useTranslation('orchestrationV2');
  const titleId = useId();
  const running = orch.status === 'running' || orch.status === 'waiting';
  const { data, error } = useOrchestrationTimings(orch.id, timingsPhaseKey(orch));
  return (
    <section className="card orch-timings" aria-labelledby={titleId}>
      <Collapsible className="fold" defaultOpen={!running} triggerClassName="orch-timings-trigger" title={<span id={titleId} className="section-label">{t('timings.title')}</span>}>
        {data ? <TimingsBody timings={data} running={running} /> : error ? <p className="small muted">{t('timings.error')}</p> : null}
      </Collapsible>
    </section>
  );
}
