/**
 * Floating layers (select menus, combobox lists) are portalled to <body> and mark themselves with
 * this attribute. The Dialog checks for it so that Escape closes the open layer, not the dialog.
 */
export const LAYER_ATTR = { 'data-escape-layer': '' } as const;

export function hasOpenLayer(): boolean {
  return document.querySelector('[data-escape-layer]') !== null;
}
