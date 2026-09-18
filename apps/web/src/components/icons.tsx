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

/** Every icon in the app uses this size/stroke unless a component says otherwise. */
export const ICON: LucideProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true };
export const ICON_SM: LucideProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true };

/** Brand mark: an eight-point spark inside a gradient rounded square. */
export function BrandMark({ size = 26 }: { size?: number }) {
  const gradient = useId();
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e58a63" />
          <stop offset="55%" stopColor="#d97757" />
          <stop offset="100%" stopColor="#c8527a" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="8" fill={`url(#${gradient})`} />
      <g stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <path d="M14 6.5v15M6.5 14h15M8.7 8.7l10.6 10.6M19.3 8.7L8.7 19.3" />
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

export function Monogram({ name, size = 36 }: { name: string; size?: number }) {
  const letters = (name.match(/[A-Za-z0-9]+/g) ?? [name])
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span className="monogram" style={{ '--hue': nameHue(name), width: size, height: size } as React.CSSProperties} aria-hidden>
      {letters || '?'}
    </span>
  );
}
