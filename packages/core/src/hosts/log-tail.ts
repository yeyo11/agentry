import { redactHostText } from './redact.ts';

// What a person (and a fixing chat) reads of a job log: the end of it, plus the neighbourhood of the
// first errors, as clean text. The log arrives already bounded by the execution layer's tail ring
// (512 KiB); this cuts it further and cleans it. GitHub's step labels read UNKNOWN STEP a few hours
// after a run (recorded), so nothing here depends on them.

export const TAIL_LINES = 200;
export const TAIL_BYTES = 16 * 1024;
export const ERROR_WINDOWS = 3;
export const ERROR_CONTEXT = 20;
export const LINE_CHARS = 500;

/** Marker lines the runners write: GitHub `##[error]`, GitLab `ERROR:`, and a non-zero `exit code` */
const ERROR_MARKER = /##\[error\]|\bERROR:|\bexit code [1-9]\d*/;

/** GitLab's `section_start:<epoch>:<name>` and `section_end:…`, written with a trailing `\r` and a clear-line code */
const SECTION_MARKER = /section_(?:start|end):\d+:[\w.-]+\r?/g;

/** CSI sequences, OSC sequences and two-character escapes, as raw ESC or as the `^[` GitHub's CLI prints in its place */
const ESCAPES = /(?:\x1b|\^\[)(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Control characters other than tab (newlines and carriage returns are handled before this) */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** The prefix GitLab puts on every line of a trace with timestamps: `<time>Z <stream><flag> ` */
const GITLAB_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z \d\d[OE][+ ]?/;

export type LogTailStatus = 'lines' | 'no-output-yet';

export interface LogTail {
  lines: string[];
  /** Lines were left out between the start of the log and the end of the tail */
  truncated: boolean;
  /** `no-output-yet` is not "log unavailable": a job that has not printed anything yet, or a manual one */
  status: LogTailStatus;
}

export interface LogTailOptions {
  /** The check's state; decides whether an empty or preamble-only log means "no output yet" */
  state?: string;
}

/** One line, cleaned: BOM, escapes, carriage-return overwrites and control characters gone */
export function cleanLine(raw: string): string {
  let line = raw.replace(/^﻿/, '');
  // A `\r` rewrites the line (progress bars): the last non-empty segment is what stayed on screen
  if (line.includes('\r')) line = line.split('\r').filter((part) => part.replace(ESCAPES, '').trim() !== '').pop() ?? '';
  return line.replace(ESCAPES, '').replace(CONTROLS, '').trimEnd();
}

/** Strips section markers; a line that held nothing else yields `null` so it disappears */
function withoutSections(raw: string): string | null {
  const body = raw.replace(GITLAB_PREFIX, '');
  SECTION_MARKER.lastIndex = 0;
  if (!SECTION_MARKER.test(body)) return raw;
  SECTION_MARKER.lastIndex = 0;
  const rest = cleanLine(body.replace(SECTION_MARKER, ''));
  return rest === '' ? null : raw.replace(SECTION_MARKER, '');
}

/** A GitLab runner prints the job's own output after `section_start:…:step_script`; before it, only the preamble */
const hasJobOutput = (raw: string): boolean => /section_start:\d+:step_script/.test(raw) || !GITLAB_PREFIX.test(raw);

export function tailLog(raw: string, options: LogTailOptions = {}): LogTail {
  const waiting = options.state === 'running' || options.state === 'queued' || options.state === 'manual';
  if (waiting && (raw.trim() === '' || (options.state === 'running' && !hasJobOutput(raw)))) {
    return { lines: [], truncated: false, status: 'no-output-yet' };
  }

  const cleaned: string[] = [];
  for (const line of raw.split('\n')) {
    const kept = withoutSections(line);
    if (kept !== null) cleaned.push(cleanLine(kept));
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  if (cleaned.length === 0) return { lines: [], truncated: false, status: 'lines' };

  // The last 200 lines, and no more than 16 KiB of them
  let start = Math.max(0, cleaned.length - TAIL_LINES);
  let bytes = 0;
  for (let i = cleaned.length - 1; i >= start; i -= 1) {
    bytes += Buffer.byteLength(cleaned[i] ?? '') + 1;
    if (bytes > TAIL_BYTES && i < cleaned.length - 1) {
      start = i + 1;
      break;
    }
  }

  // ±20 lines around the first three errors in the part that was left out
  const keep = new Set<number>();
  for (let i = start; i < cleaned.length; i += 1) keep.add(i);
  let found = 0;
  for (let i = 0; i < start && found < ERROR_WINDOWS; i += 1) {
    if (!ERROR_MARKER.test(cleaned[i] ?? '')) continue;
    found += 1;
    for (let j = Math.max(0, i - ERROR_CONTEXT); j <= Math.min(start - 1, i + ERROR_CONTEXT); j += 1) keep.add(j);
    i += ERROR_CONTEXT;
  }

  const lines: string[] = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index !== previous + 1) lines.push('…');
    previous = index;
    lines.push(redactHostText((cleaned[index] ?? '').slice(0, LINE_CHARS)));
  }
  return { lines, truncated: keep.size < cleaned.length, status: 'lines' };
}
