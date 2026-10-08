import {
  SETUP_TOOLS,
  type CodeHostId,
  type CodeHostStatus,
  type LoginErrorCode,
  type LoginMethod,
  type LoginSession,
  type ProviderReadinessState,
  type ProviderReasonCode,
  type ProviderStatus,
  type SetupState,
  type SetupTailscaleSummary,
  type SetupTool,
  type SetupToolMethods,
  type TailscaleReadinessState,
} from '@agentry/shared';
import { providerLink } from './provider-state';

// The in-app setup (docs/plans/in-app-setup.md, docs/setup.md) as plain data: which sign-in a tool
// offers, what a sign-in session means for the panel, the assistant's steps and its summary. The
// panels and the assistant read it, and a test reads it without a page.

export const isSetupTool = (id: string): id is SetupTool => (SETUP_TOOLS as readonly string[]).includes(id);

/** The CLI a code host signs in through: GitHub's `gh`, GitLab's `glab`. */
export const hostTool = (id: CodeHostId): 'gh' | 'glab' => (id === 'gitlab' ? 'glab' : 'gh');

/** The tools the shared sign-in panel serves; YouTrack keeps its own access form (an address and a token). */
export type PanelTool = Exclude<SetupTool, 'youtrack'>;

export const isPanelTool = (id: string): id is PanelTool => isSetupTool(id) && id !== 'youtrack';

/** What `GET /setup` says a tool offers; null while it is not read, or for a tool it does not list. */
export function methodsOf(setup: Pick<SetupState, 'methods'> | undefined, tool: SetupTool): SetupToolMethods | null {
  return setup?.methods.find((m) => m.tool === tool) ?? null;
}

/**
 * The ways to sign in, in the order the panel offers them: the device code first where the vendor
 * documents one (nothing to paste, nothing to make), then the key, which every tool takes.
 */
export function loginMethods(methods: SetupToolMethods): LoginMethod[] {
  return methods.device ? ['device', 'key'] : ['key'];
}

/** Whether the panel heads itself with the Code / Key choice: only a tool with both. */
export const offersChoice = (methods: SetupToolMethods): boolean => loginMethods(methods).length > 1;

/**
 * The variables a key may go in, when the person has to choose one (Claude Code's token or API key,
 * OpenCode's four providers). Empty when there is nothing to choose: a stdin tool, or one variable.
 */
export function variableChoices(methods: SetupToolMethods): string[] {
  return methods.key === 'env' && methods.variables.length > 1 ? methods.variables : [];
}

/** How a variable is offered in the choice: a word of the copy for Claude Code, the provider for OpenCode. */
export type VariableLabel = { kind: 'copy'; key: 'oauthToken' | 'apiKey' } | { kind: 'name'; name: string };

const OPENCODE_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'Anthropic',
  OPENAI_API_KEY: 'OpenAI',
  GEMINI_API_KEY: 'Google',
  OPENROUTER_API_KEY: 'OpenRouter',
};

export function variableLabel(tool: SetupTool, variable: string): VariableLabel {
  if (tool === 'claude-code') return { kind: 'copy', key: variable === 'ANTHROPIC_API_KEY' ? 'apiKey' : 'oauthToken' };
  return { kind: 'name', name: OPENCODE_PROVIDER[variable] ?? variable };
}

/**
 * Where to make a key, on the vendor's own page. A host CLI's page is on the host the person signs
 * in to, so a GitHub Enterprise or a self-managed GitLab gets its own. Null where there is none to name.
 */
export function keyLink(tool: SetupTool, host: string | null): string | null {
  const at = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  switch (tool) {
    case 'claude-code':
      return 'https://code.claude.com/docs/en/authentication';
    case 'codex':
      return 'https://platform.openai.com/api-keys';
    case 'gemini':
      return 'https://aistudio.google.com/apikey';
    case 'copilot':
      return 'https://github.com/settings/personal-access-tokens/new';
    case 'gh':
      return `https://${at || 'github.com'}/settings/tokens`;
    case 'glab':
      return `https://${at || 'gitlab.com'}/-/user_settings/personal_access_tokens`;
    case 'tailscale':
      return TAILSCALE_KEYS_URL;
    case 'opencode':
    case 'youtrack':
      return null;
  }
}

/** Where a tailnet's admin makes an auth key */
export const TAILSCALE_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';

/** Where a tool's program is installed from, for a sign-in that found none: the vendor's page. */
export function installLink(tool: SetupTool): string | null {
  if (tool === 'tailscale') return 'https://tailscale.com/download';
  if (tool === 'gh') return 'https://cli.github.com';
  if (tool === 'glab') return 'https://gitlab.com/gitlab-org/cli#installation';
  if (tool === 'youtrack') return 'https://www.npmjs.com/package/@jetbrains/youtrack-apps-tools';
  return providerLink(tool, 'install');
}

/** Codex's device sign-in may have to be allowed in ChatGPT's security settings first (beta). */
export const CODEX_DEVICE_SETTINGS = 'https://chatgpt.com/#settings/Security';

/** A sign-in still going: the panel shows it and offers Cancel. */
export const isLive = (session: Pick<LoginSession, 'state'> | null): boolean =>
  session !== null && (session.state === 'starting' || session.state === 'waiting-for-person');

/**
 * The newer of two copies of one session. The event feed and the fallback read can cross: a copy
 * that already ended is never replaced by one that has not.
 */
export function newerSession(current: LoginSession | null, incoming: LoginSession): LoginSession {
  if (current === null || current.id !== incoming.id) return incoming;
  if (current.endedAt !== null && incoming.endedAt === null) return current;
  return incoming;
}

/** What a sign-in that ended badly says, and the one thing to do about it (design system: Setup). */
export interface LoginFailure {
  /** bad: it failed. warn: the code only ran out of time, so it has to be asked for again */
  tone: 'bad' | 'warn';
  code: LoginErrorCode | 'expired';
  action: 'retry' | 'use-key' | 'install' | 'new-code';
}

/** Null for a session that is going, succeeded, or was cancelled (which says nothing: the panel closes). */
export function failureOf(session: Pick<LoginSession, 'state' | 'error'> | null): LoginFailure | null {
  if (!session) return null;
  if (session.state === 'expired') return { tone: 'warn', code: 'expired', action: 'new-code' };
  if (session.state !== 'failed') return null;
  const code = session.error ?? 'cli-refused';
  const action = code === 'no-code' ? 'use-key' : code === 'cli-missing' ? 'install' : 'retry';
  return { tone: 'bad', code, action };
}

/** "m:ss" left until `expiresAt`, never below zero. */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(expiresAt) - now);
  const seconds = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Whether a row offers Sign in: the tool is installed and says it is signed out, or it reads
 * `no-probe` (Gemini, OpenCode: nothing to ask) and Agentry keeps no key for it yet.
 */
export const offersSignIn = (state: ProviderReadinessState, reason: ProviderReasonCode | null = null, keyStored = false): boolean =>
  state === 'signed-out' || (state === 'unknown' && reason === 'no-probe' && !keyStored);

/**
 * Whether a row offers Sign out: the tool works, or it reads `no-probe` because a key Agentry keeps
 * is all it has (Gemini, OpenCode) and one is kept, and the vendor documents a way out (not Copilot).
 */
export function offersSignOut(methods: SetupToolMethods | null, state: ProviderReadinessState, reason: ProviderReasonCode | null = null, keyStored = false): boolean {
  if (!methods?.signOut) return false;
  return state === 'ready' || state === 'degraded' || (state === 'unknown' && reason === 'no-probe' && keyStored);
}

// ---------------------------------------------------------------- Tailscale

/** Signed in to a tailnet: any state past `loggedOut` (HTTPS or MagicDNS off are the tailnet's settings, not the sign-in's). */
export const tailscaleSignedIn = (state: TailscaleReadinessState): boolean => state === 'ready' || state === 'httpsDisabled' || state === 'stopped';

/**
 * What the Tailscale row offers. Sign in and sign out only where Agentry runs the daemon (the Docker
 * image): a machine's own Tailscale is the person's, and the row shows its state and where to look.
 * `stopped` offers Sign in too: `tailscale up` is also what connects a node again.
 */
export function tailscaleActions(summary: Pick<SetupTailscaleSummary, 'enabled' | 'managed' | 'state'>): { signIn: boolean; signOut: boolean } {
  const ours = summary.enabled && summary.managed;
  return {
    signIn: ours && (summary.state === 'loggedOut' || summary.state === 'stopped'),
    signOut: ours && (summary.state === 'ready' || summary.state === 'httpsDisabled'),
  };
}

/** The colour of the Tailscale row's state, always beside its word */
export function tailscaleTone(state: TailscaleReadinessState): 'ok' | 'warn' {
  return state === 'ready' ? 'ok' : 'warn';
}

// ---------------------------------------------------------------- the assistant

export const SETUP_STEPS = ['access', 'agents', 'code', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface WizardState {
  /** The step on screen */
  step: SetupStep;
  /** The steps the person skipped, kept until they come back and continue through them */
  skipped: SetupStep[];
}

export const START: WizardState = { step: 'access', skipped: [] };

const indexOf = (step: SetupStep) => SETUP_STEPS.indexOf(step);

/** Continue (or Skip, which marks the step as skipped) moves one step on; the last step stays. */
export function advance(state: WizardState, skip = false): WizardState {
  const at = indexOf(state.step);
  const next = SETUP_STEPS[at + 1];
  if (!next) return state;
  const others = state.skipped.filter((s) => s !== state.step);
  return { step: next, skipped: skip ? [...others, state.step] : others };
}

/** Back moves one step back and keeps what was skipped. */
export function retreat(state: WizardState): WizardState {
  const previous = SETUP_STEPS[indexOf(state.step) - 1];
  return previous ? { ...state, step: previous } : state;
}

export type StepMark = 'done' | 'current' | 'skipped' | 'pending';

/** The step bar: what each step looks like from where the person is. */
export function stepMarks(state: WizardState): { step: SetupStep; mark: StepMark }[] {
  const at = indexOf(state.step);
  return SETUP_STEPS.map((step, i) => ({
    step,
    mark: i === at ? 'current' : state.skipped.includes(step) ? 'skipped' : i < at ? 'done' : 'pending',
  }));
}

/** "2 of 5 ready" under the agents: the installed agents, and how many of them can work. */
export function agentsReady(statuses: Pick<ProviderStatus, 'state'>[]): { ready: number; total: number } {
  const installed = statuses.filter((s) => s.state !== 'not-installed' && s.state !== 'used-before');
  return { ready: installed.filter((s) => s.state === 'ready' || s.state === 'degraded').length, total: installed.length };
}

/** The same for code and work items: GitHub, GitLab and YouTrack. */
export function codeReady(hosts: Pick<CodeHostStatus, 'state'>[], youtrackReady: boolean): { ready: number; total: number } {
  return { ready: hosts.filter((h) => h.state === 'ready' || h.state === 'degraded').length + (youtrackReady ? 1 : 0), total: hosts.length + 1 };
}

/** A line of the Done step: a tool, its badge, and the Settings tab where it is changed. */
export interface SummaryRow {
  id: string;
  kind: 'access' | 'provider' | 'host' | 'youtrack' | 'tailscale';
  label: string;
  /** The account, the access mode or the address; null when there is none to name */
  detail: string | null;
  /** A code host's account is on this host ("tanuki on gitlab.com") */
  host?: string;
  /** ready: Ready (ok). signed-out: Signed out (warn). skipped: plain "Skipped". open: plain, access with no guard */
  badge: 'ready' | 'signed-out' | 'skipped' | 'open';
  where: 'security' | 'providers' | 'integrations' | 'remote';
}

const usable = (state: string) => state === 'ready' || state === 'degraded';

/**
 * What the setup left done and not done. A tool that is not installed has nothing to set up and is
 * left out; one that is not signed in reads Skipped when its step was skipped, Signed out otherwise.
 */
export function summaryRows(input: {
  access: SetupState['access'];
  providers: ProviderStatus[];
  hosts: CodeHostStatus[];
  youtrack: { state: string | null; host: string | null; user: string | null } | null;
  /** Left out where the deploy offers no tunnel, or where a machine's Tailscale is not even installed */
  tailscale?: SetupTailscaleSummary | null;
  skipped: SetupStep[];
}): SummaryRow[] {
  const missed = (step: SetupStep) => (input.skipped.includes(step) ? 'skipped' : 'signed-out');
  const rows: SummaryRow[] = [
    {
      id: 'access',
      kind: 'access',
      label: 'access',
      detail: input.access.mode,
      badge: input.access.mode !== 'none' ? 'ready' : input.skipped.includes('access') ? 'skipped' : 'open',
      where: 'security',
    },
  ];
  for (const p of input.providers) {
    if (p.state === 'not-installed' || p.state === 'used-before') continue;
    rows.push({ id: p.id, kind: 'provider', label: p.label, detail: usable(p.state) ? p.account : null, badge: usable(p.state) ? 'ready' : missed('agents'), where: 'providers' });
  }
  for (const h of input.hosts) {
    if (h.state === 'not-installed') continue;
    const signed = h.hosts.find((entry) => entry.signedIn !== false && entry.user);
    rows.push({
      id: h.id,
      kind: 'host',
      label: h.label,
      detail: usable(h.state) && signed ? (signed.user ?? null) : null,
      ...(usable(h.state) && signed ? { host: signed.hostname } : {}),
      badge: usable(h.state) ? 'ready' : missed('code'),
      where: 'integrations',
    });
  }
  if (input.youtrack && input.youtrack.state !== 'not-installed') {
    const ready = input.youtrack.state === 'ready';
    rows.push({ id: 'youtrack', kind: 'youtrack', label: 'YouTrack', detail: ready ? input.youtrack.host : null, badge: ready ? 'ready' : missed('code'), where: 'integrations' });
  }
  const tailscale = input.tailscale;
  if (tailscale?.enabled && (tailscale.managed || tailscale.state !== 'missing')) {
    const signed = tailscaleSignedIn(tailscale.state);
    // It is set up in the Access step, so skipping that step is what leaves it out
    rows.push({ id: 'tailscale', kind: 'tailscale', label: 'Tailscale', detail: signed ? tailscale.host : null, badge: signed ? 'ready' : missed('access'), where: 'remote' });
  }
  return rows;
}

/** The query keys a sign-in or a sign-out changes: the readiness of every list that shows the tool. */
export const READINESS_KEYS = [['setup'], ['providers'], ['hosts'], ['trackers'], ['auth'], ['overview'], ['tunnel']] as const;
