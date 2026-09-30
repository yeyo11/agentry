import type { EditStep } from '@agentry/shared';
import { ChevronDown, ChevronLeft, ChevronRight, Sparkle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { parseUnified } from '../../../lib/diff';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { Menu, type MenuEntry } from '../../controls';
import { ICON_SM } from '../../icons';
import { Spinner } from '../../Spinner';
import { Empty, ErrorBox, Skeleton } from '../../ui';
import { DiffView } from '../DiffView';
import { Intent } from '../Intent';
import { Counts } from '../FileMap';
import { hourMinute, splitPath, unexplainedOf } from '../review-model';
import { useUnexplainedRows } from '../useUnexplained';
import {
  conversationHref,
  patchSpan,
  plainIntent,
  sameFileWindow,
  scrubDots,
  stepBeside,
  stepKey,
  stepPaths,
  swipeOf,
} from './steps-model';
import './steps.css';

// The Step by step lens (docs/plans/changes-review.md, `steps`; references DesktopCambiosPasos and
// MobilePasos): every edit of the transcript in order, each with the sentence Claude wrote just
// before it and the patch it made then. The list is on the left, one step on the right, and the
// scrubber in the header; a phone shows one step at a time with big Previous and Next buttons.

export interface StepsLensProps {
  steps: EditStep[] | null;
  loading: boolean;
  error: unknown;
  current: EditStep | null;
  /** The same screen on another step */
  hrefOf: (stepId: string) => string;
  /** The chat whose transcript holds the steps, for "See it in the conversation" */
  conversation: string | null;
  /** The file in the Result lens; null where there is no result to see (no worktree) */
  resultHref: ((path: string) => string) | null;
  /** Why this source only has steps (a chat outside git) */
  note: string | null;
  phone: boolean;
  live: boolean;
  /** Where a phone's back button goes */
  back: { to: string; label: string };
}

export function StepsLens(props: StepsLensProps) {
  const { steps, loading, error, current, hrefOf, note, phone } = props;
  const { t } = useTranslation('changes');
  const navigate = useNavigate();
  const list = steps ?? [];
  const prev = stepBeside(list, current, -1);
  const next = stepBeside(list, current, 1);

  // ←/→ walk the steps, wherever the focus is short of a field or a menu
  const moves = useRef({ prev, next });
  moves.current = { prev, next };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const delta = stepKey(e);
      const to = delta === -1 ? moves.current.prev : delta === 1 ? moves.current.next : null;
      if (!to) return;
      e.preventDefault();
      navigate(hrefOf(to.id), { replace: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, hrefOf]);

  if (error) return <div className="changes-pane-state"><ErrorBox error={error} /></div>;
  if (loading) return <div className="changes-pane-state"><Skeleton rows={6} height={16} /></div>;
  if (!current)
    return (
      <div className="changes-pane-state">
        {note && <p className="edit-steps-note">{note}</p>}
        <Empty title={t('empty.noSteps')}>{t('empty.noStepsBody')}</Empty>
      </div>
    );
  if (phone) return <PhoneStep {...props} steps={list} current={current} prev={prev} next={next} />;
  return (
    <div className="edit-steps">
      <StepList steps={list} current={current} hrefOf={hrefOf} note={note} />
      <StepDetail {...props} steps={list} current={current} prev={prev} next={next} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The scrubber: one dot per step, under the header

export function StepScrubber({ steps, currentId, onPick, className = '' }: { steps: EditStep[]; currentId: string | null; onPick: (id: string) => void; className?: string }) {
  const { t } = useTranslation('changes');
  const dots = scrubDots(steps, currentId);
  const at = steps.findIndex((s) => s.id === currentId);
  // Dots are too small to be targets of their own: the list and the arrows are how the keyboard
  // and a screen reader move, and a pointer picks the dot it lands on
  return (
    <div
      className={`edit-scrub ${className}`.trim()}
      role="img"
      aria-label={t('steps.stepOf', { n: at + 1, total: steps.length })}
      style={{ '--n': steps.length } as CSSProperties}
      onClick={(e) => {
        const id = (e.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step;
        if (id) onPick(id);
      }}
    >
      {steps.map((s, i) => (
        <i key={s.id} data-step={s.id} className={`is-${dots[i] ?? 'ahead'}`} title={`${s.index} · ${splitPath(s.path).name}`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces

/** When a step was made: its time, "now" while it waits for its result */
function StepTime({ step }: { step: EditStep }) {
  const { t, i18n } = useTranslation('changes');
  return <span className="edit-step-time">{step.pending ? t('steps.now') : step.at ? hourMinute(step.at, i18n.language) : `#${step.index}`}</span>;
}


function StepPath({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="changes-path edit-step-where" title={path}>
      {dir && <span className="changes-path-dir">{dir}/</span>}
      <span className="changes-path-name">{name}</span>
    </span>
  );
}

function StepList({ steps, current, hrefOf, note }: { steps: EditStep[]; current: EditStep; hrefOf: (id: string) => string; note: string | null }) {
  const { t } = useTranslation('changes');
  const [only, setOnly] = useState<string | null>(null);
  const paths = useMemo(() => stepPaths(steps), [steps]);
  const shown = only ? steps.filter((s) => s.path === only) : steps;
  const scroller = useRef<HTMLElement>(null);

  // The selected step stays in sight as the arrows or the scrubber move it
  useEffect(() => {
    scroller.current?.querySelector('.edit-step.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [current.id]);

  const entries: MenuEntry[] = [
    { id: '*', label: t('steps.allFiles'), checked: only === null, onSelect: () => setOnly(null) },
    { id: 'sep', separator: true },
    ...paths.map((p) => ({
      id: p,
      label: splitPath(p).name,
      shortcut: String(steps.filter((s) => s.path === p).length),
      checked: only === p,
      onSelect: () => setOnly(p),
    })),
  ];

  return (
    <aside className="edit-steps-list" aria-label={t('steps.title')}>
      <div className="edit-steps-head">
        <span className="section-label">{t('steps.title')}</span>
        <span className="count">{steps.length}</span>
        <span className="edit-steps-grow" />
        <Menu
          label={t('steps.filter')}
          entries={entries}
          trigger={
            <button type="button" className="chip edit-steps-filter" aria-label={`${t('steps.filter')}: ${only ?? t('steps.allFiles')}`}>
              <span className="edit-steps-filter-label">{only ? splitPath(only).name : t('steps.allFiles')}</span>
              <ChevronDown {...ICON_SM} />
            </button>
          }
        />
      </div>
      <nav className="edit-steps-scroll" aria-label={t('steps.label')} ref={scroller}>
        {note && <p className="edit-steps-note">{note}</p>}
        {shown.map((s) => {
          const on = s.id === current.id;
          return (
            <Link
              key={s.id}
              to={hrefOf(s.id)}
              replace
              className={`edit-step${on ? ' is-current' : ''}${s.pending ? ' is-live' : ''}`}
              aria-current={on ? 'step' : undefined}
            >
              <span className="edit-step-rail" aria-hidden>
                <span className="edit-step-dot" />
              </span>
              <span className="edit-step-body">
                <span className="edit-step-head">
                  <StepTime step={s} />
                  <span className="badge edit-step-tool">{s.tool}</span>
                  <span className="edit-step-path" title={s.path}>
                    {splitPath(s.path).name}
                  </span>
                  {s.pending && (
                    <>
                      <Spinner />
                      <span className="sr-only">{t('steps.pending')}</span>
                    </>
                  )}
                  <Counts additions={s.additions} deletions={s.deletions} />
                </span>
                {s.intent && <span className="edit-step-intent">{plainIntent(s.intent)}</span>}
              </span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

type DetailProps = StepsLensProps & { steps: EditStep[]; current: EditStep; prev: EditStep | null; next: EditStep | null };

function StepDetail({ steps, current, prev, next, hrefOf, conversation, resultHref }: DetailProps) {
  const { t } = useTranslation('changes');
  const stepOf = t('steps.stepOf', { n: current.index, total: steps.length });
  return (
    <section className="edit-step-detail" aria-label={stepOf} data-scroll-root>
      <div className="changes-file-head edit-step-bar">
        <span className="section-label">{stepOf}</span>
        {current.at && (
          <span className="edit-step-when" title={formatDateTime(current.at)}>
            <StepTime step={current} /> · {timeAgo(current.at)}
          </span>
        )}
        <span className="badge">{current.tool}</span>
        <StepPath path={current.path} />
        <Counts additions={current.additions} deletions={current.deletions} />
        <span className="changes-sep" aria-hidden />
        <StepMove to={prev} dir={-1} hrefOf={hrefOf} />
        <StepMove to={next} dir={1} hrefOf={hrefOf} />
      </div>
      <Why step={current} conversation={conversation} />
      <div className="edit-step-main">
        <Patch step={current} wrap={false} conversation={conversation} />
        <SameFile steps={steps} current={current} hrefOf={hrefOf} resultHref={resultHref} />
      </div>
    </section>
  );
}

function StepMove({ to, dir, hrefOf, big = false }: { to: EditStep | null; dir: -1 | 1; hrefOf: (id: string) => string; big?: boolean }) {
  const { t } = useTranslation('changes');
  const label = dir < 0 ? t('steps.prev') : t('steps.next');
  const cls = `btn ${big ? '' : 'btn-small'} edit-step-move ${dir < 0 ? 'is-prev' : 'is-next'}`.replace(/\s+/g, ' ');
  const inner = (
    <>
      {dir < 0 && <ChevronLeft {...ICON_SM} />}
      {label}
      {dir > 0 && <ChevronRight {...ICON_SM} />}
    </>
  );
  if (!to)
    return (
      <button type="button" className={cls} disabled>
        {inner}
      </button>
    );
  return (
    <Link to={hrefOf(to.id)} replace className={cls} aria-label={`${label}: ${t('steps.stepN', { n: to.index })} · ${splitPath(to.path).name}`}>
      {inner}
    </Link>
  );
}

/** The sentence Claude wrote before the edit, as the step's heading, and the way to its place */
function Why({ step, conversation, compact = false }: { step: EditStep; conversation: string | null; compact?: boolean }) {
  const { t } = useTranslation('changes');
  const href = conversation ? conversationHref(conversation, step) : null;
  return (
    <div className="edit-step-why">
      <h2 className="edit-step-heading">
        <Sparkle size={compact ? 16 : 18} strokeWidth={1.75} fill="currentColor" aria-hidden className="edit-step-spark" />
        <span>{step.intent ? <Intent text={step.intent} /> : <span className="edit-step-silent">{t('steps.noIntent')}</span>}</span>
      </h2>
      {(!compact || href) && (
        <span className="edit-step-source">
          {step.intent && !compact && <span>{t('steps.intentLabel')}</span>}
          {step.intent && !compact && href && <span aria-hidden>·</span>}
          {href && <Link to={href}>{t('steps.seeInChat')}</Link>}
        </span>
      )}
    </div>
  );
}

/** The step's own patch, in Unified, as the file was at that moment */
function Patch({ step, wrap, conversation }: { step: EditStep; wrap: boolean; conversation: string | null }) {
  const { t } = useTranslation('changes');
  const rows = useUnexplainedRows(conversation);
  const unexplained = useMemo(() => unexplainedOf(rows, step), [rows, step]);
  const diff = useMemo(() => (step.diff ? parseUnified(step.diff) : null), [step.diff]);
  const span = diff ? patchSpan(diff) : null;
  if (!diff || diff.hunks.length === 0)
    return <p className="edit-steps-note edit-step-nopatch">{step.pending ? t('steps.pendingPatch') : t('steps.noPatch')}</p>;
  return (
    <div className="card edit-step-patch">
      {!wrap && (
        <div className="edit-step-patch-head">
          {span && <span className="edit-step-lines">{t('steps.lines', { from: span.from, to: span.to })}</span>}
          <span className="edit-steps-grow" />
          <span>{t('steps.asThen')}</span>
        </div>
      )}
      <DiffView key={step.id} diff={diff} mode="unified" path={step.path} wrap={wrap} trimEdges unexplained={unexplained} className="edit-step-diff" />
    </div>
  );
}

/** The other steps on the same file, as cards around this one */
function SameFile({ steps, current, hrefOf, resultHref }: { steps: EditStep[]; current: EditStep; hrefOf: (id: string) => string; resultHref: ((path: string) => string) | null }) {
  const { t, i18n } = useTranslation('changes');
  const around = sameFileWindow(steps, current);
  if (around.total < 2 && !resultHref) return null;
  return (
    <section className="edit-step-file" aria-label={t('steps.sameFile')}>
      <div className="edit-step-file-head">
        <span className="section-label">{t('steps.sameFile')}</span>
        <span className="count">{around.total}</span>
        <span className="edit-steps-grow" />
        {resultHref && <Link to={resultHref(current.path)}>{t('steps.seeResult')}</Link>}
      </div>
      {around.total > 1 && (
        <div className="edit-step-cards">
          {around.steps.map((s) => {
            const on = s.id === current.id;
            const body = (
              <>
                <span className="edit-step-card-head">
                  <span className="edit-step-card-n">
                    {t('steps.stepN', { n: s.index })}
                    {s.at || s.pending ? ` · ${s.pending ? t('steps.now') : hourMinute(s.at, i18n.language)}` : ''}
                  </span>
                  {on && <span className="badge edit-step-this">{t('steps.thisOne')}</span>}
                  <span className="edit-steps-grow" />
                  <Counts additions={s.additions} deletions={s.deletions} />
                </span>
                <span className="edit-step-card-intent">{s.intent ? plainIntent(s.intent) : t('steps.noIntent')}</span>
              </>
            );
            return on ? (
              <div key={s.id} className="card grad-border edit-step-card is-current" aria-current="step">
                {body}
              </div>
            ) : (
              <Link key={s.id} to={hrefOf(s.id)} replace className="card edit-step-card">
                {body}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone: one step at a time

function PhoneStep({ steps, current, prev, next, hrefOf, conversation, live, back, note }: DetailProps) {
  const { t } = useTranslation('changes');
  const navigate = useNavigate();
  const start = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    start.current = e.touches.length === 1 && p ? { x: p.clientX, y: p.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const from = start.current;
    const p = e.changedTouches[0];
    start.current = null;
    if (!from || !p) return;
    const move = swipeOf(p.clientX - from.x, p.clientY - from.y);
    const to = move === 1 ? next : move === -1 ? prev : null;
    if (to) navigate(hrefOf(to.id), { replace: true });
  };
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [current.id]);

  return (
    <section className="edit-steps-phone" aria-label={t('lens.steps')}>
      <header className="changes-phone-head">
        <Link to={back.to} className="icon-btn" aria-label={back.label}>
          <ChevronLeft size={20} strokeWidth={1.75} aria-hidden />
        </Link>
        <div className="changes-head-text">
          <h1 className="edit-steps-phone-title">{t('lens.steps')}</h1>
          <span className="changes-phone-sub">{t('steps.countShort', { count: steps.length })}</span>
        </div>
        {live && (
          <span className="changes-live">
            <Spinner />
            {t('steps.live')}
          </span>
        )}
      </header>
      <StepScrubber steps={steps} currentId={current.id} onPick={(id) => navigate(hrefOf(id), { replace: true })} className="edit-scrub-phone" />
      <div className="edit-steps-phone-body" ref={body} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} data-scroll-root>
        {note && <p className="edit-steps-note">{note}</p>}
        <div className="edit-steps-phone-meta">
          <span className="section-label">{t('steps.stepOf', { n: current.index, total: steps.length })}</span>
          <StepTime step={current} />
          <span className="badge">{current.tool}</span>
          <span className="edit-steps-grow" />
          <Counts additions={current.additions} deletions={current.deletions} />
        </div>
        <StepPath path={current.path} />
        <Why step={current} conversation={conversation} compact />
        <Patch step={current} wrap conversation={conversation} />
      </div>
      <nav className="changes-phone-bar edit-steps-phone-bar" aria-label={t('steps.label')}>
        <StepMove to={prev} dir={-1} hrefOf={hrefOf} big />
        <StepMove to={next} dir={1} hrefOf={hrefOf} big />
      </nav>
    </section>
  );
}
