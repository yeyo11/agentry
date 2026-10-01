import i18n from 'i18next';

/*
 * What a provider's protocol calls things, said in the person's words. A wire identifier
 * (`commandExecution`, `acceptEdits`) never reaches the screen; one this file does not know stays as
 * it came, because a tool's own name (`Bash`, `mcp__pando__kb_search`) is already what it is called.
 */

const TOOL_KINDS = ['commandExecution', 'fileChange', 'execute', 'edit', 'read', 'delete', 'move', 'search', 'fetch', 'think', 'other'] as const;
const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

const isIn = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** A tool kind a protocol reports, as a word ("Command", "File change"); any other name as it is. */
export function toolKindLabel(name: string): string {
  return isIn(TOOL_KINDS, name) ? i18n.t(`chat:toolKinds.${name}`) : name;
}

/** A permission mode, as the person names it ("Accept edits"); one this app does not know as it is. */
export function modeLabel(mode: string): string {
  return isIn(MODES, mode) ? i18n.t(`chat:permissionModes.${mode}`) : mode;
}
