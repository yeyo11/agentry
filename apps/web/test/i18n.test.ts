import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLanguage, intlLocale } from '../src/i18n/language.ts';
import { en, es, withManyPlurals } from '../src/i18n/resources.ts';

function keys(tree: object, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : keys(value as object, `${prefix}${key}.`),
  );
}

test('both languages have the same namespaces', () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
});

for (const ns of Object.keys(en) as Array<keyof typeof en>) {
  test(`${ns}: English and Spanish have exactly the same keys`, () => {
    assert.deepEqual(keys(es[ns]).sort(), keys(en[ns]).sort());
  });

  test(`${ns}: no empty Spanish text`, () => {
    const empty = keys(es[ns]).filter((key) => {
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], es[ns]);
      return typeof value !== 'string' || value.trim() === '';
    });
    assert.deepEqual(empty, []);
  });
}

test('Spanish many plurals are derived from other', () => {
  assert.deepEqual(withManyPlurals({ a: { n_one: 'una', n_other: 'varias' } }), {
    a: { n_one: 'una', n_other: 'varias', n_many: 'varias' },
  });
});

test('language detection: the first language Agentry has wins, English otherwise', () => {
  assert.equal(detectLanguage(['es-ES', 'en']), 'es');
  assert.equal(detectLanguage(['es']), 'es');
  assert.equal(detectLanguage(['ES-mx']), 'es');
  assert.equal(detectLanguage(['de-DE', 'es', 'en']), 'es');
  assert.equal(detectLanguage(['en-US', 'es']), 'en');
  assert.equal(detectLanguage(['fr', 'de']), 'en');
  assert.equal(detectLanguage([]), 'en');
  // `est` is Estonian, not a Spanish variant
  assert.equal(detectLanguage(['et', 'est']), 'en');
});

test('Intl locale keeps the browser variant of the active language', () => {
  assert.equal(intlLocale('en', ['es-ES', 'en-GB']), 'en-GB');
  assert.equal(intlLocale('es', ['en-US', 'es-MX']), 'es-MX');
  assert.equal(intlLocale('es', ['en-US']), 'es-ES');
  assert.equal(intlLocale('en', ['de-DE']), 'en-US');
});
