import type { DecisionAnswer, DecisionQuestion, DecisionSettings, DecisionUnavailableReason, ProviderId, ProviderStatus, ToolPolicy } from '@agentry/shared';
import type { ChatRuntime, NewChat, RunResult } from '../../chats.ts';
import { stoppedOnMaxTokens } from '../../open-items.ts';
import { PASTED_NOTE, pasted, thinkThrough } from '../../prompt-rules.ts';
import { candidatesFor, type CandidateContext } from '../../providers/candidates.ts';
import type { DecisionProvider, DecisionRequest, ProviderResult } from '../engine.ts';

/*
 * The `cli` provider: an agent's CLI and nothing else. One housekeeping chat answers one batch of
 * questions in one turn. It has no tool and no callback: the state is in the prompt and the answers
 * come back as `structured_output`, so the chat gets no API url or token either. It runs on the first
 * ready provider that declares `structuredOutput` and has a model for the configured one (decision 9);
 * with nothing handed to `route` it is Claude Code, as before.
 */

/** The part of the chat runtime this provider drives; the tests hand it the real one over a fake CLI */
export interface CliRuntime {
  start(opts: NewChat): ChatRuntime;
  waitForResult(id: string): Promise<RunResult>;
  stop(id: string): unknown;
  exited(id: string): Promise<void>;
  remove(id: string): boolean;
}

/**
 * What a decision chat may do: nothing. It has no tool, so the policy states that outright; a provider
 * can take the chat only where this is enforced, which is what lets it run on another provider
 * (decision 9) without the chat being a person's.
 */
export const DECISION_POLICY: ToolPolicy = { read: { allow: false }, edit: { allow: 'none' }, commands: { allow: 'none' }, network: 'deny', gitPush: 'deny' };

/** Where the chat runs: a provider, and the model of its own that stands for the configured one */
export interface CliRoute {
  provider: ProviderId;
  model: string;
  effort: string | null;
}

export interface CliProviderDeps {
  runtime: CliRuntime;
  settings: { get(): Pick<DecisionSettings, 'cli'> };
  /**
   * Chooses the provider for one question. A reason means none can take it, and the answer is that
   * reason now; the decision never waits for a provider's reset. Without it the chat runs on the
   * default provider, as it did before rotation.
   */
  route?: (cli: DecisionSettings['cli']) => CliRoute | { unavailable: DecisionUnavailableReason };
}

/**
 * The first provider of the person's order that can answer a decision: ready, with a session driver,
 * `structuredOutput`, not at its limit and with a model for the configured one. A decision chat never
 * moves and never waits, so a provider at its limit is simply passed over. With none, the answer is
 * `rate-limited` when a limit is what ruled one out, and `server-error` when nothing was there to try.
 */
export function chooseCliRoute(cli: DecisionSettings['cli'], context: CandidateContext): CliRoute | { unavailable: DecisionUnavailableReason } {
  const result = candidatesFor(
    {
      kind: 'decision',
      from: null,
      // The configured model is Claude's (`haiku`): another provider needs the person's mapping for it
      model: { provider: 'claude-code', id: cli.model },
      needs: ['structuredOutput'],
      policy: DECISION_POLICY,
      nativeRules: false,
      automated: true,
      exclude: [],
      effort: cli.effort,
    },
    context,
  );
  const first = result.candidates[0];
  if (first?.model) return { provider: first.provider, model: first.model, effort: first.effort };
  return { unavailable: result.excluded.some((e) => e.excluded === 'exhausted') ? 'rate-limited' : 'server-error' };
}

/**
 * The route of a decision chat from the providers as last read. Before they have been read once
 * nothing can be weighed, so Claude Code answers with the configured model, as it did before there
 * were providers to choose from, rather than no provider at all.
 */
export function decisionRoute(
  cli: DecisionSettings['cli'],
  statuses: readonly ProviderStatus[] | null,
  context: (statuses: ProviderStatus[]) => CandidateContext,
): CliRoute | { unavailable: DecisionUnavailableReason } {
  if (!statuses) return { provider: 'claude-code', model: cli.model, effort: cli.effort ?? null };
  return chooseCliRoute(cli, context([...statuses]));
}

/** How long a stopped chat gets to end before it is removed regardless */
const EXIT_GRACE_MS = 5_000;

/** The schema the CLI holds the answer to: an enum per choice or score, a boolean per noul. No reason field, by design. */
export function decisionSchema(questions: ReadonlyArray<DecisionQuestion>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const q of questions) {
    properties[q.id] =
      q.kind === 'choice'
        ? { type: 'string', enum: q.options.map((o) => o.id) }
        : q.kind === 'score'
          ? { type: 'string', enum: q.levels.map((l) => l.id) }
          : { type: 'boolean' };
  }
  return { type: 'object', properties, required: questions.map((q) => q.id), additionalProperties: false };
}

function describe(q: DecisionQuestion): string[] {
  if (q.kind === 'choice') return [`${q.id}: ${q.question}`, ...q.options.map((o) => `  - ${o.id}: ${o.label}`)];
  if (q.kind === 'score') return [`${q.id}: ${q.question} Levels, lowest first:`, ...q.levels.map((l) => `  - ${l.id}: ${l.description}`)];
  return [`${q.id}: ${q.question} Answer true or false.`];
}

/**
 * The prompt: the state inside one `pasted()` block with the note that marks it as material, the
 * questions, and, for a Sonnet model, the instruction to think first. One turn, so it carries
 * neither the unattended text nor a continuation.
 */
export function decisionPrompt(request: DecisionRequest, model: string): string {
  return [
    'Answer the questions below from the state that follows, in the structured result. Give one answer per question and nothing else.',
    PASTED_NOTE,
    pasted(JSON.stringify(request.state, null, 2)),
    'Questions:',
    ...request.questions.flatMap(describe),
    ...thinkThrough(model),
  ].join('\n\n');
}

/** Reads the structured result against the questions; null when any answer is missing or off its options */
export function parseAnswers(raw: unknown, questions: ReadonlyArray<DecisionQuestion>): Record<string, DecisionAnswer> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const given = raw as Record<string, unknown>;
  const answers: Record<string, DecisionAnswer> = {};
  for (const q of questions) {
    const value = given[q.id];
    if (q.kind === 'noul') {
      if (typeof value !== 'boolean') return null;
      answers[q.id] = { kind: 'noul', value, probability: null, confidence: null };
      continue;
    }
    const ids = q.kind === 'choice' ? q.options.map((o) => o.id) : q.levels.map((l) => l.id);
    if (typeof value !== 'string' || !ids.includes(value)) return null;
    // No calibrated confidence from the CLI: a null never clears a threshold
    answers[q.id] = { kind: q.kind, value, probabilities: null, confidence: null };
  }
  return answers;
}

export class CliDecisionProvider implements DecisionProvider {
  readonly id = 'cli' as const;

  constructor(private readonly deps: CliProviderDeps) {}

  /** The CLI is the wrapper's own runtime, so it is there whenever the wrapper is; CW-4's quota hold joins here */
  available(): boolean {
    return true;
  }

  whyUnavailable(): DecisionUnavailableReason {
    return 'server-error';
  }

  async ask(request: DecisionRequest, opts: { deadlineMs: number; signal: AbortSignal }): Promise<ProviderResult> {
    const startedAt = Date.now();
    const unavailable = (reason: DecisionUnavailableReason): ProviderResult => ({ status: 'unavailable', reason, latencyMs: Date.now() - startedAt });
    const cli = this.deps.settings.get().cli;
    const { maxCostUsd } = cli;
    let model = cli.model;
    let effort: string | null = cli.effort;
    let provider: ProviderId | undefined;
    if (this.deps.route) {
      let route: ReturnType<NonNullable<CliProviderDeps['route']>>;
      try {
        route = this.deps.route(cli);
      } catch {
        return unavailable('server-error');
      }
      if ('unavailable' in route) return unavailable(route.unavailable);
      ({ model, effort, provider } = route);
    }
    if (opts.signal.aborted) return unavailable('timeout');

    let chat: ChatRuntime;
    try {
      chat = this.deps.runtime.start({
        prompt: decisionPrompt(request, model),
        name: `decision ${request.point}`,
        ...(provider ? { provider } : {}),
        model,
        // The configured effort when the route kept it; the target's own default when it has no such level
        ...(effort ? { effort } : {}),
        maxBudgetUsd: maxCostUsd,
        jsonSchema: decisionSchema(request.questions),
        internal: true,
        keepAlive: false,
        uploads: false,
        api: false,
        confine: { tools: [], settingSources: [] },
        toolConfig: { preset: null, allowedTools: [], disallowedTools: [], mcp: null, policy: DECISION_POLICY },
        permissionMode: 'dontAsk',
        permissionPrompts: 'none',
      });
    } catch {
      return unavailable('server-error');
    }

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const cut = new Promise<'cut'>((resolve) => {
        timer = setTimeout(() => resolve('cut'), opts.deadlineMs);
        onAbort = () => resolve('cut');
        opts.signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([this.deps.runtime.waitForResult(chat.id), cut]);
      if (result === 'cut') return unavailable('timeout');
      // No quota wait and no rotation-and-resume for a decision: the answer is "rate-limited", now
      if (result.cause === 'rate-limit') return unavailable('rate-limited');
      if (result.isError) return unavailable('server-error');
      if (stoppedOnMaxTokens(result)) return unavailable('max-tokens');
      const answers = parseAnswers(result.structuredOutput, request.questions);
      if (!answers) return unavailable('invalid-answer');
      return { status: 'answered', answers, latencyMs: Date.now() - startedAt, inputTokens: null, costUsd: result.costUsd, model };
    } catch {
      return unavailable('server-error');
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal.removeEventListener('abort', onAbort);
      await this.dispose(chat.id);
    }
  }

  /** Stops what is still running and removes the chat: the decision is the row, the chat leaves nothing behind */
  private async dispose(id: string): Promise<void> {
    try {
      this.deps.runtime.stop(id);
    } catch {
      // already over
    }
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([this.deps.runtime.exited(id), new Promise((r) => (grace = setTimeout(r, EXIT_GRACE_MS)))]).catch(() => undefined);
    if (grace) clearTimeout(grace);
    this.deps.runtime.remove(id);
  }
}
