// Shared icon defaults and the few icon pickers that depend on data (tool names, file names).
import {
  Bot,
  Braces,
  FileCode2,
  FileJson2,
  FilePen,
  FileSearch,
  FileTerminal,
  FileText,
  FileType2,
  Globe,
  ListChecks,
  Plug,
  Search,
  SquareTerminal,
  Wand2,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkItemPriority, WorkItemRef, WorkItemStatus, WorkItemType } from '@agentry/shared';
import { columnMeta, priorityMeta } from '../lib/work-items';

/** Every icon in the app uses this size/stroke unless a component says otherwise. */
export const ICON: LucideProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true };
export const ICON_SM: LucideProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true };

/**
 * Brand mark: one node fanning out to three, on the brand gradient. The stops repeat `--grad`
 * (tokens.css) because an SVG gradient stop cannot read a CSS variable in every browser.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  const gradient = useId();
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#b35a36" />
          <stop offset="55%" stopColor="#b04a5e" />
          <stop offset="100%" stopColor="#9c3f77" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill={`url(#${gradient})`} />
      <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none">
        <path d="M8.3 14h4" />
        <path d="M12.3 14c3.9 0 3.5-6.6 7.4-6.6" />
        <path d="M12.3 14c3.9 0 3.5 6.6 7.4 6.6" />
      </g>
      <g fill="#fff">
        <circle cx="7.4" cy="14" r="2.4" />
        <circle cx="20.1" cy="7.4" r="2" />
        <circle cx="20.1" cy="14" r="2" />
        <circle cx="20.1" cy="20.6" r="2" />
      </g>
    </svg>
  );
}

const TOOL_ICONS: Array<[RegExp, LucideIcon]> = [
  [/^(bash|powershell|repl|monitor)/i, SquareTerminal],
  [/^(read|notebookread)/i, FileText],
  [/^(edit|write|multiedit|notebookedit)/i, FilePen],
  [/^(grep|glob|toolsearch)/i, FileSearch],
  [/^(websearch)/i, Search],
  [/^(webfetch)/i, Globe],
  [/^(task|agent|sendmessage|listagents)/i, Bot],
  [/^(todo|task(create|get|list|update|output|stop))/i, ListChecks],
  [/^skill/i, Wand2],
  [/^mcp__/i, Plug],
];

export function toolIcon(name: string): LucideIcon {
  // Task* bookkeeping tools must win over the generic Task (subagent) rule
  if (/^task(create|get|list|update|output|stop)/i.test(name)) return ListChecks;
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;
}

export function fileIcon(name: string): LucideIcon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'json') return FileJson2;
  if (ext === 'md' || ext === 'txt') return FileText;
  if (['sh', 'bash', 'zsh'].includes(ext)) return FileTerminal;
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py'].includes(ext)) return FileCode2;
  if (['yaml', 'yml', 'toml'].includes(ext)) return Braces;
  return FileType2;
}

/** Deterministic hue from a name, for project monograms. */
export function nameHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

// ---------- work items: the marks every Tasks screen draws the same way (styles/work-item-marks.css)

/**
 * A column's glyph: told by shape (dashed, empty, half, three quarters, ticked), and only Done is
 * coloured, ok. Named for a screen reader unless `decorative`, for where its word is already beside it.
 */
export function WorkItemStatusIcon({ status, decorative = false }: { status: WorkItemStatus; decorative?: boolean }) {
  const { t } = useTranslation('tasks');
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': t(columnMeta(status).label) };
  return (
    <svg className={`workitem-status ${status === 'done' ? 's-done' : ''}`.trim()} viewBox="0 0 16 16" data-status={status} {...a11y}>
      {status === 'backlog' && <circle cx="8" cy="8" r="6" strokeDasharray="2.4 2.2" />}
      {status === 'todo' && <circle cx="8" cy="8" r="6" />}
      {status === 'in_progress' && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path className="fill" d="M8 4a4 4 0 0 1 0 8z" />
        </>
      )}
      {status === 'in_review' && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path className="fill" d="M8 4a4 4 0 1 1-4 4h4z" />
        </>
      )}
      {status === 'done' && (
        <>
          <circle className="fill" cx="8" cy="8" r="7" />
          <path className="tick" d="M5.2 8.3l1.9 1.9 3.7-4" />
        </>
      )}
    </svg>
  );
}

const TYPE_PATHS: Record<WorkItemType, string> = {
  epic: 'M12 3l9 9-9 9-9-9zM12 8.5l3.5 3.5-3.5 3.5L8.5 12z',
  story: 'M7 3.5h10v17l-5-3.8-5 3.8z',
  task: 'M5 5h14v14H5zM9 12l2 2 4-4.5',
  bug: 'M9 7a3 3 0 0 1 6 0M8 9h8v5a4 4 0 0 1-8 0zM12 9v9M4 13h4M16 13h4M5 7.5l3 2M19 7.5l-3 2M5.5 19l2.8-2.4M18.5 19l-2.8-2.4',
};

/** Epic, story, task or bug by shape, all neutral. */
export function WorkItemTypeIcon({ type, large = false, decorative = false }: { type: WorkItemType; large?: boolean; decorative?: boolean }) {
  const { t } = useTranslation('tasks');
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': t(`type.${type}`) };
  return (
    <svg className={`workitem-type ${large ? 'lg' : ''}`.trim()} viewBox="0 0 24 24" data-type={type} {...a11y}>
      <path d={TYPE_PATHS[type]} />
    </svg>
  );
}

/**
 * Priority is not a status: three neutral bars, and urgent the only mark in a colour, the accent,
 * which no status uses. Its word is always said, to a screen reader and on hover.
 */
export function PriorityMark({ priority }: { priority: WorkItemPriority }) {
  const { t } = useTranslation('tasks');
  const meta = priorityMeta(priority);
  const label = t(meta.aria);
  return (
    <span className={`priority-mark p-${priority}`} role="img" aria-label={label} title={label}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** `AGN-12`, in mono and tabular; `boxed` where it heads a page or a row of its own. */
export function WorkItemKey({ value, boxed = false }: { value: string; boxed?: boolean }) {
  return <span className={`workitem-key ${boxed ? 'boxed' : ''}`.trim()}>{value}</span>;
}

/** An epic's label: neutral, with the epic's own hue only on its diamond. */
export function EpicLabel({ epic }: { epic: Pick<WorkItemRef, 'id' | 'title'> }) {
  return (
    <span className="workitem-epic" style={{ '--hue': nameHue(epic.id) } as React.CSSProperties}>
      {epic.title}
    </span>
  );
}

/**
 * The letters of a monogram: the first of each of the first two words. A project always gets two, as
 * the references draw it ("claude-wrapper" CW, "nodo" NO), taking the second from a lone word; a
 * person keeps one, since their mark stands beside their name.
 */
export function monogramLetters(name: string, pair = false): string {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [name];
  const [first = '', second] = words;
  if (pair && second === undefined) return first.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function Monogram({ name, size = 36, project = false }: { name: string; size?: number; /** Two letters even for one word */ project?: boolean }) {
  const letters = monogramLetters(name, project);
  return (
    <span className="monogram" style={{ '--hue': nameHue(name), width: size, height: size } as React.CSSProperties} aria-hidden>
      {letters || '?'}
    </span>
  );
}
