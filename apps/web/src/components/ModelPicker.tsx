import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NARROW, useMediaQuery } from '@agentry/ui/lib/media';
import { ICON_SM } from '@agentry/ui/components/icons';
import { useModelOptions } from './ui';
import type { ComboboxOption } from '@agentry/ui/components/controls/Combobox';
import { LAYER_ATTR } from '@agentry/ui/components/controls/layer';
import { Sheet } from '@agentry/ui/components/controls/Sheet';

/** One model as the picker says it: the value a file stores, and the name the CLI gives it today. */
export interface ModelPick {
  value: string;
  /** "Sonnet 5" for `sonnet`; null where the CLI names it as it is typed, or not at all */
  resolved: string | null;
  hint?: ReactNode;
}

/**
 * The picker's rows: what the CLI offers, plus the current value when it offers no such model (an
 * agent file written by hand, a model the account lost), so opening the picker never drops it.
 */
export function modelPicks(options: ReadonlyArray<ComboboxOption>, value: string): ModelPick[] {
  const picks = options.map((option): ModelPick => {
    const label = typeof option.label === 'string' ? option.label.trim() : '';
    return {
      value: option.value,
      resolved: label && label.toLowerCase() !== option.value.toLowerCase() ? label : null,
      ...(option.hint ? { hint: option.hint } : {}),
    };
  });
  const current = value.trim();
  if (current && !picks.some((pick) => pick.value === current)) picks.push({ value: current, resolved: null });
  return picks;
}

/** The value as a tag, neutral (a model is a choice, not a state), then the name it resolves to. */
function PickFace({ pick }: { pick: ModelPick }) {
  return (
    <>
      <span className={`model-tag ${/opus/i.test(pick.value) ? 'is-opus' : ''}`.trim()}>{pick.value}</span>
      {pick.resolved && <span className="resolved ellipsis">{pick.resolved}</span>}
    </>
  );
}

/**
 * A model is picked with `.model-pick` everywhere (design system, decision 10): "[sonnet] Sonnet 5",
 * the alias the agent file stores as a tag and the model it runs today beside it. A list by the
 * button on a desktop, a sheet of 44 px rows on a phone. Filled from what the CLI offers the account
 * (`useModelOptions`) unless `options` is given.
 */
export function ModelPicker({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className = '',
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options?: ReadonlyArray<ComboboxOption>;
  /** Said when nothing is picked, e.g. "Por defecto" */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label': string;
}) {
  const offered = useModelOptions();
  const narrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const picks = modelPicks(options ?? offered, value);
  const current = picks.find((pick) => pick.value === value.trim()) ?? null;
  const face = current ? <PickFace pick={current} /> : <span className="model-pick-empty">{placeholder}</span>;

  if (narrow) {
    return (
      <>
        <button type="button" className={`model-pick ${className}`.trim()} aria-label={ariaLabel} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
          {face}
          <ChevronDown {...ICON_SM} className="ico" aria-hidden />
        </button>
        <Sheet open={open} onOpenChange={setOpen} title={ariaLabel} side="bottom">
          <div className="model-pick-sheet" role="listbox" aria-label={ariaLabel}>
            {picks.map((pick) => (
              <button
                key={pick.value}
                type="button"
                role="option"
                aria-selected={pick.value === current?.value}
                className="model-pick-option"
                onClick={() => {
                  setOpen(false);
                  onChange(pick.value);
                }}
              >
                <PickFace pick={pick} />
                {pick.value === current?.value && <Check {...ICON_SM} className="model-pick-check" aria-hidden />}
              </button>
            ))}
          </div>
        </Sheet>
      </>
    );
  }

  return (
    <RadixSelect.Root value={current?.value ?? ''} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger aria-label={ariaLabel} className={`model-pick ${className}`.trim()}>
        {face}
        <RadixSelect.Icon className="ico">
          <ChevronDown {...ICON_SM} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content {...LAYER_ATTR} className="menu select-menu model-pick-menu" position="popper" sideOffset={6} collisionPadding={8}>
          <RadixSelect.Viewport className="menu-viewport">
            {picks.map((pick) => (
              <RadixSelect.Item key={pick.value} value={pick.value} className="menu-item">
                <span className="menu-item-text">
                  <span className="model-pick-row">
                    <RadixSelect.ItemText>
                      <PickFace pick={pick} />
                    </RadixSelect.ItemText>
                  </span>
                  {pick.hint && <span className="menu-item-hint">{pick.hint}</span>}
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
