import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { Check, Ellipsis, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '../icons';
import { LAYER_ATTR } from './layer';

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Reads as a destructive action and is coloured as one */
  destructive?: boolean;
  /**
   * Not available now. The item stays focusable so its reason can be read: an action that has
   * disappeared is harder to understand than one that says why it cannot be used.
   */
  disabled?: boolean;
  disabledReason?: string;
  /** Turns the item into a checkbox item */
  checked?: boolean;
  /** The keyboard shortcut that does the same thing, shown in mono on the right */
  shortcut?: string;
  /** Makes the item a real link, e.g. a download the server answers with Content-Disposition */
  href?: string;
  download?: boolean;
}

export interface MenuGroup {
  id: string;
  label?: string;
  items: MenuItem[];
}

export type MenuEntry = MenuItem | MenuGroup | { id: string; separator: true };

const isSeparator = (entry: MenuEntry): entry is { id: string; separator: true } => 'separator' in entry;
const isGroup = (entry: MenuEntry): entry is MenuGroup => 'items' in entry;

/**
 * The menu behind a `⋯`: where everything a page used to spell out in a row of buttons goes. Built
 * on Radix's dropdown menu, so it is one tab stop, the arrows move inside it, typing jumps to an
 * item and Escape closes it back onto its trigger.
 */
export function Menu({
  entries,
  label,
  trigger,
  align = 'end',
  side = 'bottom',
  className = '',
}: {
  entries: MenuEntry[];
  /** Names the trigger when it is the default `⋯` button, and the menu itself always */
  label?: string;
  /** Replaces the default `⋯` button; it is rendered as the trigger itself */
  trigger?: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const name = label ?? t('menu.more');
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>
        {trigger ?? (
          <button type="button" className={`icon-btn ${className}`.trim()} aria-label={name}>
            <Ellipsis {...ICON_SM} />
          </button>
        )}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu menu-dropdown" side={side} align={align} sideOffset={6} collisionPadding={8} aria-label={name} {...LAYER_ATTR}>
          {entries.map((entry) => {
            if (isSeparator(entry)) return <RadixMenu.Separator key={entry.id} className="menu-sep" />;
            if (isGroup(entry))
              return (
                <RadixMenu.Group key={entry.id} className="menu-group">
                  {entry.label && <RadixMenu.Label className="menu-group-label">{entry.label}</RadixMenu.Label>}
                  {entry.items.map((item) => (
                    <Item key={item.id} item={item} />
                  ))}
                </RadixMenu.Group>
              );
            return <Item key={entry.id} item={entry} />;
          })}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

function Item({ item }: { item: MenuItem }) {
  const Icon = item.icon;
  const classes = `menu-item ${item.destructive ? 'is-destructive' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim();
  const body = (
    <>
      {Icon ? <Icon {...ICON_SM} className="menu-item-icon" /> : item.checked !== undefined && <Check {...ICON_SM} className={`menu-item-icon ${item.checked ? '' : 'is-off'}`} />}
      <span className="menu-item-text">
        <span>{item.label}</span>
        {item.disabled && item.disabledReason && <span className="menu-item-why">{item.disabledReason}</span>}
      </span>
      {item.shortcut && (
        <span className="menu-item-key" aria-hidden>
          {item.shortcut}
        </span>
      )}
    </>
  );
  // Radix skips a `disabled` item entirely; keeping it selectable-but-inert is what lets someone
  // reach it and hear why it is off.
  if (item.disabled)
    return (
      <RadixMenu.Item className={classes} aria-disabled onSelect={(event) => event.preventDefault()}>
        {body}
      </RadixMenu.Item>
    );
  if (item.href)
    return (
      <RadixMenu.Item className={classes} asChild onSelect={() => item.onSelect?.()}>
        <a href={item.href} download={item.download || undefined}>
          {body}
        </a>
      </RadixMenu.Item>
    );
  if (item.checked !== undefined)
    return (
      <RadixMenu.CheckboxItem className={classes} checked={item.checked} onCheckedChange={() => item.onSelect?.()}>
        {body}
      </RadixMenu.CheckboxItem>
    );
  return (
    <RadixMenu.Item className={classes} onSelect={() => item.onSelect?.()}>
      {body}
    </RadixMenu.Item>
  );
}
