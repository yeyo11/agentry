import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonths, clampDay, firstDayOfWeek, monthGrid, moveFocus, outOfRange, toDay } from '../src/lib/calendar.ts';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

test('the week starts where the reader expects it to', () => {
  assert.equal(firstDayOfWeek('en-US'), 0);
  assert.equal(firstDayOfWeek('es-ES'), 1);
  assert.equal(firstDayOfWeek('en-GB'), 1);
  // A tag Intl cannot read still gets a calendar
  assert.equal(firstDayOfWeek('not a locale'), 1);
});

test('a month is laid out in whole weeks that begin on the first day of the week', () => {
  // September 2026 begins on a Tuesday and has 30 days
  const monday = monthGrid(day(2026, 9, 21), 1);
  assert.equal(toDay(monday[0]?.[0] ?? new Date(0)), '2026-08-31');
  assert.equal(toDay(monday.at(-1)?.[6] ?? new Date(0)), '2026-10-04');
  assert.ok(monday.every((week) => week.length === 7));
  const sunday = monthGrid(day(2026, 9, 1), 0);
  assert.equal(toDay(sunday[0]?.[0] ?? new Date(0)), '2026-08-30');
  // February 2026 begins on a Sunday: four rows exactly when the week starts on Sunday
  assert.equal(monthGrid(day(2026, 2, 10), 0).length, 4);
});

test('the keys move the focused day the way the ARIA date picker pattern says', () => {
  const from = day(2026, 9, 23); // a Wednesday
  const moved = (key: string, shift = false) => toDay(moveFocus(from, key, shift, 1) ?? new Date(0));
  assert.equal(moved('ArrowLeft'), '2026-09-22');
  assert.equal(moved('ArrowRight'), '2026-09-24');
  assert.equal(moved('ArrowUp'), '2026-09-16');
  assert.equal(moved('ArrowDown'), '2026-09-30');
  assert.equal(moved('Home'), '2026-09-21');
  assert.equal(moved('End'), '2026-09-27');
  assert.equal(moved('PageUp'), '2026-08-23');
  assert.equal(moved('PageDown', true), '2027-09-23');
  assert.equal(moveFocus(from, 'a', false, 1), null);
  // With the week starting on Sunday, Home goes back to that Sunday
  assert.equal(toDay(moveFocus(from, 'Home', false, 0) ?? new Date(0)), '2026-09-20');
});

test('a month step keeps the day when it can and the last day when it cannot', () => {
  assert.equal(toDay(addMonths(day(2026, 1, 31), 1)), '2026-02-28');
  assert.equal(toDay(addMonths(day(2028, 1, 31), 1)), '2028-02-29');
  assert.equal(toDay(addMonths(day(2026, 12, 15), 1)), '2027-01-15');
});

test('days outside the bounds cannot be picked, and focus never leaves them', () => {
  assert.equal(outOfRange(day(2026, 9, 1), '2026-09-02'), true);
  assert.equal(outOfRange(day(2026, 9, 2), '2026-09-02', '2026-09-02'), false);
  assert.equal(outOfRange(day(2026, 9, 3), undefined, '2026-09-02'), true);
  assert.equal(outOfRange(day(2026, 9, 3)), false);
  assert.equal(toDay(clampDay(day(2026, 1, 1), '2026-09-02')), '2026-09-02');
  assert.equal(toDay(clampDay(day(2027, 1, 1), undefined, '2026-09-30')), '2026-09-30');
});
