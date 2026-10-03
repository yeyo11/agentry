import type { ProviderReadinessState, ProviderReasonCode, ProviderStatus } from '@agentry/shared';

// What a provider's state looks like and what can be done about it, as plain data: the row, the
// first-run step and the status bar all read it, and a test reads it without a page.

/** The tones `.badge-*` and `.status-dot` draw; one meaning each (design system: status colours). */
export type ProviderTone = 'ok' | 'warn' | 'bad' | 'idle' | 'muted';

/**
 * A state's badge: ok is ready, warn needs a person (sign in, or a warning), bad is broken, idle is
 * waiting on something outside Agentry. `disabled` is a setting and not a detected state, so the
 * row passes it apart from the status.
 */
export const STATE_TONE: Record<ProviderReadinessState | 'disabled', ProviderTone> = {
  ready: 'ok',
  degraded: 'warn',
  'signed-out': 'warn',
  incompatible: 'bad',
  'used-before': 'idle',
  'not-installed': 'muted',
  unknown: 'idle',
  disabled: 'muted',
};

/** Translation keys in the `providers` namespace, one per state */
export const stateLabelKey = (state: ProviderReadinessState | 'disabled'): `state.${ProviderReadinessState | 'disabled'}` => `state.${state}`;

/** The one thing a person can do about a state; the row draws each as a button. */
export type ProviderActionKind = 'sign-in' | 'install' | 'update' | 'choose-binary' | 'retry';

export interface ProviderAction {
  kind: ProviderActionKind;
  /** The action the state asks for first; the rest are ghost buttons */
  primary: boolean;
}

/**
 * The remedy per state, from the validated prototype: sign in when signed out, install or point at
 * a binary when the program is missing or the wrong version, update when it works but is old, and
 * retry when the check could not run. Ready has nothing to fix, and neither has a provider with no
 * check to run (`no-probe`): retrying would read the same nothing again.
 */
export function actionsFor(state: ProviderReadinessState, reason: ProviderReasonCode | null = null): ProviderAction[] {
  switch (state) {
    case 'ready':
      return [];
    case 'degraded':
      return [{ kind: 'update', primary: true }];
    case 'signed-out':
      return [{ kind: 'sign-in', primary: true }];
    case 'incompatible':
    case 'used-before':
      return [{ kind: 'choose-binary', primary: true }, { kind: 'install', primary: false }];
    case 'not-installed':
      return [{ kind: 'install', primary: true }];
    case 'unknown':
      return reason === 'no-probe' ? [] : [{ kind: 'retry', primary: true }];
  }
}

/** Where a provider's install and sign-in pages are: the vendor's, from its manifest in core. */
const LINKS: Record<string, { install: string; signIn: string }> = {
  'claude-code': { install: 'https://code.claude.com/docs/en/setup', signIn: 'https://code.claude.com/docs/en/authentication' },
  codex: { install: 'https://github.com/openai/codex', signIn: 'https://github.com/openai/codex' },
  gemini: { install: 'https://github.com/google-gemini/gemini-cli', signIn: 'https://github.com/google-gemini/gemini-cli' },
  copilot: { install: 'https://docs.github.com/copilot/how-tos/copilot-cli', signIn: 'https://docs.github.com/copilot/how-tos/copilot-cli' },
};

/** The vendor page for an action, or null for a provider whose page this build does not know. */
export function providerLink(id: string, kind: 'install' | 'sign-in'): string | null {
  const links = LINKS[id];
  if (!links) return null;
  return kind === 'install' ? links.install : links.signIn;
}

/** Claude Code signs in inside Agentry, on Settings → Account; every other provider on its vendor's page. */
export const CLAUDE_CODE_ID = 'claude-code';
export const SIGN_IN_SETTINGS_PATH = '/settings?tab=account';

/** A provider reads as usable when it can start work: ready, or working with a warning. */
export const isUsable = (status: Pick<ProviderStatus, 'state'>): boolean => status.state === 'ready' || status.state === 'degraded';
