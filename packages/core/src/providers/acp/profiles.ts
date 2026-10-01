import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption, PermissionMode, PolicyTranslation, ProviderId, ToolPolicy } from '@agentry/shared';
import { copilotPolicyArgs, translateCopilotPolicy } from './policy-copilot.ts';
import { geminiPolicyToml, translateGeminiPolicy } from './policy-gemini.ts';
import { openCodePermission, translateOpenCodePolicy } from './policy-opencode.ts';

/** What the agent is told to switch to for one of Agentry's permission modes. */
export interface NativeMode {
  /** The id `session/set_mode` takes */
  modeId: string;
  /** Copilot's `allow_all` option, set beside the mode */
  allowAll?: 'on' | 'off';
  /** The words the picker shows for the native value */
  native: string;
}

/** What differs per ACP agent: data and three small functions. The protocol code is shared. */
export interface AcpProfile {
  id: ProviderId;
  /** Agentry's modes this agent can honour; `auto` is in none */
  modes: Partial<Record<PermissionMode, NativeMode>>;
  /** How a live model switch is made; null when the agent offers none */
  setModel: 'config-option' | 'set-model' | null;
  /** What the picker offers before a session has said what the agent has */
  defaultModels: ModelOption[];
  /** `acceptEdits` and `bypassPermissions` are the host's to grant where the agent has no native setting for them live */
  hostGrants: { acceptEdits: boolean; bypass: boolean };
  translate(policy: ToolPolicy): PolicyTranslation;
  /** The command-line arguments and environment the policy and model add to the manifest's own */
  launchExtras(input: LaunchInput): { args: string[]; env: Record<string, string>; files: string[] };
}

export interface LaunchInput {
  translation: PolicyTranslation;
  model: string | undefined;
  mode: PermissionMode;
  /** Where a file the launch writes may go */
  dataDir: string;
  /** Names the file; one per chat, overwritten at each launch */
  chatId: string;
}

const COPILOT_MODE = (name: string): string => `https://agentclientprotocol.com/protocol/session-modes#${name}`;

const COPILOT: AcpProfile = {
  id: 'copilot',
  modes: {
    manual: { modeId: COPILOT_MODE('agent'), allowAll: 'off', native: 'agent' },
    acceptEdits: { modeId: COPILOT_MODE('agent'), allowAll: 'off', native: 'agent + write' },
    plan: { modeId: COPILOT_MODE('plan'), allowAll: 'off', native: 'plan' },
    dontAsk: { modeId: COPILOT_MODE('agent'), allowAll: 'off', native: 'agent' },
    bypassPermissions: { modeId: COPILOT_MODE('agent'), allowAll: 'on', native: 'allow_all' },
  },
  // No model option in `session/new`: the model is a launch flag
  setModel: null,
  defaultModels: [{ value: 'auto', label: 'Auto', description: 'Copilot picks the model' }],
  hostGrants: { acceptEdits: true, bypass: false },
  translate: translateCopilotPolicy,
  launchExtras: ({ translation, model, mode }) => {
    const args = copilotPolicyArgs(translation);
    // acceptEdits is Copilot's own `write` permission, granted at launch as well as by the host
    if (mode === 'acceptEdits' && !translation.rules.allowedTools.includes('write') && !translation.rules.disallowedTools.includes('write')) args.push('--allow-tool=write');
    if (model) args.push('--model', model);
    return { args, env: {}, files: [] };
  },
};

const GEMINI: AcpProfile = {
  id: 'gemini',
  modes: {
    manual: { modeId: 'default', native: 'default' },
    acceptEdits: { modeId: 'auto_edit', native: 'auto_edit' },
    plan: { modeId: 'plan', native: 'plan' },
    dontAsk: { modeId: 'default', native: 'default' },
    bypassPermissions: { modeId: 'yolo', native: 'yolo' },
  },
  // `session/set_model` is in the bundle source and not recorded on the wire: used, not declared
  setModel: 'set-model',
  defaultModels: [{ value: 'default', label: 'Default', description: "The model Gemini CLI picks" }],
  hostGrants: { acceptEdits: false, bypass: false },
  translate: translateGeminiPolicy,
  launchExtras: ({ translation, model, dataDir, chatId }) => {
    const args: string[] = [];
    const toml = geminiPolicyToml(translation);
    const files: string[] = [];
    if (toml) {
      mkdirSync(dataDir, { recursive: true });
      const file = join(dataDir, `gemini-policy-${chatId}.toml`);
      writeFileSync(file, toml, { mode: 0o600 });
      files.push(file);
      args.push('--policy', file);
    }
    if (model && model !== 'default') args.push('--model', model);
    return { args, env: {}, files };
  },
};

const OPENCODE: AcpProfile = {
  id: 'opencode',
  modes: {
    manual: { modeId: 'build', native: 'build' },
    acceptEdits: { modeId: 'build', native: 'build + edit allow' },
    plan: { modeId: 'plan', native: 'plan' },
    dontAsk: { modeId: 'build', native: 'build' },
    bypassPermissions: { modeId: 'build', native: 'build + allow all' },
  },
  setModel: 'config-option',
  // The free hosted model the recorded `session/new` offered with no sign-in
  defaultModels: [{ value: 'opencode/big-pickle', label: 'OpenCode Zen/Big Pickle' }],
  hostGrants: { acceptEdits: true, bypass: true },
  translate: translateOpenCodePolicy,
  launchExtras: ({ translation }) => {
    // `autoupdate: false` is the documented switch; the variable is a string in the binary
    const config: Record<string, unknown> = { autoupdate: false };
    const permission = openCodePermission(translation);
    if (Object.keys(permission).length > 0) config.permission = permission;
    return { args: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: '1' }, files: [] };
  },
};

export const ACP_PROFILES: Readonly<Partial<Record<ProviderId, AcpProfile>>> = { copilot: COPILOT, gemini: GEMINI, opencode: OPENCODE };

/** Removes a file a launch wrote; the agent has read it by the time the chat ends. */
export function removeLaunchFile(file: string): void {
  rmSync(file, { force: true });
}
