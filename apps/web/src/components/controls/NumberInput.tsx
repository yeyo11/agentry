import { Minus, Plus } from 'lucide-react';

const clamp = (n: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

/**
 * Number field with −/+ steppers. `undefined` means empty; typing is not clamped (so the user can
 * type through intermediate values), the steppers are.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
  disabled,
  compact,
  'aria-label': ariaLabel,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Smaller variant for dense rows */
  compact?: boolean;
  'aria-label'?: string;
}) {
  const nudge = (direction: 1 | -1) => onChange(clamp((value ?? min ?? 0) + direction * step, min, max));
  return (
    <div className={`number-input ${compact ? 'number-input-compact' : ''}`}>
      <button
        type="button"
        className="number-step"
        tabIndex={-1}
        aria-label="Decrease"
        disabled={disabled || (value !== undefined && min !== undefined && value <= min)}
        onClick={() => nudge(-1)}
      >
        <Minus size={13} strokeWidth={2} aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      <button
        type="button"
        className="number-step"
        tabIndex={-1}
        aria-label="Increase"
        disabled={disabled || (value !== undefined && max !== undefined && value >= max)}
        onClick={() => nudge(1)}
      >
        <Plus size={13} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
