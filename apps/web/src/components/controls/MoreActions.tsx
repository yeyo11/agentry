import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NARROW, useMediaQuery } from '../../lib/media';
import { ICON_SM } from '../icons';
import { Menu, type MenuEntry, type MenuItem } from './Menu';
import { Sheet } from './Sheet';

/** A sheet is a column of big buttons: groups lose their heading and separators their line. */
function itemsOf(entries: MenuEntry[]): MenuItem[] {
  return entries.flatMap((entry) => ('separator' in entry ? [] : 'items' in entry ? entry.items : [entry]));
}

/**
 * The `⋯` of a card or a page: a menu by the button on a desktop, a sheet of big buttons from the
 * bottom on a phone, where a dropdown's rows are too small for a finger. Both open from the same
 * button, named by `label`.
 */
export function MoreActions({
  entries,
  label,
  title,
  align = 'end',
  className = '',
}: {
  entries: MenuEntry[];
  label?: string;
  /** The sheet's heading; defaults to `label` */
  title?: string;
  align?: 'start' | 'center' | 'end';
  /** On the trigger, in both forms */
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const name = label ?? t('menu.more');
  if (!narrow) return <Menu entries={entries} label={name} align={align} className={className} />;
  return (
    <>
      <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Ellipsis {...ICON_SM} />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={title ?? name} side="bottom">
        <div className="sheet-actions">
          {itemsOf(entries).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`btn btn-block ${item.destructive ? 'btn-danger' : ''}`.trim()}
                disabled={item.disabled}
                title={item.disabled ? item.disabledReason : undefined}
                onClick={() => {
                  // The sheet closes before the action runs, so a confirmation is not stacked over it
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {Icon && <Icon {...ICON_SM} />}
                {item.label}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
