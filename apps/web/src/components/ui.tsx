import {
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  Copy,
  Hand,
  Inbox,
  Info,
  Minus,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MODEL_ALIASES } from '@agentry/shared';
import i18n from '../i18n';
import { useOverview } from '../api';
import { errorMessage } from '../lib/format';
import { Combobox, type ComboboxOption } from './controls/Combobox';
import { Tooltip } from './controls/Tooltip';
import { ICON, ICON_SM } from './icons';
import { Illustration, type IllustrationName, type IllustrationSize, type IllustrationTone } from './illustrations';
import { AnimatePresence, motion, SlidingIndicator, useIndicatorId } from './motion';

const TONES = {
  starting: 'info',
  busy: 'active',
  running: 'active',
  working: 'active',
  blocked: 'bad',
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

/*
 * A status is said in words and with a shape, never with a colour alone: the icon differs by
 * meaning (done, failed, stopped, waiting...) so it still reads in greyscale or for a colour-blind
 * person. `null` is the spinner of something that is happening now.
 */
const STATUS_ICON: Record<string, LucideIcon | null> = {
  starting: null,
  busy: null,
  running: null,
  working: null,
  merging: null,
  resolving: null,
  blocked: CirclePause,
  idle: CirclePause,
  pending: Clock,
  completed: CircleCheck,
  success: CircleCheck,
  merged: CircleCheck,
  failed: TriangleAlert,
  error: TriangleAlert,
  killed: TriangleAlert,
  stopped: OctagonX,
  skipped: Ban,
  waiting: Hand,
  conflicted: TriangleAlert,
};

const TONE_ICON: Record<string, LucideIcon> = { ok: CircleCheck, warn: TriangleAlert, bad: TriangleAlert, info: Info, idle: CirclePause, muted: Minus };

function StatusIcon({ icon: Icon }: { icon: LucideIcon | null }) {
  return Icon ? <Icon size={12} strokeWidth={2} aria-hidden /> : <span className="spinner spinner-xs" aria-hidden />;
}

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  // Subscribes the badge to language changes; statusText reads the active language
  useTranslation();
  const key = status.toLowerCase();
  const tone = isStatus(key) ? TONES[key] : 'muted';
  const icon = key in STATUS_ICON ? (STATUS_ICON[key] ?? null) : (TONE_ICON[tone] ?? Minus);
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <StatusIcon icon={icon} />
      {statusText(status)}
    </span>
  );
}

/** Tones that carry a verdict get its icon too; the others are labels and stay plain. */
const TAG_ICON: Record<string, LucideIcon> = { ok: CircleCheck, warn: TriangleAlert, bad: TriangleAlert };

export function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  const Icon = TAG_ICON[tone];
  return (
    <span className={`badge badge-${tone}`}>
      {Icon && <Icon size={12} strokeWidth={2} aria-hidden />}
      {children}
    </span>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation(['components', 'common']);
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden /> {label ?? t('common:loading')}
    </div>
  );
}

/**
 * An empty, error or system state. With an `illustration` it is the full pattern of design system
 * §4 (illustration, title, a sentence or two, a primary action and at most one secondary), for a
 * state that takes the place of a list or a page. Without one it stays the compact icon version,
 * for dialogs, editors and panels that sit beside other content.
 */
export function Empty({
  title,
  children,
  action,
  icon: Icon = Inbox,
  illustration,
  tone,
  size,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  illustration?: IllustrationName;
  tone?: IllustrationTone;
  size?: IllustrationSize;
}) {
  return (
    <div className={illustration ? 'state state-empty state-illustrated' : 'state state-empty'}>
      {illustration ? (
        <Illustration name={illustration} tone={tone} size={size} />
      ) : (
        <span className="state-icon" aria-hidden>
          <Icon size={20} strokeWidth={1.75} />
        </span>
      )}
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
    <div className="skeleton-stack" role="status" aria-busy="true">
      <span className="sr-only">{t('ui.loadingShort')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" aria-hidden style={{ height, width: `${92 - ((i * 17) % 40)}%` }} />
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
        aria-label={copied ? t('ui.copied') : name}
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

/** Arrow keys move through a set of options that share one tab stop (the ARIA radio and tab patterns). */
function arrowTarget(event: KeyboardEvent<HTMLElement>, selector: string): HTMLElement | null {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (!forward && !backward && event.key !== 'Home' && event.key !== 'End') return null;
  const items = [...(event.currentTarget.closest('[role=radiogroup], [role=tablist]')?.querySelectorAll<HTMLElement>(selector) ?? [])];
  const at = items.indexOf(event.currentTarget);
  if (at < 0) return null;
  if (event.key === 'Home') return items[0] ?? null;
  if (event.key === 'End') return items[items.length - 1] ?? null;
  return items[(at + (forward ? 1 : -1) + items.length) % items.length] ?? null;
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
            tabIndex={option.value === value ? 0 : -1}
            className={`segment ${option.value === value ? 'segment-on' : ''}`}
            onClick={() => option.value !== value && onChange(option.value)}
            onKeyDown={(event) => {
              const target = arrowTarget(event, '[role=radio]');
              if (!target) return;
              event.preventDefault();
              target.focus();
              target.click();
            }}
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

const tabId = (group: string, id: string) => `${group}-tab-${id}`;
const panelId = (group: string) => `${group}-panel`;

/**
 * Tab bar with a sliding underline, following the ARIA tabs pattern: one tab stop, arrow keys move
 * and select. Pair it with a `TabPanel` of the same `group` so the panel is named by its tab.
 * `inline` renders the compact variant used inside card headers.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  group,
  inline = false,
}: {
  tabs: ReadonlyArray<{ id: T; label: ReactNode; dirty?: boolean }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Names the tabs and their panel for each other; unique on the page */
  group?: string;
  inline?: boolean;
}) {
  const indicator = useIndicatorId('tabs');
  const { t: translate } = useTranslation(['components', 'common']);
  return (
    <div className={`tabs ${inline ? 'tabs-inline' : ''}`} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={group ? tabId(group, t.id) : undefined}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          aria-controls={group ? panelId(group) : undefined}
          tabIndex={value === t.id ? 0 : -1}
          className={`tab ${value === t.id ? 'tab-on' : ''}`}
          onClick={() => value !== t.id && onChange(t.id)}
          onKeyDown={(event) => {
            const target = arrowTarget(event, '[role=tab]');
            if (!target) return;
            event.preventDefault();
            target.focus();
            target.click();
          }}
        >
          {t.label}
          {t.dirty && <span className="tab-dirty" aria-hidden />}
          {t.dirty && <span className="sr-only"> ({translate('ui.unsavedChangesLabel')})</span>}
          {value === t.id && <SlidingIndicator layoutId={indicator} className="tab-indicator" />}
        </button>
      ))}
    </div>
  );
}

/** The panel of the selected tab in a `Tabs` with the same `group`. */
export function TabPanel({ group, tab, className, children }: { group: string; tab: string; className?: string; children: ReactNode }) {
  return (
    <div className={className} role="tabpanel" id={panelId(group)} aria-labelledby={tabId(group, tab)}>
      {children}
    </div>
  );
}

/** A unique group for a `Tabs` and its `TabPanel`. */
export function useTabGroup(): string {
  return `tabs-${useId().replaceAll(':', '')}`;
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
          {title ? <h2>{title}</h2> : <span />}
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

/** Until the wrapper has heard from the CLI: the aliases it always takes. */
export const MODEL_OPTIONS: ComboboxOption[] = MODEL_ALIASES.map((value) => ({ value }));

/**
 * The models to offer: what the CLI says this account may run (`SystemInfo.models`, read from the
 * CLI's own state file), with its names and the line it shows under each. The ones it names but
 * cannot run are left out — a suggestion nobody can pick is a trap — and the aliases stand alone
 * until the overview has been read.
 */
export function useModelOptions(): ComboboxOption[] {
  const models = useOverview().data?.system.models;
  return useMemo(
    () =>
      models && models.length > 0
        ? models.filter((model) => !model.disabled).map((model) => ({ value: model.value, label: model.label ?? model.value, hint: model.description }))
        : MODEL_OPTIONS,
    [models],
  );
}

/** A model <Combobox>, filled from what the CLI offers; everything else is the Combobox's own. */
export function ModelCombobox(props: Omit<ComponentProps<typeof Combobox>, 'options'>) {
  return <Combobox {...props} options={useModelOptions()} />;
}
