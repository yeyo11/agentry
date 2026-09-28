/**
 * The modal surfaces open now (dialogs, the phone's full screens), in the order they opened. Only
 * the one on top hears the keyboard: each used to listen on `document` in the capture phase, where
 * the first one registered runs first and `stopPropagation` does not stop the others on the same
 * node, so Escape in a dialog opened from the item panel closed the panel too.
 */

export type ModalKeyHandler = (event: KeyboardEvent) => void;

type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface ModalStack {
  /** Puts a surface on top; the function it returns takes it off, wherever it is by then */
  push: (handler: ModalKeyHandler) => () => void;
  readonly size: number;
}

/** One listener on `target` for the whole stack, there only while something is open. */
export function createModalStack(target: KeyTarget): ModalStack {
  const handlers: ModalKeyHandler[] = [];
  const onKey = (event: Event) => handlers[handlers.length - 1]?.(event as KeyboardEvent);
  return {
    push(handler) {
      if (handlers.length === 0) target.addEventListener('keydown', onKey, true);
      handlers.push(handler);
      return () => {
        const at = handlers.lastIndexOf(handler);
        if (at < 0) return;
        handlers.splice(at, 1);
        if (handlers.length === 0) target.removeEventListener('keydown', onKey, true);
      };
    },
    get size() {
      return handlers.length;
    },
  };
}

let shared: ModalStack | null = null;

/** The page's stack, on `document`, made on first use so importing this module needs no DOM. */
export function modalStack(): ModalStack {
  shared ??= createModalStack(document);
  return shared;
}
