import assert from 'node:assert/strict';
import test from 'node:test';

// Weekday and month names follow navigator.languages; pin it so the result does not depend on the machine.
Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'] }, configurable: true });
const { setLanguage } = await import('../src/i18n/index.ts');
const { describeCron } = await import('../src/lib/cron-words.ts');

// English is byte for byte what the API's describeCron says (packages/core/test/cron.test.ts), which
// the e2e specs read
const ENGLISH: ReadonlyArray<[string, string]> = [
  ['30 9 * * mon-fri', 'At 09:30, on Monday to Friday'],
  ['* * * * *', 'Every minute'],
  ['*/15 * * * *', 'Every 15 minutes'],
  ['0 * * * *', 'Every hour, on the hour'],
  ['5 * * * *', 'Every hour, at minute 5'],
  ['0 0 1 * *', 'At 00:00, on day 1 of the month'],
  ['0 12 25 dec *', 'At 12:00, on day 25 of the month, in December'],
  ['*/10 9-17 * * *', 'Every 10 minutes of the hours 9 to 17'],
  ['* 9-17 * * *', 'Every minute of the hours 9 to 17'],
  ['30 9-17 * * *', 'At minute 30 of the hours 9 to 17'],
  ['0,20,45 * * * *', 'At minutes 0, 20 and 45'],
  ['*/15 9 * * *', 'Every 15 minutes of the 09:00 hour'],
  ['0 9 * * 1,3', 'At 09:00, on Monday and Wednesday'],
  ['0 9 * * 1-3,5', 'At 09:00, on Monday to Wednesday and Friday'],
  ['0 9 1,15 * *', 'At 09:00, on day 1 and 15 of the month'],
  ['0 9 1-5 * *', 'At 09:00, on day 1 to 5 of the month'],
  ['0 9 1 * 1', 'At 09:00, on day 1 of the month, or on Monday'],
  ['0 9 * 1-3 *', 'At 09:00, in January to March'],
  ['0 9 * 1,7 *', 'At 09:00, in January and July'],
  ['0 1 * * *', 'At 01:00'],
  ['@daily', 'At 00:00'],
  ['@hourly', 'Every hour, on the hour'],
  ['@weekly', 'At 00:00, on Sunday'],
  ['@yearly', 'At 00:00, on day 1 of the month, in January'],
];

const SPANISH: ReadonlyArray<[string, string]> = [
  ['30 9 * * mon-fri', 'A las 09:30, de lunes a viernes'],
  ['* * * * *', 'Cada minuto'],
  ['*/15 * * * *', 'Cada 15 minutos'],
  ['0 * * * *', 'Cada hora, en punto'],
  ['5 * * * *', 'Cada hora, en el minuto 5'],
  ['0 0 1 * *', 'A las 00:00, el día 1 de cada mes'],
  ['0 12 25 dec *', 'A las 12:00, el día 25 de cada mes, en diciembre'],
  ['*/10 9-17 * * *', 'Cada 10 minutos de las horas de 9 a 17'],
  ['* 9-17 * * *', 'Cada minuto de las horas de 9 a 17'],
  ['30 9-17 * * *', 'En el minuto 30 de las horas de 9 a 17'],
  ['0,20,45 * * * *', 'En los minutos 0, 20 y 45'],
  ['*/15 9 * * *', 'Cada 15 minutos de la hora de las 09:00'],
  ['*/15 1 * * *', 'Cada 15 minutos de la hora de la 01:00'],
  ['0 9 * * 1,3', 'A las 09:00, cada lunes y miércoles'],
  ['0 9 * * 1-3,5', 'A las 09:00, de lunes a miércoles y viernes'],
  ['0 9 1,15 * *', 'A las 09:00, los días 1 y 15 de cada mes'],
  ['0 9 1-5 * *', 'A las 09:00, del 1 al 5 de cada mes'],
  ['0 9 1 * 1', 'A las 09:00, el día 1 de cada mes o cada lunes'],
  ['0 9 * 1-3 *', 'A las 09:00, de enero a marzo'],
  ['0 9 * 1,7 *', 'A las 09:00, en enero y julio'],
  ['0 1 * * *', 'A la 01:00'],
  ['@daily', 'A las 00:00'],
  ['@hourly', 'Cada hora, en punto'],
  ['@weekly', 'A las 00:00, cada domingo'],
  ['@yearly', 'A las 00:00, el día 1 de cada mes, en enero'],
];

test('English says what the API says', () => {
  setLanguage('en');
  for (const [expr, words] of ENGLISH) assert.equal(describeCron(expr), words, expr);
});

test('Spanish, from Spain', () => {
  setLanguage('es');
  try {
    for (const [expr, words] of SPANISH) assert.equal(describeCron(expr), words, expr);
  } finally {
    setLanguage('en');
  }
});

test('an expression that does not parse has no words', () => {
  assert.equal(describeCron('61 * * * *'), null);
  assert.equal(describeCron('* * *'), null);
  assert.equal(describeCron(''), null);
});
