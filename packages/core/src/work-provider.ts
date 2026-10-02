import type { ProjectProvidersSettings, ProviderCapability, ProviderId, ProvidersSettings, ProviderStatus, ToolPolicy } from '@agentry/shared';
import type { ChatManager } from './chats.ts';
import type { ProviderPoints, WorkKind, WorkSubjectKind } from './decisions/provider-points.ts';
import { stanceOf, type DecisionAsker } from './decisions/stance.ts';
import { candidateContext } from './rotation.ts';
import { candidatesFor, type CandidateResult } from './providers/candidates.ts';

/*
 * Where automated work starts (docs/plans/multi-provider.md, phase 4, "Starting automated work").
 * A flow run, an orchestration task or an assistant run used to start on whatever the default
 * session provider was, with Claude's rule strings and no policy. Starting uses the function a move
 * uses, with `from: null`: the first provider that is ready, can enforce the work's policy (`git push`
 * included) and has a counterpart for its model. `provider.pick` may choose another one among those.
 */

/** No provider can take the work: none is ready, or none can enforce its policy. The work fails with `no-provider`. */
export class NoProviderError extends Error {
  constructor(readonly why: string) {
    super(`no provider can take this work: ${why}`);
    this.name = 'NoProviderError';
  }
}

export interface StartInput {
  kind: WorkKind;
  subjectKind: WorkSubjectKind;
  subjectId: string;
  projectId: string | null;
  /** What the work is called, for the pick's question */
  title: string;
  /** A model of Claude Code (members and tasks name Claude's aliases); null takes the provider's own default */
  model: string | null;
  /** `structuredOutput` for a schema, `budgetLimit` for a budget, `workflowTool` for the workflow engine… */
  needs: ProviderCapability[];
  /** Null for work confined by rules typed for one provider: it stays on Claude Code */
  policy: ToolPolicy | null;
  /** The work runs on rules typed for one provider (`allowedTools` of a graph): they cannot be translated */
  nativeRules?: boolean;
  effort?: string | null;
}

export interface StartChoice {
  provider: ProviderId;
  /** The model on that provider; null when the work names none */
  model: string | null;
  effort: string | null;
  decisionId: string | null;
}

export interface WorkProvidersDeps {
  runtime: Pick<ChatManager, 'providers' | 'limits'>;
  settings: () => ProvidersSettings;
  projectProviders: (projectId: string) => ProjectProvidersSettings | null;
  /** The detector's reading, measured when none is kept */
  statuses: () => Promise<ProviderStatus[]>;
  /** The detector's last reading, whatever its age; null before the first */
  known: () => ProviderStatus[] | null;
  decisions: DecisionAsker | null;
  points: ProviderPoints | null;
}

/** The provider a unit of automated work starts on. */
export class WorkProviders {
  constructor(private readonly deps: WorkProvidersDeps) {}

  private candidatesOf(input: StartInput, statuses: readonly ProviderStatus[]): { result: CandidateResult; project: ProjectProvidersSettings | null } {
    const project = input.projectId ? this.deps.projectProviders(input.projectId) : null;
    const context = candidateContext(this.deps.runtime, { settings: this.deps.settings(), project, statuses });
    const result = candidatesFor(
      {
        kind: input.kind,
        from: null,
        model: input.model ? { provider: 'claude-code', id: input.model } : null,
        needs: input.needs,
        policy: input.policy,
        nativeRules: input.nativeRules ?? input.policy === null,
        automated: true,
        exclude: [],
        effort: input.effort ?? null,
      },
      context,
    );
    return { result, project };
  }

  /**
   * The first candidate. When every provider that could take the work is at its limit, the work
   * still starts on the first of them: the rotation waits for the reset there, which is better than
   * a run that never starts.
   */
  private first(result: CandidateResult): StartChoice {
    const first = result.candidates[0];
    if (first) return { provider: first.provider, model: first.model, effort: first.effort, decisionId: null };
    throw new NoProviderError(result.excluded.map((e) => `${e.provider}: ${e.excluded}`).join(', ') || 'none is set up');
  }

  private atLimitOnly(result: CandidateResult, input: StartInput): StartChoice | null {
    const exhausted = result.excluded.find((e) => e.excluded === 'exhausted');
    if (!exhausted) return null;
    const driver = this.deps.runtime.providers.driverFor(exhausted.provider);
    const model = input.model ? (exhausted.provider === 'claude-code' ? input.model : null) : null;
    return driver ? { provider: exhausted.provider, model, effort: null, decisionId: null } : null;
  }

  /**
   * Without `provider.pick`: what a synchronous launch can know. Null when the detector has not read
   * the providers yet, so the caller keeps the default it always had.
   */
  chooseNow(input: StartInput): StartChoice | null {
    const statuses = this.deps.known();
    if (!statuses || statuses.length === 0) return null;
    const { result } = this.candidatesOf(input, statuses);
    return result.candidates.length > 0 ? this.first(result) : (this.atLimitOnly(result, input) ?? this.first(result));
  }

  /** Whether `provider.pick` would be asked about this work: more than one provider can take it and the point is on. */
  wantsPick(input: StartInput): boolean {
    return stanceOf(this.deps.decisions, 'provider.pick', input.projectId) !== 'off' && this.deps.points !== null;
  }

  /** The provider the work starts on, `provider.pick` included. Throws `NoProviderError`. */
  async choose(input: StartInput): Promise<StartChoice> {
    const statuses = await this.deps.statuses();
    const { result } = this.candidatesOf(input, statuses);
    if (result.candidates.length === 0) return this.atLimitOnly(result, input) ?? this.first(result);
    const first = this.first(result);
    const stance = stanceOf(this.deps.decisions, 'provider.pick', input.projectId);
    if (stance === 'off' || !this.deps.points || result.candidates.length < 2) return first;
    const label = (id: ProviderId): string => this.deps.runtime.providers.list().find((m) => m.id === id)?.label ?? id;
    const minutesTo = (iso: string | null): number | null => (iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000)) : null);
    const answer = await this.deps.points.pick(stance, {
      kind: input.subjectKind,
      id: input.subjectId,
      projectId: input.projectId,
      work: { kind: input.kind, name: input.title },
      title: input.title,
      model: input.model,
      candidates: result.candidates.slice(0, 3).map((c) => ({
        id: c.provider,
        label: label(c.provider),
        model: c.model ?? '',
        utilization: c.utilization === null ? null : Math.round(c.utilization * 100),
        resetsInMin: minutesTo(c.resetsAt),
      })),
    });
    const chosen = answer ? result.candidates.find((c) => c.provider === answer.provider) : undefined;
    return chosen && answer ? { provider: chosen.provider, model: chosen.model, effort: chosen.effort, decisionId: answer.decisionId } : first;
  }
}
