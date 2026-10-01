import assert from 'node:assert/strict';
import test from 'node:test';

// Formatting follows navigator.languages; pin it so the result does not depend on the machine.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { setLanguage } = await import('../src/i18n/index.ts');
const { daysAgo, formatBytes, formatAmountShort, formatCost, formatDateTime, formatDuration, formatHour, formatNumber, timeAgo, timeUntil } = await import('@agentry/ui/lib/format');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const nowSeconds = () => Date.now() / 1000;

test('English output is the text the hand-written formatters produced', () => {
  setLanguage('en');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42 * SEC), '42s');
  assert.equal(formatDuration(3 * MIN + 2 * SEC), '3m 2s');
  assert.equal(formatDuration(3 * MIN), '3m');
  assert.equal(formatDuration(11 * MIN), '11m');
  assert.equal(formatDuration(2 * HOUR + 5 * MIN), '2h 5m');
  assert.equal(formatDuration(1 * DAY + 3 * HOUR), '1d 3h');
  assert.equal(formatDuration(400 * DAY), '400d');
  assert.equal(timeAgo(Date.now()), 'just now');
  assert.equal(timeAgo(Date.now() - 12 * SEC), '12s ago');
  assert.equal(timeAgo(Date.now() - 5 * MIN), '5m ago');
  assert.equal(timeAgo(Date.now() - 2 * HOUR), '2h ago');
  assert.equal(timeAgo(Date.now() - 4 * DAY), '4d ago');
  assert.equal(timeAgo(null), '—');
  assert.equal(timeUntil(nowSeconds() - 10), 'now');
  assert.equal(timeUntil(nowSeconds() + 2 * 3600 + 5 * 60 + 0.4), 'in 2h 5m');
  assert.equal(formatCost(null), '$0.00');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.0012), '$0.0012');
  assert.equal(formatCost(1.5), '$1.50');
  assert.equal(formatCost(1234.5), '$1,234.50');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2048 * 1024 * 1024), '2048.0 MB');
  assert.equal(formatNumber(1500), '1,500');
  const at = Date.UTC(2026, 8, 19, 14, 3, 0);
  assert.equal(formatDateTime(at), new Date(at).toLocaleString('en-US'));
});

test('Spanish output', () => {
  setLanguage('es');
  try {
    assert.equal(formatDuration(3 * MIN + 2 * SEC), '3 min 2 s');
    assert.equal(formatDuration(2 * HOUR + 5 * MIN), '2 h 5 min');
    // The design system's words for a finished run
    assert.equal(formatDuration(3 * MIN + 40 * SEC), '3 min 40 s');
    assert.equal(formatDuration(11 * MIN), '11 min');
    assert.equal(timeAgo(Date.now()), 'ahora mismo');
    assert.equal(timeAgo(Date.now() - 5 * MIN), 'hace 5 min');
    assert.equal(timeUntil(nowSeconds() - 10), 'ahora');
    assert.equal(timeUntil(nowSeconds() + 3 * 60 + 0.4), 'dentro de 3 min');
    // Intl separates amount and currency with a no-break space
    assert.equal(formatCost(1.5), '1,50\u00a0US$');
    assert.equal(formatBytes(1536), '1,5 KB');
    assert.equal(formatNumber(1500), '1500');
    assert.equal(formatNumber(15000), '15.000');
    // The cached formatter follows the language like the one `toLocaleString` builds each time
    const at = Date.UTC(2026, 8, 19, 14, 3, 0);
    assert.equal(formatDateTime(at), new Date(at).toLocaleString('es-ES'));
  } finally {
    setLanguage('en');
  }
});

test('a short amount keeps whole units, and the language’s short form past a thousand', () => {
  setLanguage('en');
  assert.equal(formatAmountShort(286.95), '287');
  assert.equal(formatAmountShort(1362.13), '1.4K');
  assert.equal(formatAmountShort(12345.6), '12.3K');
  assert.equal(formatAmountShort(0.42), '0.42');
  assert.equal(formatAmountShort(0), '0');
  setLanguage('es');
  try {
    assert.equal(formatAmountShort(286.95), '287');
    assert.equal(formatAmountShort(1362.13), '1,4\u00a0mil');
    assert.equal(formatAmountShort(0.42), '0,42');
  } finally {
    setLanguage('en');
  }
});

test('a moment in a list grouped by day reads as its bare hour, and the day heads the group', () => {
  setLanguage('es');
  try {
    const at = new Date(2026, 8, 27, 17, 44, 12).getTime();
    assert.equal(formatHour(at), '17:44');
    assert.equal(formatHour(new Date(2026, 8, 27, 7, 5).getTime()), '07:05');
    assert.equal(formatHour(null), '');
    setLanguage('en');
    // A 24-hour clock in English too: the list is a log, and "5:44 PM" would not line up
    assert.equal(formatHour(at), '17:44');
  } finally {
    setLanguage('en');
  }
  const now = new Date(2026, 8, 28, 0, 10).getTime();
  assert.equal(daysAgo(new Date(2026, 8, 28, 0, 1).getTime(), now), 0);
  assert.equal(daysAgo(new Date(2026, 8, 27, 23, 50).getTime(), now), 1, 'ten minutes ago, but yesterday');
  assert.equal(daysAgo(new Date(2026, 8, 20, 12, 0).getTime(), now), 8);
  assert.equal(daysAgo('not a date', now), null);
});
