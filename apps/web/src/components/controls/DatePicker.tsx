import * as RadixPopover from '@radix-ui/react-popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { intlLocale } from '../../i18n/language';
import { addMonths, clampDay, firstDayOfWeek, monthGrid, moveFocus, outOfRange, parseDay, sameDay, toDay } from '../../lib/calendar';
import { ICON_SM } from '../icons';
import { LAYER_ATTR } from './layer';

/**
 * A day, typed as `YYYY-MM-DD` or picked from a calendar of Agentry's own (a native date input
 * looks different in every browser and ignores the theme). The calendar is the WAI-ARIA date
 * picker dialog: a grid with one focusable day, moved with the arrows, Home/End and Page Up/Down.
 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = 'YYYY-MM-DD',
  invalid,
  className = '',
  'aria-label': ariaLabel,
}: {
  /** `''` or `YYYY-MM-DD`; whatever the person is still typing is passed through as it is */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  'aria-label': string;
}) {
  const { t, i18n } = useTranslation('components');
  const [open, setOpen] = useState(false);
  const locale = intlLocale();
  const firstDay = useMemo(() => firstDayOfWeek(locale), [locale]);

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <div className={`date-picker ${className}`}>
        <RadixPopover.Anchor asChild>
          <input
            aria-label={ariaLabel}
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            aria-invalid={invalid || undefined}
            className={invalid ? 'is-invalid' : undefined}
            onChange={(e) => onChange(e.target.value.trim())}
            onKeyDown={(e) => {
              // The keyboard way in, since the button beside it is one more Tab away
              if (e.key === 'ArrowDown' && e.altKey) {
                e.preventDefault();
                setOpen(true);
              }
            }}
          />
        </RadixPopover.Anchor>
        <RadixPopover.Trigger asChild>
          <button type="button" className="icon-btn date-picker-button" aria-label={t('datePicker.open', { field: ariaLabel })}>
            <CalendarDays {...ICON_SM} />
          </button>
        </RadixPopover.Trigger>
      </div>
      <RadixPopover.Portal>
        <RadixPopover.Content
          {...LAYER_ATTR}
          className="date-picker-panel"
          role="dialog"
          aria-label={ariaLabel}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // The calendar puts focus on its own day once it has rendered
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Calendar
            key={i18n.language}
            value={value}
            min={min}
            max={max}
            locale={locale}
            firstDay={firstDay}
            onPick={(day) => {
              onChange(day);
              setOpen(false);
            }}
          />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

function Calendar({
  value,
  min,
  max,
  locale,
  firstDay,
  onPick,
}: {
  value: string;
  min?: string;
  max?: string;
  locale: string;
  firstDay: ReturnType<typeof firstDayOfWeek>;
  onPick: (day: string) => void;
}) {
  const { t } = useTranslation('components');
  const titleId = useId();
  const grid = useRef<HTMLTableElement>(null);
  const selected = parseDay(value);
  const today = new Date();
  // The focused day decides which month is on screen
  const [focused, setFocused] = useState(() => clampDay(selected ?? new Date(today.getFullYear(), today.getMonth(), today.getDate()), min, max));
  // Only a move made in the grid takes DOM focus with it; the month buttons keep theirs
  const [focusGrid, setFocusGrid] = useState(true);

  useEffect(() => {
    if (!focusGrid) return;
    grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${toDay(focused)}"]`)?.focus();
  }, [focused, focusGrid]);

  const monthTitle = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(focused);
  const dayName = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });
  const weeks = monthGrid(focused, firstDay);
  const weekdays = (weeks[0] ?? []).map((day) => ({
    short: new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(day),
    long: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(day),
  }));

  const showMonth = (months: number) => {
    setFocusGrid(false);
    setFocused((current) => clampDay(addMonths(current, months), min, max));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const next = moveFocus(focused, e.key, e.shiftKey, firstDay);
    if (!next) return;
    e.preventDefault();
    setFocusGrid(true);
    setFocused(clampDay(next, min, max));
  };

  return (
    <div className="date-picker-calendar">
      <div className="date-picker-head">
        <button type="button" className="icon-btn" aria-label={t('datePicker.previousMonth')} onClick={() => showMonth(-1)}>
          <ChevronLeft {...ICON_SM} />
        </button>
        <span id={titleId} className="date-picker-title" aria-live="polite">
          {monthTitle}
        </span>
        <button type="button" className="icon-btn" aria-label={t('datePicker.nextMonth')} onClick={() => showMonth(1)}>
          <ChevronRight {...ICON_SM} />
        </button>
      </div>
      <table ref={grid} role="grid" className="date-picker-grid" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {weekdays.map((day) => (
              <th key={day.long} scope="col" abbr={day.long}>
                {day.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={toDay(week[0] ?? focused)}>
              {week.map((day) => {
                const key = toDay(day);
                const isSelected = selected !== null && sameDay(day, selected);
                const disabled = outOfRange(day, min, max);
                return (
                  <td key={key} role="gridcell" aria-selected={isSelected}>
                    <button
                      type="button"
                      data-day={key}
                      tabIndex={sameDay(day, focused) ? 0 : -1}
                      aria-label={dayName.format(day)}
                      aria-current={sameDay(day, today) ? 'date' : undefined}
                      aria-disabled={disabled || undefined}
                      className={`date-picker-day${day.getMonth() !== focused.getMonth() ? ' is-outside' : ''}${isSelected ? ' is-selected' : ''}`}
                      onClick={() => {
                        if (disabled) return;
                        onPick(key);
                      }}
                    >
                      {day.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="date-picker-foot">
        <button
          type="button"
          className="btn btn-small"
          disabled={outOfRange(today, min, max)}
          onClick={() => onPick(toDay(today))}
        >
          {t('datePicker.today')}
        </button>
      </div>
    </div>
  );
}
