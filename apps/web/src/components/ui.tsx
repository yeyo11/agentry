import { Check, CircleAlert, Copy, Inbox, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { errorMessage } from '../lib/format';
import { Tooltip } from './controls/Tooltip';
import { ICON, ICON_SM } from './icons';
import { AnimatePresence, motion, SlidingIndicator, StatusDot, useIndicatorId, type DotTone } from './motion';

const TONES = {
  starting: 'info',
  busy: 'active',
  running: 'active',
  idle: 'idle',
  pending: 'muted',
  completed: 'ok',
  success: 'ok',
  failed: 'bad',
  error: 'bad',
  killed: 'bad',
  stopped: 'warn',
  skipped: 'muted',
  waiting: 'idle',
  merging: 'active',
  resolving: 'active',
  merged: 'ok',
  conflicted: 'warn',
  unknown: 'muted',
} satisfies Record<string, string>;

/** The statuses Agentry names; each has its text under `common:status`. */
type Status = keyof typeof TONES;

const isStatus = (value: string): value is Status => Object.hasOwn(TONES, value);

/** A status in the active language; one Agentry does not know is shown as it came. */
export function statusText(status: string): string {
  const key = status.toLowerCase();
  return isStatus(key) ? i18n.t(`common:status.${key}`) : status;
}

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  // Subscribes the badge to language changes; statusText reads the active language
  useTranslation();
  const key = status.toLowerCase();
  const tone = isStatus(key) ? TONES[key] : 'muted';
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {key === 'starting' ? (
        <span className="spinner spinner-xs" aria-hidden />
      ) : (
        <StatusDot tone={tone as DotTone} live={tone === 'active'} />
      )}
      {statusText(status)}
    </span>
  );
}

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation(['components', 'common']);
  return (
    <div className="state">
      <span className="spinner" /> {label ?? t('common:loading')}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
  icon: Icon = Inbox,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="state state-empty">
      <span className="state-icon" aria-hidden>
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** Placeholder rows shown while the first response is on its way (no layout jump afterwards). */
export function Skeleton({ rows = 3, height = 14 }: { rows?: number; height?: number }) {
  const { t } = useTranslation(['components', 'common']);
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label={t('ui.loadingShort')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    if (title) document.title = `${title} · Agentry`;
  }, [title]);
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation(['components', 'common']);
  const [copied, setCopied] = useState(false);
  const name = label ?? t('ui.copy');
  return (
    <Tooltip content={copied ? t('ui.copied') : name}>
      <button
        type="button"
        className="icon-btn"
        aria-label={name}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? 'done' : 'copy'}
            className={`icon-swap ${copied ? 'text-ok' : ''}`}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            {copied ? <Check {...ICON_SM} /> : <Copy {...ICON_SM} />}
          </motion.span>
        </AnimatePresence>
      </button>
    </Tooltip>
  );
}

/** A path in monospace with a copy button; long paths are truncated with the full value as tooltip. */
export function PathLabel({ path }: { path: string }) {
  const { t } = useTranslation(['components', 'common']);
  return (
    <span className="path-label">
      <span className="mono small muted ellipsis" title={path}>
        {path}
      </span>
      <CopyButton text={path} label={t('ui.copyPath')} />
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const indicator = useIndicatorId('segment');
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <Tooltip key={option.value} content={option.title}>
          <button
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={`segment ${option.value === value ? 'segment-on' : ''}`}
            onClick={() => option.value !== value && onChange(option.value)}
          >
            {option.value === value && <SlidingIndicator layoutId={indicator} className="segment-thumb" />}
            <span className="segment-label">{option.label}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function ErrorBox({ error, title }: { error: unknown; title?: string }) {
  const { t } = useTranslation(['components', 'common']);
  if (!error) return null;
  return (
    <div className="alert alert-bad" role="alert">
      <CircleAlert {...ICON} className="alert-icon" />
      <div className="alert-body">
        <strong>{title ?? t('ui.requestFailed')}</strong>
        <div>{errorMessage(error)}</div>
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  docTitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Browser tab title; defaults to `title` when it is a plain string */
  docTitle?: string;
}) {
  usePageTitle(docTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <div className="muted">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/**
 * Tab bar with a sliding underline. Keeps the ARIA tab pattern of the bars it replaces.
 * `inline` renders the compact variant used inside card headers.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  inline = false,
}: {
  tabs: ReadonlyArray<{ id: T; label: ReactNode; dirty?: boolean }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  inline?: boolean;
}) {
  const indicator = useIndicatorId('tabs');
  const { t: translate } = useTranslation(['components', 'common']);
  return (
    <div className={`tabs ${inline ? 'tabs-inline' : ''}`} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={`tab ${value === t.id ? 'tab-on' : ''}`}
          onClick={() => value !== t.id && onChange(t.id)}
        >
          {t.label}
          {t.dirty && <span className="tab-dirty" title={translate('ui.unsavedChanges')} aria-label={translate('ui.unsavedChangesLabel')} />}
          {value === t.id && <SlidingIndicator layoutId={indicator} className="tab-indicator" />}
        </button>
      ))}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;
export const MODEL_SUGGESTIONS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
/** Suggestions for a model <Combobox> */
export const MODEL_OPTIONS = MODEL_SUGGESTIONS.map((value) => ({ value }));
