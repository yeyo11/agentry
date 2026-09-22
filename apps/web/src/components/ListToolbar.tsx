import * as RadixPopover from '@radix-ui/react-popover';
import { ListFilter, Search, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NARROW, useMediaQuery } from '../lib/media';
import { LAYER_ATTR } from './controls/layer';
import { Select } from './controls/Select';
import { Sheet } from './controls/Sheet';
import { ICON_SM } from './icons';
import { Segmented } from './ui';

export interface ListToolbarTab<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** What the tab means, when its label alone does not say it */
  title?: string;
}

export interface ListFilterChip {
  id: string;
  /** Reads as "Origin: Terminal", so it says which facet it belongs to */
  label: string;
  onRemove: () => void;
}

/**
 * The one bar every list page wears: search, the state tabs with their counts, the filters behind a
 * button that says how many are on, a sort, and the filters in force as chips you can take off.
 * What the filters are is the caller's business — it passes the facet sections as children — and so
 * is where the state lives, usually the URL.
 */
export function ListToolbar<T extends string>({
  search,
  tabs,
  filters,
  sort,
  chips = [],
  onReset,
  actions,
  className = '',
}: {
  search?: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string };
  tabs?: { value: T; options: ReadonlyArray<ListToolbarTab<T>>; onChange: (id: T) => void; label: string };
  /** `count` is what the button shows; `children` are the facet sections, in the popover or sheet */
  filters?: { count: number; children: ReactNode; title?: string };
  sort?: { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void; label?: string };
  chips?: ReadonlyArray<ListFilterChip>;
  onReset?: () => void;
  /** Page actions that belong on the same line, at the end */
  actions?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const filterName = filters && filters.count > 0 ? t('toolbar.filtersActive', { count: filters.count }) : t('toolbar.filters');

  // The same button either way: a popover's trigger clones its props onto it, and the sheet's copy
  // opens the sheet itself, so neither ends up as a click handler on something that is not a button.
  const filterButton = (onClick?: () => void) => (
    <button type="button" className={`btn btn-small list-toolbar-filters ${filters && filters.count > 0 ? 'is-on' : ''}`.trim()} aria-label={filterName} onClick={onClick}>
      <ListFilter {...ICON_SM} />
      <span>{t('toolbar.filters')}</span>
      {filters && filters.count > 0 && (
        <span className="list-toolbar-count" aria-hidden>
          {filters.count}
        </span>
      )}
    </button>
  );

  return (
    <div className={`list-toolbar ${className}`.trim()}>
      <div className="list-toolbar-row">
        {tabs && (
          <Segmented
            value={tabs.value}
            label={tabs.label}
            onChange={tabs.onChange}
            options={tabs.options.map((tab) => ({
              value: tab.id,
              ...(tab.title ? { title: tab.title } : {}),
              label: (
                <>
                  {tab.label}
                  {tab.count !== undefined && <span className="segment-count">{tab.count}</span>}
                </>
              ),
            }))}
          />
        )}
        {search && (
          <label className="list-toolbar-search">
            <Search {...ICON_SM} aria-hidden />
            <input
              type="search"
              value={search.value}
              placeholder={search.placeholder ?? t('toolbar.search')}
              aria-label={search.label ?? t('toolbar.searchLabel')}
              onChange={(event) => search.onChange(event.target.value)}
            />
          </label>
        )}
        {filters &&
          (narrow ? (
            <>
              {filterButton(() => setOpen(true))}
              <Sheet open={open} onOpenChange={setOpen} title={filters.title ?? t('toolbar.filters')}>
                {filters.children}
              </Sheet>
            </>
          ) : (
            <RadixPopover.Root open={open} onOpenChange={setOpen}>
              <RadixPopover.Trigger asChild>{filterButton()}</RadixPopover.Trigger>
              <RadixPopover.Portal>
                <RadixPopover.Content className="popover list-toolbar-popover" align="start" sideOffset={6} collisionPadding={8} {...LAYER_ATTR}>
                  {filters.children}
                </RadixPopover.Content>
              </RadixPopover.Portal>
            </RadixPopover.Root>
          ))}
        {sort && (
          <Select
            value={sort.value}
            onChange={sort.onChange}
            options={sort.options.map((option) => ({ value: option.value, label: option.label }))}
            aria-label={sort.label ?? t('toolbar.sort')}
            className="list-toolbar-sort"
          />
        )}
        {actions && <div className="list-toolbar-actions">{actions}</div>}
      </div>
      {chips.length > 0 && (
        <div className="list-toolbar-chips" aria-label={t('toolbar.activeFilters')} role="group">
          {chips.map((chip) => (
            <button key={chip.id} type="button" className="filter-chip" onClick={chip.onRemove} aria-label={t('toolbar.removeFilter', { filter: chip.label })}>
              <span>{chip.label}</span>
              <X size={12} strokeWidth={2} aria-hidden />
            </button>
          ))}
          {onReset && (
            <button type="button" className="link-btn" onClick={onReset}>
              {t('toolbar.reset')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
