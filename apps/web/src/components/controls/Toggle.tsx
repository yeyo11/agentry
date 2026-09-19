import * as RadixCheckbox from '@radix-ui/react-checkbox';
import * as RadixSwitch from '@radix-ui/react-switch';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip } from './Tooltip';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label; clicking it toggles the control */
  children?: ReactNode;
  /** Accessible name when there is no visible label */
  'aria-label'?: string;
  tooltip?: ReactNode;
  disabled?: boolean;
  /** Class of the wrapping <label>; defaults to `check` */
  className?: string;
}

/** Checkbox for filters and multi-choice lists. */
export function Checkbox({ checked, onChange, children, tooltip, disabled, className = 'check', 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <Tooltip content={tooltip}>
      <label className={`${className} ${disabled ? 'is-disabled' : ''}`}>
        <RadixCheckbox.Root
          className="checkbox"
          checked={checked}
          onCheckedChange={(v) => onChange(v === true)}
          disabled={disabled}
          aria-label={ariaLabel}
        >
          <RadixCheckbox.Indicator className="checkbox-indicator">
            <Check size={11} strokeWidth={3} aria-hidden />
          </RadixCheckbox.Indicator>
        </RadixCheckbox.Root>
        {children}
      </label>
    </Tooltip>
  );
}

/** On/off switch for settings that take effect as a whole. */
export function Switch({ checked, onChange, children, tooltip, disabled, className = 'check', 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <Tooltip content={tooltip}>
      <label className={`${className} ${disabled ? 'is-disabled' : ''}`}>
        <RadixSwitch.Root className="switch" checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={ariaLabel}>
          <RadixSwitch.Thumb className="switch-thumb" />
        </RadixSwitch.Root>
        {children}
      </label>
    </Tooltip>
  );
}
