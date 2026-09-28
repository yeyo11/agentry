import * as RadixPopover from '@radix-ui/react-popover';
import { ChevronDown, Folder, ListFilter, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LAYER_ATTR } from '../../../components/controls/layer';
import { Sheet } from '../../../components/controls/Sheet';
import { Checkbox } from '../../../components/controls/Toggle';
import { ICON_SM } from '../../../components/icons';
import type { TaskFilters } from '../../../lib/work-items';
import type { TaskFilterState } from './useTaskFilters';

export interface FacetOption {
  value: string;
  label: string;
  /** A mark drawn before the label: a type's shape, a priority's bars, a monogram */
  mark?: ReactNode;
}

/** One facet of the toolbar: which filter it sets, its options, and whether it takes one value or several. */
export interface Facet {
  field: Extract<keyof TaskFilters, 'projects' | 'type' | 'priority' | 'labels' | 'assignee' | 'epicId' | 'milestoneId'>;
  label: string;
  options: FacetOption[];
  single?: boolean;
  icon?: ReactNode;
}

const valuesOf = (filters: TaskFilters, field: Facet['field']): string[] => {
  const value = filters[field];
  return Array.isArray(value) ? value : value ? [value] : [];
};

/** The change that toggles one option of a facet, as `useTaskFilters().set` takes it. */
function toggled(filters: TaskFilters, facet: Facet, value: string, on: boolean): Partial<TaskFilters> {
  if (facet.single) return { [facet.field]: on ? value : undefined };
  const now = new Set(valuesOf(filters, facet.field));
  if (on) now.add(value);
  else now.delete(value);
  return { [facet.field]: now.size ? [...now] : undefined };
}

/** The chosen values of a facet named as their labels, for "Epic: Project ecosystem". */
function chosenNames(facet: Facet, values: string[]): string {
  return values.map((value) => facet.options.find((option) => option.value === value)?.label ?? value).join(', ');
}

/**
 * The search box, which `/` focuses from anywhere on the page. It writes to the address a moment
 * after the typing stops, so every key does not refetch the board.
 */
export function SearchField({ state, short = false }: { state: TaskFilterState; short?: boolean }) {
  const { t } = useTranslation('tasks');
  const [text, setText] = useState(state.filters.q ?? '');
  const input = useRef<HTMLInputElement>(null);
  const { set } = state;
  const q = state.filters.q ?? '';

  // The address wins when it changes from elsewhere (a link, the back button, "Clear all")
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = window.setTimeout(() => set({ q: text.trim() || undefined }), 250);
    return () => window.clearTimeout(timer);
  }, [text, q, set]);

  useEffect(() => {
    if (short) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [short]);

  return (
    <label className={`list-toolbar-search workitem-search ${short ? 'is-phone' : ''}`.trim()}>
      <Search {...ICON_SM} aria-hidden />
      <input ref={input} type="search" value={text} placeholder={short ? t('toolbar.searchShort') : t('toolbar.search')} aria-label={t('toolbar.searchLabel')} onChange={(event) => setText(event.target.value)} />
      {!short && (
        <kbd className="list-toolbar-kbd" aria-hidden>
          /
        </kbd>
      )}
    </label>
  );
}

/** The desktop's row of facet chips: each opens its options, and a chip with a choice says it and can be taken off. */
export function FacetChips({ facets, state }: { facets: Facet[]; state: TaskFilterState }) {
  const { t } = useTranslation('tasks');
  return (
    <>
      {facets.map((facet) => {
        const values = valuesOf(state.filters, facet.field);
        const on = values.length > 0;
        const text = on ? t('toolbar.chip', { facet: facet.label, values: chosenNames(facet, values) }) : facet.label;
        return (
          <span key={facet.field} className={`workitem-facet ${on ? 'is-on' : ''}`.trim()}>
            <RadixPopover.Root>
              <RadixPopover.Trigger asChild>
                <button type="button" className={`chip ${on ? 'chip-on' : ''}`.trim()} aria-haspopup="dialog">
                  {facet.icon}
                  <span className="workitem-facet-text">{text}</span>
                  {!on && <ChevronDown size={13} strokeWidth={1.75} aria-hidden />}
                </button>
              </RadixPopover.Trigger>
              <RadixPopover.Portal>
                <RadixPopover.Content className="popover workitem-facet-pop" align="start" sideOffset={6} collisionPadding={8} aria-label={facet.label} {...LAYER_ATTR}>
                  <FacetOptions facet={facet} state={state} />
                </RadixPopover.Content>
              </RadixPopover.Portal>
            </RadixPopover.Root>
            {on && (
              <button type="button" className="workitem-facet-x" aria-label={t('toolbar.remove', { filter: text })} onClick={() => state.set({ [facet.field]: undefined })}>
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

function FacetOptions({ facet, state }: { facet: Facet; state: TaskFilterState }) {
  const { t } = useTranslation('tasks');
  const values = valuesOf(state.filters, facet.field);
  if (facet.options.length === 0) return <p className="workitem-facet-none">{t('toolbar.noOptions')}</p>;
  return (
    <div className="workitem-facet-options" role="group" aria-label={facet.label}>
      {facet.options.map((option) => (
        <Checkbox key={option.value} className="check workitem-facet-option" checked={values.includes(option.value)} onChange={(on) => state.set(toggled(state.filters, facet, option.value, on))}>
          {option.mark}
          <span className="workitem-facet-label">{option.label}</span>
        </Checkbox>
      ))}
    </div>
  );
}

/**
 * The phone's filters: one button that says how many are on, opening a sheet with every facet as a
 * row of pressed chips, "Clear all", and "Show N tasks" to close it on the result.
 */
export function FilterSheetButton({ facets, state, shown }: { facets: Facet[]; state: TaskFilterState; shown: number }) {
  const { t } = useTranslation('tasks');
  const [open, setOpen] = useState(false);
  const count = state.facets;
  const name = count > 0 ? t('toolbar.filtersOn', { count }) : t('toolbar.filters');
  return (
    <>
      <button type="button" className="btn icon-btn workitem-filter-btn" aria-label={name} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <ListFilter {...ICON_SM} />
        {count > 0 && (
          <span className="workitem-filter-count" aria-hidden>
            {count}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t('toolbar.filters')}
        side="bottom"
        className="workitem-filter-sheet"
        footer={
          <button type="button" className="btn btn-primary btn-block" onClick={() => setOpen(false)}>
            {t('toolbar.show', { count: shown })}
          </button>
        }
      >
        {count > 0 && (
          <button type="button" className="link-btn workitem-filter-clear" onClick={() => state.set(Object.fromEntries(facets.map((facet) => [facet.field, undefined])))}>
            {t('toolbar.clearAll')}
          </button>
        )}
        {facets.map((facet) => {
          const values = valuesOf(state.filters, facet.field);
          return (
            <fieldset key={facet.field} className="workitem-filter-group">
              <legend className="facet-legend">{facet.label}</legend>
              <div className="workitem-filter-chips">
                {facet.options.length === 0 && <span className="workitem-facet-none">{t('toolbar.noOptions')}</span>}
                {facet.options.map((option) => {
                  const on = values.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`chip workitem-filter-chip ${on ? 'chip-on' : ''}`.trim()}
                      aria-pressed={on}
                      onClick={() => state.set(toggled(state.filters, facet, option.value, !on))}
                    >
                      {option.mark}
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </Sheet>
    </>
  );
}

/** Under the phone's search: the filters in force as chips to take off, and what they leave. */
export function ActiveFilterChips({ facets, state, summary }: { facets: Facet[]; state: TaskFilterState; summary?: ReactNode }) {
  const { t } = useTranslation('tasks');
  const on = facets.filter((facet) => valuesOf(state.filters, facet.field).length > 0);
  if (on.length === 0) return null;
  return (
    <div className="workitem-active-filters" role="group" aria-label={t('toolbar.active')}>
      {on.map((facet) => {
        const text = t('toolbar.chip', { facet: facet.label, values: chosenNames(facet, valuesOf(state.filters, facet.field)) });
        return (
          <button key={facet.field} type="button" className="filter-chip" aria-label={t('toolbar.remove', { filter: text })} onClick={() => state.set({ [facet.field]: undefined })}>
            <span>{text}</span>
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        );
      })}
      {summary && <span className="workitem-active-summary mono">{summary}</span>}
    </div>
  );
}

export const ProjectFacetIcon = () => <Folder size={13} strokeWidth={1.75} aria-hidden />;
