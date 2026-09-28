import { Check } from 'lucide-react';
import { cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import { Menu, Sheet } from '../../../components/controls';
import { ICON_SM } from '../../../components/icons';
import { NARROW, useMediaQuery } from '../../../lib/media';

export interface PickerOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Why it cannot be picked, said beside it rather than hiding it */
  reason?: string;
}

/**
 * One field of a work item picked in place: a menu by the field on a desktop, a sheet of big
 * buttons on a phone, where a dropdown's rows are too small for a finger (design system, "⋯ menus
 * as a Sheet"). `trigger` is the button that shows the current value; it opens either form.
 */
export function Picker<T extends string>({
  label,
  value,
  options,
  onPick,
  trigger,
  align = 'start',
}: {
  /** Names the menu or the sheet */
  label: string;
  value: T | null;
  options: ReadonlyArray<PickerOption<T>>;
  onPick: (value: T) => void;
  trigger: ReactElement;
  align?: 'start' | 'end';
}) {
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const pick = (next: T) => next !== value && onPick(next);
  if (!narrow) {
    return (
      <Menu
        label={label}
        align={align}
        trigger={trigger}
        entries={options.map((option) => ({
          id: option.value,
          label: option.label,
          checked: option.value === value,
          disabled: option.disabled,
          disabledReason: option.reason,
          onSelect: () => pick(option.value),
        }))}
      />
    );
  }
  return (
    <>
      {cloneElement(trigger as ReactElement<Record<string, unknown>>, { onClick: () => setOpen(true), 'aria-haspopup': 'dialog' })}
      <Sheet open={open} onOpenChange={setOpen} title={label} side="bottom">
        <div className="sheet-actions workitem-picker">
          {options.map((option) => {
            const on = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className="btn btn-block workitem-picker-option"
                aria-pressed={on}
                disabled={option.disabled}
                onClick={() => {
                  setOpen(false);
                  pick(option.value);
                }}
              >
                <span className="workitem-picker-label">{option.label}</span>
                {option.disabled && option.reason && <span className="workitem-picker-why">{option.reason}</span>}
                {on && <Check {...ICON_SM} />}
              </button>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
