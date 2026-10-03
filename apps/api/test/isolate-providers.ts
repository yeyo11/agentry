import { existsSync } from 'node:fs';
import { ProvidersSettingsStore } from '@agentry/core';
import { OTHER_PROVIDERS } from '../../../packages/core/test/helpers.ts';

/*
 * Loaded before every API test file (`--import` in the test script). A test core must not find the
 * machine's own agent CLIs: detecting one runs it (a handshake starts the agent), and a real CLI that
 * waits for a sign-in leaves a process behind. So, for these tests only, a provider a document does
 * not name is off rather than on, and a store with no providers.json reads as Claude Code alone, as
 * core's `tempConfig()` does. A test that wants Codex names it through `PUT /providers/settings`, as
 * a person would. Core's own tests cover the shipped defaults.
 */
type Internals = { file: string; parse(input: unknown): unknown; read(): unknown };
const proto = ProvidersSettingsStore.prototype as unknown as Internals;
const parse = proto.parse;
const read = proto.read;

proto.parse = function isolatedParse(this: Internals, input: unknown) {
  // What is not a document is the validation's to refuse, as it is
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return parse.call(this, input);
  const doc = input as Record<string, unknown>;
  const named = typeof doc.providers === 'object' && doc.providers !== null ? (doc.providers as Record<string, unknown>) : {};
  const off = Object.fromEntries(OTHER_PROVIDERS.filter((id) => !(id in named)).map((id) => [id, { enabled: false, binaryPath: null }]));
  return parse.call(this, { ...doc, providers: { ...off, ...named } });
};

proto.read = function isolatedRead(this: Internals) {
  if (existsSync(this.file)) return read.call(this);
  return this.parse({ order: ['claude-code'] });
};
