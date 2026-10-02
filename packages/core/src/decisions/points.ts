import type {
  DecisionChoiceQuestion,
  DecisionNoulQuestion,
  DecisionPointId,
  DecisionPointKind,
  DecisionPrimitive,
  DecisionQuestion,
  DecisionScope,
  DecisionScoreQuestion,
  DecisionSubjectKind,
} from '@agentry/shared';
import { DECISION_POINT_IDS } from './settings.ts';

/*
 * The catalogue of decision points (docs/plans/decision-engine.md, "Decision points on main"). Each
 * entry declares what the point may send and what it asks; a call site only hands the engine a
 * subject. Every question and rubric is English (D4): the providers read `label` and `description`.
 */

/** What a call site knows about the thing being decided; the point's builder picks what is sent */
export interface DecisionSubject {
  kind: DecisionSubjectKind;
  id: string | null;
  /** Everything the caller has. Only the point's `fields` are ever sent, after redaction */
  data: Record<string, unknown>;
}

export interface DecisionPointDefinition {
  id: DecisionPointId;
  kind: DecisionPointKind;
  scope: DecisionScope;
  primitives: readonly DecisionPrimitive[];
  /** Default confidence an act point needs; ignored by suggest points */
  defaultThreshold: number;
  /** Bytes of state the point may send, after redaction */
  maxStateBytes: number;
  /** True when acting on it avoids a Claude run (feeds "Claude runs saved") */
  savesRun: boolean;
  /** True when acting on it changes something a person sees (shows the "decided" mark) */
  visible: boolean;
  /** The provider must be fast enough for the call site; only Jev is */
  needsLowLatency: boolean;
  /** Bumps when the shape of the state changes, which clears the consent given for an older one */
  stateVersion: number;
  /** The subject fields the state may carry, and nothing else */
  fields: readonly string[];
  buildState(subject: DecisionSubject): Promise<Record<string, unknown>>;
  questions(subject: DecisionSubject): ReadonlyArray<DecisionQuestion>;
}

const DEFAULT_MAX_STATE_BYTES = 8 * 1024;
/** Batches that ask one question per item stay well inside a provider's option and token limits */
const MAX_ITEMS = 40;

const choice = (id: string, question: string, options: Array<[string, string]>): DecisionChoiceQuestion => ({
  kind: 'choice',
  id,
  question,
  options: options.map(([optionId, label]) => ({ id: optionId, label })),
});
const noul = (id: string, question: string): DecisionNoulQuestion => ({ kind: 'noul', id, question });
const score = (id: string, question: string, levels: Array<[string, string]>): DecisionScoreQuestion => ({
  kind: 'score',
  id,
  question,
  levels: levels.map(([levelId, description]) => ({ id: levelId, description })),
});

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The items of a list field the caller hands over, each with a string `id` (what the answers are keyed by) */
function items(subject: DecisionSubject, field: string): Array<Record<string, unknown> & { id: string }> {
  const raw = subject.data[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> & { id: string } => isMap(item) && typeof item.id === 'string').slice(0, MAX_ITEMS);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

type Base = Pick<DecisionPointDefinition, 'id' | 'kind' | 'scope' | 'primitives' | 'fields'> & Partial<Pick<DecisionPointDefinition, 'maxStateBytes' | 'savesRun' | 'visible' | 'needsLowLatency'>>;

function point(base: Base, questions: DecisionPointDefinition['questions']): DecisionPointDefinition {
  return {
    defaultThreshold: 0.85,
    maxStateBytes: DEFAULT_MAX_STATE_BYTES,
    savesRun: false,
    visible: true,
    needsLowLatency: false,
    stateVersion: 1,
    ...base,
    buildState: (subject) => {
      const state: Record<string, unknown> = {};
      for (const field of base.fields) if (subject.data[field] !== undefined) state[field] = subject.data[field];
      return Promise.resolve(state);
    },
    questions,
  };
}

const CRITERION = [
  ['met-or-unknown', 'The criterion is met, or nothing here says whether it is'],
  ['needs-a-person', 'Only a person can check this criterion; no run can'],
  ['clearly-unmet', 'The criterion is clearly not met by the work described'],
] as Array<[string, string]>;

export const DECISION_POINTS: readonly DecisionPointDefinition[] = [
  point({ id: 'flow.refine-needed', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: true, fields: ['title', 'description', 'type', 'criteria', 'labels', 'sizeEstimate'] }, () => [
    choice('refine', 'Can this card be built as written, or must it be refined first?', [
      ['ready', 'Ready: the description and acceptance criteria are specific enough to build without refining'],
      ['refine', 'Needs refining: the description or acceptance criteria are vague, missing or contradictory'],
    ]),
  ]),
  point({ id: 'flow.bounce', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: true, fields: ['rejection', 'criteria', 'bounces'] }, () => [
    choice('bounce', "QA rejected this card. Can the Developer fix what QA reported without a person's input?", [
      ['fixable', 'Fixable: the Developer can address every reported problem alone'],
      ['needs-person', 'Needs a person: a decision, access or clarification only a person can give is missing'],
    ]),
  ]),
  point({ id: 'orchestration.retry', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: true, fields: ['error', 'task', 'attempt'] }, () => [
    choice('retry', 'A task failed with this error. Will trying again in the same chat help?', [
      ['transient', 'Transient: the failure looks temporary and a plain retry will likely work'],
      ['fixable', 'Fixable: a retry can work because the task can adjust to the error'],
      ['permanent', 'Permanent: the same error will come back however many times it is retried'],
    ]),
  ]),
  point({ id: 'supervisor.intervene', kind: 'act', scope: 'global', primitives: ['noul'], savesRun: true, fields: ['signal', 'detail', 'calls'] }, () => [
    noul('intervene', 'Is this worker stuck in a way a short hint from a supervisor could get it out of?'),
  ]),
  point({ id: 'memory.triage', kind: 'suggest', scope: 'project', primitives: ['score'], fields: ['proposal', 'target', 'memoryTitles', 'journalTitles'] }, () => [
    score('usefulness', 'How useful is this proposed memory entry to future runs of the project?', [
      ['duplicate', 'Duplicate: an existing entry or journal line already says the same'],
      ['low', 'Low: specific to one moment, or obvious from the code'],
      ['medium', 'Medium: true and occasionally useful'],
      ['high', 'High: a durable fact or rule that future runs would otherwise get wrong'],
    ]),
  ]),
  point({ id: 'assistant.rerank', kind: 'suggest', scope: 'project', primitives: ['score'], fields: ['proposals', 'agents', 'skills', 'commands', 'members'] }, (subject) =>
    items(subject, 'proposals').map((p) =>
      score(p.id, `How valuable is this proposal (${text(p.title)}) for the project?`, [
        ['covered', 'Already covered by something the project has'],
        ['minor', 'Minor: a small gain'],
        ['useful', 'Useful: fills a real gap'],
        ['key', 'Key: the project is clearly missing this'],
      ]),
    ),
  ),
  point({ id: 'assistant.sources', kind: 'act', scope: 'project', primitives: ['noul'], fields: ['brief', 'files'] }, (subject) =>
    items(subject, 'files').map((f) => noul(f.id, `Will the run need to read the file ${text(f.name) || f.id} to do the brief?`)),
  ),
  point({ id: 'journal.relevance', kind: 'act', scope: 'project', primitives: ['score'], maxStateBytes: 16 * 1024, visible: false, fields: ['title', 'criteria', 'entries'] }, (subject) =>
    items(subject, 'entries').map((e) =>
      score(e.id, 'How relevant is this journal entry to the work described?', [
        ['irrelevant', 'Irrelevant: about something unrelated'],
        ['related', 'Related: same area, but the work does not depend on it'],
        ['relevant', 'Relevant: the work should take it into account'],
        ['essential', 'Essential: ignoring it would likely break or repeat earlier work'],
      ]),
    ),
  ),
  point({ id: 'board.triage', kind: 'suggest', scope: 'project', primitives: ['choice', 'noul'], fields: ['title', 'description', 'openItems', 'epics'] }, () => [
    choice('type', 'What kind of work item is this draft?', [
      ['task', 'A task: routine work with a clear end'],
      ['bug', 'A bug: something that worked and no longer does, or never worked as intended'],
      ['story', 'A story: a user-visible capability with several tasks behind it'],
    ]),
    choice('priority', 'How urgent is this draft?', [
      ['low', 'Low: nice to have'],
      ['medium', 'Medium: planned work'],
      ['high', 'High: blocks or degrades real use'],
      ['urgent', 'Urgent: something is broken for people now'],
    ]),
    noul('duplicate', 'Does an existing open item already cover this draft?'),
  ]),
  point({ id: 'team.assign', kind: 'suggest', scope: 'project', primitives: ['choice'], fields: ['title', 'type', 'criteria', 'members'] }, (subject) => {
    const members = items(subject, 'members');
    if (members.length < 2) return [];
    return [choice('member', 'Which team member is the best fit for this card?', members.map((m): [string, string] => [m.id, `${text(m.role) || m.id}: ${text(m.responsibilities)}`.trim()]))];
  }),
  point({ id: 'flow.scope-drift', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['title', 'criteria', 'commits'] }, (subject) =>
    items(subject, 'commits').map((c) => noul(c.id, 'Does this commit do work beyond what the card asks for?')),
  ),
  point({ id: 'flow.criteria-precheck', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: true, fields: ['criteria', 'summary', 'commits', 'paths'] }, (subject) =>
    items(subject, 'criteria').map((c) => choice(c.id, `Given the work described, where does this acceptance criterion stand: "${text(c.text)}"?`, CRITERION)),
  ),
  point({ id: 'flow.criteria-merge', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['existing', 'proposed'] }, (subject) =>
    items(subject, 'proposed').map((c) => noul(c.id, 'Does this proposed criterion say the same as one of the existing criteria?')),
  ),
  point({ id: 'flow.restart', kind: 'act', scope: 'project', primitives: ['noul'], savesRun: true, visible: false, fields: ['stage', 'cause', 'restarts', 'error'] }, () => [
    noul('requeue', 'Is it worth running this flow run again after the restart cut it?'),
  ]),
  point({ id: 'run.continuation', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: true, visible: false, maxStateBytes: 4 * 1024, fields: ['title', 'tail', 'continuations'] }, () => [
    choice('report', 'Is the last paragraph of this run a final report, or does it say work is still owed?', [
      ['done', 'Done: a report of finished work; nothing is left to do'],
      ['owes-work', 'Owes work: it announces a next step, offers to continue or leaves something undone'],
    ]),
  ]),
  point({ id: 'orchestration.model', kind: 'suggest', scope: 'project', primitives: ['choice'], fields: ['tasks', 'models'] }, (subject) => {
    const models = items(subject, 'models');
    if (models.length < 2) return [];
    return items(subject, 'tasks').map((t) => choice(t.id, 'Which model is the cheapest one that can do this task well?', models.map((m): [string, string] => [m.id, text(m.label) || m.id])));
  }),
  point({ id: 'orchestration.fixer', kind: 'act', scope: 'project', primitives: ['noul'], savesRun: true, fields: ['checks', 'failedSpecs', 'notes', 'attempt'] }, () => [
    noul('another-attempt', 'Is another fixer attempt likely to make these failing checks pass?'),
  ]),
  point({ id: 'health.semantic-loop', kind: 'suggest', scope: 'global', primitives: ['noul'], fields: ['calls'] }, () => [
    noul('loop', 'Is this worker repeating the same kind of step without making progress?'),
  ]),
  point({ id: 'health.test-weakening', kind: 'suggest', scope: 'global', primitives: ['noul'], fields: ['path', 'before', 'after'] }, () => [
    noul('weakened', 'Does this edit make the test weaker: fewer or looser assertions, skipped cases or a tautology?'),
  ]),
  point({ id: 'changes.unexplained-hunk', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['hunk', 'step', 'title'] }, () => [
    noul('unexplained', 'Does the sentence before the change fail to explain this hunk?'),
  ]),
  point({ id: 'palette.intent', kind: 'suggest', scope: 'global', primitives: ['choice'], needsLowLatency: true, maxStateBytes: 16 * 1024, fields: ['query', 'commands'] }, (subject) => {
    const commands = items(subject, 'commands');
    if (commands.length === 0) return [];
    return [choice('command', 'Which command does the query ask for?', [...commands.map((c): [string, string] => [c.id, text(c.title) || c.id]), ['none', 'None of these commands'] as [string, string]])];
  }),
  point({ id: 'notification.urgency', kind: 'act', scope: 'global', primitives: ['choice'], visible: false, maxStateBytes: 2 * 1024, fields: ['kind', 'title', 'body'] }, () => [
    choice('urgency', 'Should this notification interrupt the person now?', [
      ['normal', 'Normal: it can wait until the person next looks'],
      ['high', 'High: the person would want to know right away'],
    ]),
  ]),
  // The tails are the host's CI output, untrusted: they are data for the question and nothing else. `headSha` is what the resolver reads the outcome against
  point({ id: 'checks.fix', kind: 'act', scope: 'project', primitives: ['choice'], savesRun: false, maxStateBytes: 32 * 1024, fields: ['checks', 'attempt', 'diffStat', 'headSha'] }, () => [
    choice('fix', 'Did the changes on this branch cause these check failures, in a way the Developer can fix?', [
      ['branch-fixable', 'Branch-fixable: the branch caused the failures and the Developer can fix them by changing code'],
      ['not-branch', 'Not the branch: infrastructure, a flaky test or a change unrelated to this branch'],
      ['needs-person', 'Needs a person: a decision, access or a secret only a person can give is missing'],
    ]),
  ]),
  // Review comments are other people's text: they are data for the question and nothing else. The caller hands the unresolved threads; at most 40 are asked, each body already cut to 1 KiB
  point({ id: 'review.triage', kind: 'suggest', scope: 'project', primitives: ['choice'], maxStateBytes: 64 * 1024, fields: ['title', 'threads'] }, (subject) =>
    items(subject, 'threads').map((thread) =>
      choice(thread.id, `Who should take this review comment${text(thread.path) ? ` on ${text(thread.path)}` : ''}?`, [
        ['agent', 'An agent: it asks for a concrete code change the Developer can make'],
        ['person', 'A person: it is a question, a design decision or a disagreement'],
        ['no-action', 'No action: praise, a point already resolved or a nit already done'],
      ]),
    ),
  ),
  // An issue is a stranger's text: it is data for the question and nothing else. The caller hands one page of the import list; at most 40 are asked, each body already cut to 2 KiB
  point({ id: 'issue.triage', kind: 'suggest', scope: 'project', primitives: ['choice'], maxStateBytes: 96 * 1024, fields: ['tracker', 'issues'] }, (subject) =>
    items(subject, 'issues').map((issue) =>
      choice(issue.id, `Can an agent start on issue ${text(issue.id)}${text(issue.title) ? ` ("${text(issue.title)}")` : ''} as written?`, [
        ['ready', 'Ready: the goal and the acceptance are clear and the work is inside the repository'],
        ['needs-refining', 'Needs refining: the goal or the acceptance is unclear'],
        ['not-for-agents', 'Not for agents: it needs a person, for access, a decision or work outside the repository'],
      ]),
    ),
  ),
];

const BY_ID: ReadonlyMap<DecisionPointId, DecisionPointDefinition> = new Map(DECISION_POINTS.map((p) => [p.id, p]));

export function decisionPoint(id: DecisionPointId): DecisionPointDefinition | undefined {
  return BY_ID.get(id);
}

// A point missing from the catalogue would compile into a hole in the settings; refuse at load
for (const id of DECISION_POINT_IDS) if (!BY_ID.has(id)) throw new Error(`decision point ${id} has no definition`);
