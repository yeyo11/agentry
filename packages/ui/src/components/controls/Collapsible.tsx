import * as RadixCollapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Disclosure section (replaces <details>/<summary>). `className` styles the root (`fold`,
 * `section`, `env-group`…); the header is a button with a rotating chevron, the body animates.
 */
export function Collapsible({
  title,
  children,
  className = '',
  triggerClassName = '',
  defaultOpen,
  open,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixCollapsible.Root className={`collapsible ${className}`} defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange}>
      <RadixCollapsible.Trigger className={`collapsible-trigger ${triggerClassName}`}>
        <ChevronRight size={14} strokeWidth={2.2} aria-hidden className="collapsible-chevron" />
        {title}
      </RadixCollapsible.Trigger>
      <RadixCollapsible.Content className="collapsible-content">{children}</RadixCollapsible.Content>
    </RadixCollapsible.Root>
  );
}
