import assert from 'node:assert/strict';
import test from 'node:test';
import type { HealthSignal } from '@agentry/shared';
// The server's own catalogues: the web's English must say exactly what they say
import { CONNECTOR_GUIDE, CONNECTOR_LIMITS, parseConnectors } from '../../../packages/core/src/connectors.ts';
import { HEALTH_HINTS, HEALTH_REASONS, hintText, reasonText } from '../../../packages/core/src/health-strings.ts';
import { setLanguage } from '../src/i18n/index.ts';
import { currentLanguage } from '../src/i18n/language.ts';
import { connectorActionLabel, connectorLimitName, healthReason, localized, serverText, shownParams, signalHint } from '../src/lib/server-strings.ts';

// Every figure any sentence names, twice: once past each threshold of the formatting, once below
const FIGURES = [
  { command: 'pnpm test', minutes: 4, usualSeconds: 81, limitMinutes: 10, percent: 85, count: 3, kind: 'Bash', limitSeconds: 120, tool: 'Read', error: 'ENOENT', file: 'a.test.ts', spentUsd: 0.5, limitUsd: 2 },
  { command: 'make', minutes: 1, usualSeconds: 300, limitMinutes: 1, percent: 99, count: 1, kind: 'Grep', limitSeconds: 45, tool: 'Edit', error: 'boom', file: 'b.spec.ts', spentUsd: 0.004, limitUsd: 0.05 },
];

// setLanguage, as the UI does: the figures follow the language as well as the words
function inLanguage<T>(language: 'en' | 'es', run: () => T): T {
  const before = currentLanguage();
  setLanguage(language);
  try {
    return run();
  } finally {
    setLanguage(before);
  }
}

test('in English, every health reason and hint reads exactly as the server wrote it', () => {
  inLanguage('en', () => {
    for (const params of FIGURES) {
      for (const code of Object.keys(HEALTH_REASONS)) {
        assert.equal(serverText(code, params, 'fallback'), reasonText(code, params), code);
      }
      for (const code of Object.keys(HEALTH_HINTS)) {
        assert.equal(serverText(code, params, 'fallback'), hintText(code, params), code);
      }
    }
  });
});

test('in English, every connector step, link, limit and action reads as the server wrote it', () => {
  inLanguage('en', () => {
    for (const step of CONNECTOR_GUIDE.steps) assert.equal(localized(step), step.text, step.code);
    for (const link of CONNECTOR_GUIDE.links) assert.equal(localized(link.label), link.label.text, link.label.code);
    for (const limit of CONNECTOR_LIMITS) {
      assert.equal(localized(limit.reason), limit.reason.text, limit.reason.code);
      assert.equal(connectorLimitName(limit), limit.name, limit.id);
    }
    // The prepared actions are only reachable through a parsed `claude mcp list`
    const listed = parseConnectors(
      ['claude.ai Claude Docs', 'claude.ai Gmail', 'claude.ai Google Calendar'].map((name) => `${name}: https://example.test/mcp - ✔ Connected`).join('\n'),
    );
    const actions = listed.flatMap((connector) => connector.actions ?? []);
    assert.ok(actions.length >= 4, `every kind has its actions (${String(actions.length)})`);
    for (const action of actions) assert.equal(connectorActionLabel(action), action.label, action.id);
  });
});

test('in Spanish, every code the server sends has its own sentence with every figure filled in', () => {
  inLanguage('es', () => {
    const codes = [...Object.keys(HEALTH_REASONS), ...Object.keys(HEALTH_HINTS)];
    for (const params of FIGURES) {
      for (const code of codes) {
        const text = serverText(code, params, 'fallback');
        assert.notEqual(text, 'fallback', `${code} has no Spanish`);
        assert.doesNotMatch(text, /\{\{|undefined/, `${code} left a figure out: ${text}`);
        assert.notEqual(text, reasonText(code, params) ?? hintText(code, params), `${code} is still in English`);
      }
    }
    for (const step of CONNECTOR_GUIDE.steps) assert.notEqual(localized(step), step.text, step.code);
    for (const limit of CONNECTOR_LIMITS) assert.notEqual(localized(limit.reason), limit.reason.text, limit.reason.code);
  });
});

test('a code this build does not know shows the server’s text, never the key', () => {
  inLanguage('es', () => {
    assert.equal(serverText('health.somethingNew', { minutes: 3 }, 'Something new for 3 min.'), 'Something new for 3 min.');
    assert.equal(serverText(undefined, undefined, 'No code at all.'), 'No code at all.');
    assert.equal(localized({ code: 'connectors.authorise.later', text: 'A later step.' }), 'A later step.');
    assert.equal(connectorActionLabel({ id: 'drive-recent', label: 'Summarise my Drive' }), 'Summarise my Drive');
  });
});

test('Spanish picks the plural from the count and writes figures its own way', () => {
  inLanguage('es', () => {
    assert.equal(serverText('health.branches', { count: 1 }, ''), 'Falló 1 rama.');
    assert.equal(serverText('health.branches', { count: 2 }, ''), 'Fallaron 2 ramas.');
    assert.match(serverText('health.budget.cost', { spentUsd: 1.5, limitUsd: 2 }, ''), /1,50\s*US\$/);
  });
  assert.equal(shownParams({ usualSeconds: 30 }).usualSeconds, '30 s');
  assert.equal(shownParams({ count: 1200 }).count, 1200);
});

test('a chat with no signal says "nothing unusual" in the active language', () => {
  const health = { reason: 'Nothing unusual.', signals: [] };
  assert.equal(inLanguage('es', () => healthReason(health)), 'Nada fuera de lo normal.');
  const signal: HealthSignal = {
    kind: 'silence',
    level: 'warn',
    reason: reasonText('health.silence', { minutes: 7 }) ?? '',
    reasonCode: 'health.silence',
    hint: hintText('health.hint.silence', { minutes: 7 }) ?? '',
    hintCode: 'health.hint.silence',
    params: { minutes: 7 },
  };
  const said = inLanguage('es', () => ({ reason: healthReason({ reason: signal.reason, signals: [signal] }), hint: signalHint(signal) }));
  assert.match(said.reason, /7 min/);
  assert.match(said.hint ?? '', /No sé nada de ti desde hace 7 min/);
  assert.equal(signalHint({ hint: undefined, hintCode: undefined, params: undefined }), undefined);
});
