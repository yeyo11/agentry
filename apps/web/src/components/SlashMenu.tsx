import * as RadixPopover from '@radix-ui/react-popover';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactElement, type RefObject, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { applyCommand, commandNames, matchCommands, slashQuery } from '../lib/slash-commands';
import { LAYER_ATTR } from './controls/layer';

export interface SlashMenuState {
  open: boolean;
  listId: string;
  matches: string[];
  active: number;
  skills: ReadonlySet<string>;
  setActive: (index: number) => void;
  pick: (name: string) => void;
  dismiss: () => void;
  /** Spread on the textarea: what it tells assistive tech, and the caret the menu follows */
  inputProps: {
    'aria-autocomplete': 'list';
    'aria-controls': string | undefined;
    'aria-activedescendant': string | undefined;
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
    onInput: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  };
  /** Runs first in the textarea's `onKeyDown`; true when the key was the menu's */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * The list of commands a message box offers while its first word starts with `/`. Focus stays in
 * the box: the arrow keys move through the list, Enter or Tab picks, Escape closes it until the
 * text changes. Enter on a command already typed in full is left to the box, which sends it.
 */
export function useSlashMenu({
  text,
  setText,
  commands,
  skills = [],
  box,
}: {
  text: string;
  setText: (text: string) => void;
  commands: readonly string[];
  skills?: readonly string[];
  box: RefObject<HTMLTextAreaElement | null>;
}): SlashMenuState {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const names = useMemo(() => commandNames(commands), [commands]);
  const skillSet = useMemo(() => new Set(commandNames(skills)), [skills]);
  const query = slashQuery(text, caret);
  const matches = useMemo(() => (query === null ? [] : matchCommands(names, query)), [names, query]);
  const open = matches.length > 0 && dismissed !== text;
  const index = Math.min(active, matches.length - 1);

  // A new query starts at the top of what it matches
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, index, listId]);

  const pick = (name: string) => {
    const next = applyCommand(text, name);
    setText(next.text);
    setCaret(next.caret);
    // After React has put the new text in the box, or the caret lands at the end of the old one
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const dismiss = () => setDismissed(text);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    const current = matches[index];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + matches.length) % matches.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || (event.key === 'Tab' && !event.shiftKey)) {
      if (!current) return false;
      if (event.key === 'Enter' && current === query) {
        dismiss();
        return false;
      }
      event.preventDefault();
      pick(current);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return true;
    }
    return false;
  };

  return {
    open,
    listId,
    matches,
    active: index,
    skills: skillSet,
    setActive,
    pick,
    dismiss,
    inputProps: {
      'aria-autocomplete': 'list',
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && index >= 0 ? `${listId}-${index}` : undefined,
      onSelect: (event) => setCaret(event.currentTarget.selectionStart),
      // Typing moves the caret too, and not every browser reports that as a selection
      onInput: (event) => setCaret(event.currentTarget.selectionStart),
    },
    onKeyDown,
  };
}

/** The list above the message box it belongs to; `children` is that box, which it is anchored to. */
export function SlashMenu({ state, children }: { state: SlashMenuState; children: ReactElement }) {
  const { t } = useTranslation('components');
  return (
    <RadixPopover.Root open={state.open} onOpenChange={(next) => !next && state.dismiss()}>
      <RadixPopover.Anchor asChild>{children}</RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          {...LAYER_ATTR}
          className="menu slash-menu"
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Typing in the box it hangs from is not "outside"
          onInteractOutside={(e) => e.target instanceof Element && e.target.closest('form.composer') && e.preventDefault()}
        >
          <div className="menu-viewport" role="listbox" id={state.listId} aria-label={t('slashMenu.label')}>
            {state.matches.map((name, i) => (
              <div
                key={name}
                id={`${state.listId}-${i}`}
                role="option"
                aria-selected={i === state.active}
                data-highlighted={i === state.active ? '' : undefined}
                className="menu-item"
                // Keep focus in the box: picking must not blur it first
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => state.setActive(i)}
                onClick={() => state.pick(name)}
              >
                <span className="menu-item-text">
                  <span className="slash-menu-name">/{name}</span>
                </span>
                {state.skills.has(name) && <span className="menu-item-key">{t('slashMenu.skill')}</span>}
              </div>
            ))}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
