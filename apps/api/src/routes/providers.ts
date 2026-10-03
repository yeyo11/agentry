import type { FastifyPluginAsync } from 'fastify';
import { modelMapSubject, modelMapSubjectId, stanceOf, type Core } from '@agentry/core';
import type {
  AnswerModelMapSuggestionRequest,
  CswapRetirementState,
  ModelMapEntry,
  ModelMapSuggestion,
  ModelOption,
  ProviderCandidates,
  ProviderMove,
  ProviderMoveState,
  ProviderStatus,
  ProvidersSettings,
  SuggestModelMapRequest,
} from '@agentry/shared';

/**
 * The agents Agentry can drive: what each one's detection found (served from the detector's cache),
 * a re-detection on demand, and the settings document; and what happens when one reaches its usage
 * limit: who could take the work, the moves and waits so far, and the model mapping's suggestions.
 * Validation lives in core. The writes that spend on another vendor or name a binary Agentry runs
 * are refused to a chat's token in `security.ts`.
 */

const MOVE_STATES: readonly ProviderMoveState[] = ['waiting', 'resuming', 'moved', 'resumed', 'failed', 'cancelled'];

const fail = (status: number, message: string): Error => Object.assign(new Error(message), { statusCode: status });

/** `<provider>:<model>→<target>`, as `provider.model-map` files its subject; a model id may hold a colon, a provider id never does. */
function pairOf(subjectId: string | null): { from: ModelMapSuggestion['from']; to: string } | null {
  if (!subjectId) return null;
  const arrow = subjectId.lastIndexOf('→');
  const colon = subjectId.indexOf(':');
  if (arrow < 0 || colon < 0 || colon > arrow) return null;
  return { from: { provider: subjectId.slice(0, colon), model: subjectId.slice(colon + 1, arrow) }, to: subjectId.slice(arrow + 1) };
}

export const providerRoutes: FastifyPluginAsync<{ core: Core }> = async (app, { core }) => {
  app.get('/providers', (): Promise<ProviderStatus[]> => core.providers.statuses());

  app.post('/providers/refresh', (): Promise<ProviderStatus[]> => core.providers.refresh());

  app.get('/providers/settings', (): ProvidersSettings => core.providersSettings.get());

  const settingsChanged = (): void => {
    // The answer does not wait for the probes: `providers.changed` tells every page what they found
    core.providers.settingsChanged().catch((err: unknown) => app.log.warn({ err }, 'providers: re-detection after a settings change failed'));
  };

  app.put<{ Body: unknown }>('/providers/settings', async (req): Promise<ProvidersSettings> => {
    const settings = await core.providersSettings.set(req.body);
    settingsChanged();
    return settings;
  });

  // Who could take a chat at a limit, with the reason each of the others cannot: the banner and the move sheet
  app.get<{ Querystring: { chatId?: string } }>('/providers/candidates', (req): ProviderCandidates => {
    const { chatId } = req.query;
    if (!chatId) throw new Error('chatId is required');
    const { candidates, excluded, movesCapped } = core.chats.candidates(chatId);
    return { candidates: candidates.map(({ provider, model, utilization, resetsAt }) => ({ provider, model, utilization, resetsAt })), excluded, movesCapped };
  });

  // Moves and waits, newest first: the history and the queue in one
  app.get<{ Querystring: { chatId?: string; projectId?: string; state?: string; limit?: string } }>('/providers/moves', (req): ProviderMove[] => {
    const { chatId, projectId, state, limit } = req.query;
    const wanted = state ? MOVE_STATES.find((s) => s === state) : undefined;
    if (state && !wanted) throw new Error(`state must be one of ${MOVE_STATES.join(', ')}`);
    const max = limit === undefined || limit === '' ? undefined : Number(limit);
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new Error('limit must be a positive integer');
    return core.db.providerMoves({ ...(chatId ? { chatId } : {}), ...(projectId ? { projectId } : {}), ...(wanted ? { state: wanted } : {}), ...(max ? { limit: max } : {}) });
  });

  // Stop waiting: the run or task the wait belonged to then ends `stopped`
  app.post<{ Params: { id: string } }>('/providers/moves/:id/cancel', (req): ProviderMove => {
    const move = core.db.providerMove(req.params.id);
    if (!move) throw fail(404, `move ${req.params.id} not found`);
    if (!core.rotation.cancel(move.id)) throw fail(409, 'this wait is already over');
    return core.db.providerMove(move.id) ?? move;
  });

  // The suggestions of `provider.model-map` no person has answered, one per pair, newest first
  app.get('/providers/model-map/suggestions', (): ModelMapSuggestion[] => {
    const map = core.providersSettings.get().rotation?.modelMap ?? [];
    const seen = new Set<string>();
    const open: ModelMapSuggestion[] = [];
    const { items } = core.db.listDecisions({ point: 'provider.model-map', status: 'answered', limit: 500 });
    for (const row of items) {
      const pair = pairOf(row.subjectId);
      const answer = row.answers?.counterpart;
      if (!pair || !row.subjectId || answer?.kind !== 'choice' || seen.has(row.subjectId)) continue;
      seen.add(row.subjectId);
      // A pair the person answered, either way, is closed
      if (row.feedback !== null) continue;
      const mapped = map.some((e) => e.from.provider === pair.from.provider && e.from.model === pair.from.model && e.to.provider === pair.to);
      if (!mapped) open.push({ id: row.id, from: pair.from, to: { provider: pair.to, model: answer.value }, at: row.at });
    }
    return open;
  });

  // The person pressing Suggest: asks the point now, whatever it was asked today. 204 when nothing came
  // back (the point watches only, or had no counterpart); 409 when the point is off
  app.post<{ Body: SuggestModelMapRequest | undefined }>('/providers/model-map/suggest', async (req, reply): Promise<ModelMapSuggestion | undefined> => {
    const { from, target } = req.body ?? {};
    if (typeof from?.provider !== 'string' || typeof from.model !== 'string' || !from.model || typeof target !== 'string') throw new Error('from.provider, from.model and target are required');
    const own = core.runtime.providers.driverFor(from.provider);
    const other = core.runtime.providers.driverFor(target);
    if (!own) throw fail(404, `provider ${from.provider} has no driver`);
    if (!other) throw fail(404, `provider ${target} has no driver`);
    if (from.provider === target) throw new Error('the target must be another provider');
    const stance = stanceOf(core.decisions, 'provider.model-map', null);
    if (stance === 'off') throw fail(409, 'the model-map decision point is off');
    const subject = modelMapSubject(from, target, own.models(), other.models());
    const model = await core.providerPoints.suggestMapping(stance, subject, { force: true });
    if (!model) return reply.status(204).send() as unknown as undefined;
    const id = modelMapSubjectId(from.provider, from.model, target);
    const row = core.db.listDecisions({ point: 'provider.model-map', status: 'answered', limit: 50 }).items.find((r) => r.subjectId === id);
    if (!row) return reply.status(204).send() as unknown as undefined;
    return { id: row.id, from: { provider: from.provider, model: from.model }, to: { provider: target, model }, at: row.at };
  });

  app.post<{ Params: { id: string }; Body: AnswerModelMapSuggestionRequest | undefined }>('/providers/model-map/suggestions/:id', async (req): Promise<{ ok: true }> => {
    const accept = req.body?.accept;
    if (typeof accept !== 'boolean') throw new Error('accept must be a boolean');
    const row = core.db.decision(req.params.id);
    const answer = row?.answers?.counterpart;
    const pair = row ? pairOf(row.subjectId) : null;
    if (!row || row.point !== 'provider.model-map' || !pair || answer?.kind !== 'choice') throw fail(404, `suggestion ${req.params.id} not found`);
    const now = new Date().toISOString();
    if (accept) {
      const settings = core.providersSettings.get();
      const map: ModelMapEntry[] = settings.rotation?.modelMap ?? [];
      // One entry per model: a model that already has a counterpart is the person's to change in the editor
      if (map.some((e) => e.from.provider === pair.from.provider && e.from.model === pair.from.model)) throw fail(409, `${pair.from.model} already has a counterpart; change it in the mapping`);
      const entry: ModelMapEntry = { from: pair.from, to: { provider: pair.to, model: answer.value }, origin: 'decision', at: now };
      await core.providersSettings.set({ ...settings, rotation: { ...settings.rotation, modelMap: [...map, entry] } });
      settingsChanged();
    }
    // What the person did reaches the decision as feedback, which outranks the resolver's inference from the mapping
    core.db.setDecisionFeedback(row.id, accept ? 'useful' : 'not_useful', now);
    return { ok: true };
  });

  // What claude-swap left behind, said once: the account in force, the policies that are gone
  app.get('/providers/cswap-retirement', (): CswapRetirementState => ({ notice: core.cswapRetirement.read() }));

  app.post('/providers/cswap-retirement/dismiss', async (): Promise<{ ok: true }> => {
    await core.cswapRetirement.dismiss();
    return { ok: true };
  });

  // Agentry's own copy only: claude-swap's data is never touched
  app.delete('/providers/cswap-retirement/managed-copy', async (): Promise<{ removed: boolean }> => ({ removed: await core.cswapRetirement.removeManagedCopy() }));

  app.get<{ Params: { id: string } }>('/providers/:id', async (req): Promise<ProviderStatus> => {
    const status = (await core.providers.statuses()).find((s) => s.id === req.params.id);
    if (!status) throw Object.assign(new Error(`provider ${req.params.id} not found`), { statusCode: 404 });
    return status;
  });

  app.get<{ Params: { id: string } }>('/providers/:id/models', (req): ModelOption[] => {
    const driver = core.runtime.providers.driverFor(req.params.id);
    if (!driver) throw Object.assign(new Error(`provider ${req.params.id} has no driver`), { statusCode: 404 });
    return driver.models();
  });
};
