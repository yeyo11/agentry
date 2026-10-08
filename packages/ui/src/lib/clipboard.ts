/**
 * Puts text on the clipboard, and says whether it did.
 *
 * `navigator.clipboard` exists only in a secure context (HTTPS, or localhost), and Agentry is often
 * opened over plain HTTP on a local network address, where it is `undefined`: a bare
 * `navigator.clipboard?.writeText()` then does nothing, with no error and no toast. There, and when
 * the asynchronous write is refused, the text is copied the older way, from a selected, hidden
 * textarea, which browsers still allow inside a click.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (no focus, a permission policy): the selection path below may still work
    }
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Inside a dialog or a menu, a textarea added to <body> would be outside its focus trap and lose
  // the selection, so it goes next to what has the focus
  const host = focused?.closest('[role="dialog"], [role="menu"], [role="alertdialog"]') ?? document.body;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.opacity = '0';
  host.appendChild(area);
  let copied = false;
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
  return copied;
}
