import * as RadixPopover from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '../icons';
import { LAYER_ATTR } from './layer';

export interface ComboboxOption {
  value: string;
  /** Shown in the list instead of the value */
  label?: ReactNode;
  hint?: ReactNode;
}

/**
 * Free-text input with a themed suggestion list (replaces <input list> + <datalist>). Focus stays
 * in the input; the list is driven with the arrow keys, Enter picks and Escape closes.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  autoFocus,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<ComboboxOption>;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const { t } = useTranslation('components');
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Show everything while the text is empty or still equals a suggestion; filter once the user types
  const needle = value.trim().toLowerCase();
  const exact = options.some((o) => o.value === value);
  const matches = !needle || exact ? options : options.filter((o) => o.value.toLowerCase().includes(needle));
  const shown = open && matches.length > 0;

  const pick = (option: ComboboxOption) => {
    onChange(option.value);
    setOpen(false);
    setActive(-1);
  };

  return (
    <RadixPopover.Root open={shown} onOpenChange={(next) => !next && setOpen(false)}>
      <RadixPopover.Anchor asChild>
        <input
          ref={inputRef}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          className={className}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!shown) return setOpen(true);
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) => (i + step + matches.length) % matches.length);
            } else if (e.key === 'Enter' && shown && active >= 0 && matches[active]) {
              e.preventDefault();
              pick(matches[active]);
            } else if (e.key === 'Escape' && shown) {
              setOpen(false);
            }
          }}
        />
      </RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          {...LAYER_ATTR}
          className="menu combobox-menu"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Clicks on the input itself are not "outside"
          onInteractOutside={(e) => e.target === inputRef.current && e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="menu-viewport" role="listbox" id={listId} aria-label={ariaLabel ?? placeholder ?? t('combobox.suggestions')}>
            {matches.map((option, i) => (
              <div
                key={option.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={option.value === value}
                data-highlighted={i === active ? '' : undefined}
                className="menu-item"
                // Keep focus in the input: picking must not blur it first
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(option)}
              >
                <span className="menu-item-text">
                  <span>{option.label ?? option.value}</span>
                  {option.hint && <span className="menu-item-hint">{option.hint}</span>}
                </span>
                {option.value === value && <Check {...ICON_SM} className="menu-item-check" />}
              </div>
            ))}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
