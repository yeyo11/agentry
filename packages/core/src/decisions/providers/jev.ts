// The only file that imports @typesafe-ai/sdk (CONTRIBUTING.md, "typed decision services"): a new
// SDK, or a plain fetch, replaces this file and nothing else.
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  choice,
  noul,
  RateLimitError,
  score,
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import type { DecisionAnswer, DecisionQuestion, DecisionUnavailableReason } from '@agentry/shared';
import type { DecisionProvider, DecisionRequest, ProviderResult } from '../engine.ts';
import { JEV_MODEL } from '../settings.ts';

/** The one call the adapter makes; tests stub it instead of the network */
export interface JevClient {
  systemOne(request: SystemOneRequest<Questions>, options: { signal: AbortSignal; timeout: number }): Promise<SystemOneResult<Questions>>;
}

export interface JevProviderOptions {
  /** The saved key, read on every call so saving or removing one takes effect at once */
  getKey: () => string | null;
  /** The model is pinned (it never upgrades by itself); overridable for tests only */
  model?: string;
  createClient?: (apiKey: string) => JevClient;
  /** Wait before the one retry; a shorter `Retry-After` wins */
  backoffMs?: number;
}

const RETRY_BACKOFF_MS = 150;

/** Option and level ids are the labels the model answers with; the human words ride as descriptions */
export function toSdkQuestions(questions: ReadonlyArray<DecisionQuestion>): Questions {
  const out: Questions = {};
  for (const q of questions) {
    if (q.kind === 'choice') {
      out[q.id] = choice(q.question, Object.fromEntries(q.options.map((o) => [o.id, o.label])));
    } else if (q.kind === 'score') {
      const [first, second, ...rest] = q.levels.map((l) => l.description);
      out[q.id] = score(q.question, [first ?? null, second ?? null, ...rest] as const);
    } else {
      out[q.id] = noul(q.question);
    }
  }
  return out;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function probabilitiesOf(raw: unknown, key: (k: string) => string | null): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const mapped = key(k);
    if (mapped === null || typeof v !== 'number') return null;
    out[mapped] = v;
  }
  return out;
}

/** Maps the SDK's answers back to ours; null when one is missing or does not fit its question */
export function fromSdkAnswers(questions: ReadonlyArray<DecisionQuestion>, result: SystemOneResult<Questions>): Record<string, DecisionAnswer> | null {
  const answers: Record<string, DecisionAnswer> = {};
  for (const q of questions) {
    const a = (result.answers as Record<string, unknown> | undefined)?.[q.id] as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') return null;
    if (q.kind === 'choice') {
      if (a.type !== 'choice' || typeof a.choice !== 'string' || typeof a.confidence !== 'number') return null;
      if (!q.options.some((o) => o.id === a.choice)) return null;
      answers[q.id] = { kind: 'choice', value: a.choice, probabilities: probabilitiesOf(a.probabilities, (k) => k), confidence: clamp01(a.confidence) };
    } else if (q.kind === 'score') {
      if (a.type !== 'score' || typeof a.score !== 'number' || !Number.isFinite(a.score) || typeof a.confidence !== 'number') return null;
      // The SDK reports an expected score that may fall between levels; the nearest level is ours
      const level = q.levels[Math.min(q.levels.length - 1, Math.max(0, Math.round(a.score)))];
      if (!level) return null;
      answers[q.id] = {
        kind: 'score',
        value: level.id,
        probabilities: probabilitiesOf(a.probabilities, (k) => q.levels[Number(k)]?.id ?? null),
        confidence: clamp01(a.confidence),
      };
    } else {
      if (a.type !== 'noul' || typeof a.noul !== 'number' || !Number.isFinite(a.noul)) return null;
      const p = clamp01(a.noul);
      // A yes/no has no confidence of its own: how far its probability sits from a coin flip is it
      answers[q.id] = { kind: 'noul', value: p >= 0.5, probability: p, confidence: Math.max(p, 1 - p) };
    }
  }
  return answers;
}

/** Only the status and the kind of failure are read: an error body may echo the request */
export function reasonOf(error: unknown): DecisionUnavailableReason {
  if (error instanceof APIUserAbortError || error instanceof APITimeoutError) return 'timeout';
  if (error instanceof APIConnectionError) return 'network';
  if (error instanceof RateLimitError) return 'rate-limited';
  if (error instanceof APIError) {
    if (error.status === 529) return 'rate-limited';
    if (error.status === 402) return 'no-quota';
    if (error.status === 401 || error.status === 403) return 'no-key';
    if (error.status === 400 || error.status === 422) return 'invalid-answer';
  }
  return 'server-error';
}

const retryable = (error: unknown): boolean => error instanceof RateLimitError || (error instanceof APIError && error.status === 529);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export class JevProvider implements DecisionProvider {
  readonly id = 'jev' as const;
  private readonly opts: JevProviderOptions;
  private cached: { key: string; client: JevClient } | null = null;

  constructor(opts: JevProviderOptions) {
    this.opts = opts;
  }

  available(): boolean {
    return this.opts.getKey() !== null;
  }

  whyUnavailable(): DecisionUnavailableReason {
    return 'no-key';
  }

  private clientFor(key: string): JevClient {
    if (this.cached?.key !== key) {
      // The SDK's own retries are off: the adapter retries once, inside the deadline
      const make =
        this.opts.createClient ??
        ((apiKey: string): JevClient => new TypeSafeClient({ apiKey, defaultModel: this.opts.model ?? JEV_MODEL, retry: { maxRetries: 0 }, logLevel: 'off' }));
      this.cached = { key, client: make(key) };
    }
    return this.cached.client;
  }

  async ask(request: DecisionRequest, opts: { deadlineMs: number; signal: AbortSignal }): Promise<ProviderResult> {
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;
    const key = this.opts.getKey();
    if (!key) return { status: 'unavailable', reason: 'no-key', latencyMs: 0 };

    const model = this.opts.model ?? JEV_MODEL;
    let payload: SystemOneRequest<Questions>;
    try {
      payload = { state: request.state as SystemOneRequest['state'], questions: toSdkQuestions(request.questions), model };
    } catch {
      return { status: 'unavailable', reason: 'invalid-answer', latencyMs: elapsed() };
    }
    const client = this.clientFor(key);

    for (let attempt = 0; ; attempt++) {
      const remaining = opts.deadlineMs - elapsed();
      if (remaining <= 0 || opts.signal.aborted) return { status: 'unavailable', reason: 'timeout', latencyMs: elapsed() };
      try {
        const result = await client.systemOne(payload, { signal: opts.signal, timeout: remaining });
        const answers = fromSdkAnswers(request.questions, result);
        if (!answers) return { status: 'unavailable', reason: 'invalid-answer', latencyMs: elapsed() };
        return {
          status: 'answered',
          answers,
          latencyMs: elapsed(),
          inputTokens: typeof result.usage?.input_tokens === 'number' ? result.usage.input_tokens : null,
          // TypeSafe reports tokens, not a price, and a guessed one would be shown as fact
          costUsd: null,
          model: typeof result.model === 'string' && result.model ? result.model : model,
        };
      } catch (error) {
        if (attempt === 0 && retryable(error)) {
          const asked = error instanceof RateLimitError ? error.retryAfterMs : undefined;
          const wait = Math.min(asked ?? Infinity, this.opts.backoffMs ?? RETRY_BACKOFF_MS);
          if (opts.deadlineMs - elapsed() > wait) {
            await sleep(wait, opts.signal);
            continue;
          }
        }
        return { status: 'unavailable', reason: reasonOf(error), latencyMs: elapsed() };
      }
    }
  }
}
