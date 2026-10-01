import { useMemo, type ComponentProps } from 'react';
import { useOverview } from '../api';
import { Combobox, type ComboboxOption } from '@agentry/ui/components/controls/Combobox';

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

const NO_MODELS: ComboboxOption[] = [];

/**
 * The models to offer: what the CLI says this account may run (`SystemInfo.models`, read from the
 * CLI's own state file), with its names and the line it shows under each. The ones it names but
 * cannot run are left out — a suggestion nobody can pick is a trap. The provider's catalog starts
 * with its aliases, so nothing is offered until the overview has been read.
 */
export function useModelOptions(): ComboboxOption[] {
  const models = useOverview().data?.system.models;
  return useMemo(
    () =>
      models && models.length > 0
        ? models.filter((model) => !model.disabled).map((model) => ({ value: model.value, label: model.label ?? model.value, hint: model.description }))
        : NO_MODELS,
    [models],
  );
}

/** A model <Combobox>, filled from what the CLI offers; everything else is the Combobox's own. */
export function ModelCombobox(props: Omit<ComponentProps<typeof Combobox>, 'options'>) {
  return <Combobox {...props} options={useModelOptions()} />;
}
