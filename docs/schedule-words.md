---
created_at: 2026-09-25T12:00:00Z
updated_at: 2026-09-25T12:00:00Z
tags:
    - schedules
    - cron
    - i18n
    - decision
---
# A schedule's timetable in words

The Schedules page and the schedule form say a cron expression back in words ("At 09:00, on Monday
to Friday") so a person can check it means what they meant. The API's `SchedulePreview.description`
says it too, but only in English: the server has no UI language. Under Spanish the web showed that
English sentence.

## Decision

The web writes the sentence itself, in the UI language, and the API contract stays as it is.

- **One parser, one grammar.** `parseCron` moved from `packages/core/src/cron.ts` to
  `packages/shared/src/cron.ts`, next to `describeCronIn(spec, words)`, which decides which phrase
  applies (a single time, every hour, every N minutes, minute lists, hour ranges, weekday, day of the
  month and month runs, the macros). Core re-exports `parseCron` and keeps `describeCron` with its
  English words, so the API's text is byte for byte what it was. The web can never read an
  expression differently from the scheduler, because it runs the same code.
- **The words are the caller's** (`CronWords`). The web's are in `apps/web/src/lib/cron-words.ts`:
  sentences from `schedules:cron.*` in the locale files, weekday and month names from
  `Intl.DateTimeFormat` with `intlLocale()`.
- **The API still decides.** A description is shown only when the preview says the expression is
  valid; the error text and the next fires come from the API, which knows the time zones. The form's
  preview keeps showing the last answer while a new expression is being checked, so it describes the
  expression that answer is about, not the one being typed.

## Spanish

Spanish introduces a range differently from a list, so the words know whether a field's values hold a
range: "de lunes a viernes" but "cada lunes y miércoles"; "del 1 al 5 de cada mes" but "los días 1 y
15 de cada mes"; "de enero a marzo" but "en enero y julio". Hours take the article by number, which is
why the time phrases are plurals keyed on the hour: "A la 01:00", "A las 09:00".

English stays exactly as core writes it, and `apps/web/test/cron-words.test.ts` pins both languages
over the cases `packages/core/test/cron.test.ts` covers and more.
