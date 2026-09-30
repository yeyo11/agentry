import * as RadixTooltip from '@radix-ui/react-tooltip';
import { useState, type ReactElement, type ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * Themed tooltip for interactive elements. The child must accept a ref (native elements do).
 * Empty content keeps it closed without changing the tree, so a conditional hint never remounts
 * the child (an input would lose focus mid-typing).
 */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const [open, setOpen] = useState(false);
  const empty = content === undefined || content === null || content === false || content === '';
  return (
    <RadixTooltip.Root open={open && !empty} onOpenChange={setOpen}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
