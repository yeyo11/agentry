export function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeAgo(value: string | number | null | undefined): string {
  const ms = toMs(value);
  if (ms == null) return '—';
  const diff = Date.now() - ms;
  if (diff < 5000) return 'just now';
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function timeUntil(epochSeconds: number | undefined): string {
  if (!epochSeconds) return '—';
  const diff = epochSeconds * 1000 - Date.now();
  return diff <= 0 ? 'now' : `in ${formatDuration(diff)}`;
}

export function durationBetween(start: string | number | null, end: string | number | null): string {
  const a = toMs(start);
  if (a == null) return '—';
  return formatDuration((toMs(end) ?? Date.now()) - a);
}

export function formatDateTime(value: string | number | null | undefined): string {
  const ms = toMs(value);
  return ms == null ? '—' : new Date(ms).toLocaleString();
}

export function formatClock(value: string | null | undefined): string {
  const ms = toMs(value);
  return ms == null ? '' : new Date(ms).toLocaleTimeString();
}

export function formatCost(usd: number | null | undefined): string {
  if (!usd) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split('/').filter(Boolean);
  let out = parts.pop() ?? path;
  while (parts.length > 0) {
    const next = `${parts[parts.length - 1]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
    parts.pop();
  }
  return `…/${out}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function errorMessage(error: unknown): string {
  if (!error) return '';
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return typeof detail === 'string' && detail ? `${error.message} — ${detail}` : error.message;
  }
  return String(error);
}
