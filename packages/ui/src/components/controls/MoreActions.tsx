import { Check, ChevronDown, Ellipsis } from 'lucide-react';
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
  text,
}: {
  entries: MenuEntry[];
  label?: string;
  /** The sheet's heading; defaults to `label` */
  title?: string;
  align?: 'start' | 'center' | 'end';
  /** On the trigger, in both forms */
  className?: string;
  /** Turns the `⋯` into a labelled button, for a menu that says what it does ("Set all to…") */
  text?: string;
}) {
  const { t } = useTranslation('primitives');
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const name = label ?? t('menu.more');
  const labelled = text !== undefined;
  if (!narrow && !labelled) return <Menu entries={entries} label={name} align={align} className={className} />;
  if (!narrow)
    return (
      <Menu
        entries={entries}
        label={name}
        align={align}
        trigger={
          <button type="button" className={`btn btn-small ${className}`.trim()}>
            {text} <ChevronDown {...ICON_SM} />
          </button>
        }
      />
    );
  return (
    <>
      {labelled ? (
        <button type="button" className={`btn btn-small ${className}`.trim()} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {text} <ChevronDown {...ICON_SM} />
        </button>
      ) : (
        <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Ellipsis {...ICON_SM} />
        </button>
      )}
      <Sheet open={open} onOpenChange={setOpen} title={title ?? name} side="bottom">
        <div className="sheet-actions">
          {itemsOf(entries).map((item) => {
            const Icon = item.checked ? Check : item.icon;
            const className = `btn btn-block ${item.destructive ? 'btn-danger' : ''}`.trim();
            const content = (
              <>
                {Icon ? <Icon {...ICON_SM} /> : item.checked === false && <span className="sheet-action-gap" aria-hidden />}
                {item.label}
              </>
            );
            // A download stays a real link, as in the menu: the server answers with Content-Disposition
            if (item.href && !item.disabled)
              return (
                <a key={item.id} className={className} href={item.href} download={item.download} onClick={() => setOpen(false)}>
                  {content}
                </a>
              );
            return (
              <button
                key={item.id}
                type="button"
                className={className}
                disabled={item.disabled}
                title={item.disabled ? item.disabledReason : undefined}
                aria-pressed={item.checked}
                onClick={() => {
                  // The sheet closes before the action runs, so a confirmation is not stacked over it
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {content}
              </button>
            );
          })}
          {/* A finger has no hover to read a title by, so a disabled item's reason is written out */}
          {itemsOf(entries)
            .filter((item) => item.disabled && item.disabledReason)
            .map((item) => (
              <p key={`${item.id}-reason`} className="sheet-action-reason">
                {item.disabledReason}
              </p>
            ))}
        </div>
      </Sheet>
    </>
  );
}
