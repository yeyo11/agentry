import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON_SM } from '../icons';
import { LAYER_ATTR } from './layer';

// Radix reserves the empty string to clear the selection, so "" options travel under this value
const EMPTY = '__empty__';
const encode = (value: string) => (value === '' ? EMPTY : value);
const decode = (value: string) => (value === EMPTY ? '' : value);

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Secondary line shown in the menu only */
  hint?: ReactNode;
  disabled?: boolean;
}

/** Themed replacement for a native <select>. `""` is a valid option value (e.g. "Default"). */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = '',
  id,
  invalid,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  invalid?: boolean;
  'aria-label'?: string;
}) {
  return (
    <RadixSelect.Root value={encode(value)} onValueChange={(v) => onChange(decode(v) as T)} disabled={disabled}>
      <RadixSelect.Trigger id={id} aria-label={ariaLabel} className={`select-trigger ${invalid ? 'is-invalid' : ''} ${className}`}>
        <span className="select-value">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon className="select-chevron">
          <ChevronDown {...ICON_SM} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content {...LAYER_ATTR} className="menu select-menu" position="popper" sideOffset={6} collisionPadding={8}>
          <RadixSelect.Viewport className="menu-viewport">
            {options.map((option) => (
              <RadixSelect.Item key={option.value} value={encode(option.value)} disabled={option.disabled} className="menu-item">
                <span className="menu-item-text">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.hint && <span className="menu-item-hint">{option.hint}</span>}
                </span>
                <RadixSelect.ItemIndicator className="menu-item-check">
                  <Check {...ICON_SM} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
