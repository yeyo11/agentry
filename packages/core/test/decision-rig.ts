import type { DecisionAnswer, DecisionPointId, DecisionProviderId } from '@agentry/shared';
import { Db } from '../src/db.ts';
import { DecisionEngine, type DecisionProvider, type DecisionRequest, type ProviderResult } from '../src/decisions/engine.ts';
import { decisionPoint } from '../src/decisions/points.ts';
import { DecisionCredentialStore, DecisionSettingsStore, DEFAULT_DECISION_SETTINGS } from '../src/decisions/settings.ts';
import type { CoreConfig } from '../src/paths.ts';

/** What a point's call site is tested against: the real engine and store, and a provider the test scripts */
export type Script = (request: DecisionRequest) => ProviderResult | Record<string, DecisionAnswer>;

export class ScriptedProvider implements DecisionProvider {
  readonly calls: DecisionRequest[] = [];
  up = true;
  script: Script = () => ({ status: 'unavailable', reason: 'server-error', latencyMs: 1 });
  constructor(readonly id: DecisionProviderId) {}
  available(): boolean {
    return this.up;
  }
  ask(request: DecisionRequest): Promise<ProviderResult> {
    this.calls.push(request);
    const out = this.script(request);
    const result: ProviderResult = 'status' in out && typeof out.status === 'string' ? (out as ProviderResult) : { status: 'answered', answers: out as Record<string, DecisionAnswer>, latencyMs: 5, inputTokens: 10, costUsd: 0, model: 'fake' };
    return Promise.resolve(result);
  }
}

export const scoreOf = (value: string, confidence: number | null = 0.95): DecisionAnswer => ({ kind: 'score', value, probabilities: null, confidence });
export const noulOf = (value: boolean, confidence: number | null = 0.95): DecisionAnswer => ({ kind: 'noul', value, probabilities: null as never, probability: null, confidence }) as DecisionAnswer;
export const choiceOf = (value: string, confidence: number | null = 0.95): DecisionAnswer => ({ kind: 'choice', value, probabilities: null, confidence });

export function decisionRig(db: Db, config: CoreConfig) {
  const settings = new DecisionSettingsStore(config, new DecisionCredentialStore(config));
  const engine = new DecisionEngine({ settings, db, projectDecisions: () => null });
  const provider = new ScriptedProvider('jev');
  engine.register(provider);
  /** Puts a point in a mode with the consent the engine needs before it asks anything */
  async function configure(point: DecisionPointId, mode: 'off' | 'shadow' | 'active', threshold = 0.85): Promise<void> {
    await settings.set({ ...structuredClone(DEFAULT_DECISION_SETTINGS), provider: 'jev', points: { [point]: { mode, threshold, consent: null } } });
    await settings.setConsent(point, { granted: true, stateVersion: decisionPoint(point)?.stateVersion ?? 1, providers: ['jev'] });
  }
  const rows = (point: DecisionPointId) => db.listDecisions({ point, limit: 100 }).items;
  /** A point asks in the background: waits until `n` rows are written */
  async function rowsAfter(point: DecisionPointId, n: number): Promise<ReturnType<typeof rows>> {
    for (let i = 0; i < 200 && rows(point).length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return rows(point);
  }
  return { engine, provider, configure, rows, rowsAfter };
}
