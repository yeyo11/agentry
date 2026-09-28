import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { ICON_SM } from '../../../components/icons';

/** A field's trigger in the dialog: the app's select look, with the value drawn as the board draws it. */
export function FieldButton({ label, children, ...rest }: { label: string; children: ReactNode } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return (
    <button type="button" {...rest} className="select-trigger newtask-select">
      <span className="sr-only">{label}: </span>
      <span className="select-value newtask-select-value">{children}</span>
      <ChevronDown {...ICON_SM} className="select-chevron" />
    </button>
  );
}

/** A phone cell: its name, its value, and the chevron of a cell that opens a choice. */
export function Cell({ label, children, ...rest }: { label: string; children: ReactNode } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return (
    <button type="button" {...rest} className="newtask-cell">
      <span className="newtask-cell-key">{label}</span>
      <span className="newtask-cell-value">{children}</span>
      <ChevronRight {...ICON_SM} className="newtask-cell-chevron" />
    </button>
  );
}
