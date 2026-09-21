import type { ChatHealth, ConnectorAction, ConnectorLimit, HealthSignal, Localized, LocalizedParams } from '@agentry/shared';
import i18n from '../i18n';
import { formatNumber } from './format';

/*
 * Sentences the server writes come with a stable code and the figures they were built from. The
 * `server` namespace holds one key per code, so the page says them in the active language; a code
 * this build does not know (a newer server) falls back to the server's own English, never to the
 * key itself.
 */

// The codes arrive at run time, so they cannot be checked against the typed keys
type Options = Record<string, string | number>;
const translate = i18n.t.bind(i18n) as unknown as (key: string, options: Options) => string;
const exists = i18n.exists.bind(i18n) as unknown as (key: string, options: Options) => boolean;

/** `81 s` up to a minute and a half, `2 min` after: the server's rule, with the language's digits */
function duration(seconds: number): string {
  return seconds < 90 ? `${formatNumber(Math.max(1, Math.round(seconds)))} s` : `${formatNumber(Math.max(1, Math.round(seconds / 60)))} min`;
}

// Always two decimals, as the server writes `$x.xx`, in the language's own currency layout
const usd = (value: number) => formatNumber(value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The figures as the sentence shows them. A name says what a figure is (`…Seconds`, `…Usd`), so the
 * rule lives here once instead of in every translation. `count` stays a number: it picks the plural.
 */
export function shownParams(params: LocalizedParams = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'number') out[key] = value;
    else if (key.endsWith('Seconds')) out[key] = duration(value);
    else if (key.endsWith('Usd')) out[key] = usd(value);
    else if (key === 'count') out[key] = value;
    else out[key] = formatNumber(value);
  }
  return out;
}

/** The sentence of `code` in the active language, or `fallback` when this build has no key for it. */
export function serverText(code: string | undefined, params: LocalizedParams | undefined, fallback: string): string {
  if (!code) return fallback;
  const key = `server:${code}`;
  const options = shownParams(params);
  if (!exists(key, options)) return fallback;
  return translate(key, options);
}

export const localized = (value: Localized): string => serverText(value.code, value.params, value.text);

export const signalReason = (signal: Pick<HealthSignal, 'reason' | 'reasonCode' | 'params'>): string =>
  serverText(signal.reasonCode, signal.params, signal.reason);

/** The hint shares the signal's figures, the same way the server wrote it. */
export const signalHint = (signal: Pick<HealthSignal, 'hint' | 'hintCode' | 'params'>): string | undefined =>
  signal.hint === undefined ? undefined : serverText(signal.hintCode, signal.params, signal.hint);

/** A chat's one-line verdict: the first signal's reason, or "nothing unusual" when there is none. */
export function healthReason(health: Pick<ChatHealth, 'reason' | 'signals'>): string {
  const first = health.signals[0];
  return first ? signalReason(first) : serverText('health.ok', undefined, health.reason);
}

// The prepared actions and the out-of-reach features carry no code, but their ids are as stable
export const connectorActionLabel = (action: Pick<ConnectorAction, 'id' | 'label'>): string => serverText(`connectors.action.${action.id}`, undefined, action.label);

export const connectorLimitName = (limit: Pick<ConnectorLimit, 'id' | 'name'>): string => serverText(`connectors.limit.${limit.id}`, undefined, limit.name);
