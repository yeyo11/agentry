import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { COARSE, NARROW, useMediaQuery } from '../../lib/media';
import { ICON } from '../icons';
import { LAYER_ATTR } from './layer';

/** How far the sheet has to be pulled down before letting go dismisses it instead of springing back. */
const DISMISS_AFTER_PX = 96;

/**
 * The same panel in the two shapes a screen asks for: a sheet up from the bottom edge on a phone,
 * a panel in from the side on a desktop. Radix's dialog does the modal work — focus trapped inside,
 * Escape and the scrim close it, focus back on the opener — and on a touch screen the bottom sheet
 * can also be pushed away with a finger.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = 'auto',
  className = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** A line under the title; also what a screen reader hears as the panel's description */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** `auto` is a bottom sheet on a narrow screen and a side panel on a wide one */
  side?: 'auto' | 'bottom' | 'right';
  className?: string;
}) {
  const { t } = useTranslation('primitives');
  const narrow = useMediaQuery(NARROW);
  const touch = useMediaQuery(COARSE);
  const edge = side === 'auto' ? (narrow ? 'bottom' : 'right') : side;
  const [drag, setDrag] = useState(0);
  const from = useRef<number | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (edge !== 'bottom' || !touch) return;
    from.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (from.current === null) return;
    setDrag(Math.max(0, event.clientY - from.current));
  };
  const onPointerUp = () => {
    if (from.current === null) return;
    const travelled = drag;
    from.current = null;
    setDrag(0);
    if (travelled > DISMISS_AFTER_PX) onOpenChange(false);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="sheet-scrim" />
        <RadixDialog.Content
          className={`sheet sheet-${edge} ${className}`.trim()}
          style={drag ? { transform: `translateY(${drag}px)` } : undefined}
          {...LAYER_ATTR}
        >
          {edge === 'bottom' && touch && (
            <div className="sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} aria-hidden />
          )}
          <div className="sheet-head">
            <div className="sheet-head-text">
              <RadixDialog.Title className="sheet-title">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="sheet-description">{description}</RadixDialog.Description> : <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>}
            </div>
            <RadixDialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={t('sheet.close')}>
                <X {...ICON} />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="sheet-body">{children}</div>
          {footer && <div className="sheet-foot">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
