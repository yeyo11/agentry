// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';
import type { EffortUse } from '@agentry/shared';
import { effortWords, EffortField, EffortPicker, EffortTag, type EffortUnavailable } from '../src/components/EffortPicker';
import { memberBody } from '../src/pages/team/model';
import { draftOfVerification, verificationOf } from '../src/lib/orchestration-v2';
import { withEffort } from '../src/pages/chat/Controls';
import { TaskEditor } from '../src/components/TaskEditor';
import { cleanTask } from '../src/lib/orchestration-v2';
import i18n from '../src/i18n';

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>{children}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

test.beforeEach(async () => {
  await i18n.changeLanguage('en');
});

const words = (model: string | null, use: EffortUse, o: { inherited?: string | null; unavailable?: EffortUnavailable; set?: boolean } = {}) =>
  effortWords(i18n.getFixedT(null, 'components'), model, use, { set: false, ...o });

test('unset reads the level recommended for the model and the use, in both languages', async () => {
  assert.equal(words('sonnet', 'chat').unset, 'medium · recommended');
  assert.equal(words('claude-sonnet-5-5', 'planner').unset, 'high · recommended', 'the planner of Sonnet 5.5 is a harder use');
  assert.match(words('opus', 'chat').tip, /Opus 5.5/, 'the reason is the tooltip');
  await i18n.changeLanguage('es');
  assert.equal(words('opus', 'chat').unset, 'medium · recomendado');
  assert.match(words('opus', 'chat').tip, /Opus 5.5/);
});

test('a model with no recommendation says the CLI decides, with no reason to give', () => {
  assert.deepEqual(words('haiku', 'chat'), { unset: 'CLI default', tip: '' });
  assert.equal(words(null, 'chat').unset, 'CLI default');
});

test('a chosen level carries no recommendation tooltip', () => {
  assert.equal(words('opus', 'chat', { set: true }).tip, '');
});

test('a resume that sets nothing says it starts as before', () => {
  assert.equal(words('opus', 'chat', { inherited: 'high' }).unset, 'high · as before');
  assert.equal(words('opus', 'chat', { inherited: 'high' }).tip, '');
});

test('the picker is disabled, with the reason, where the provider has no effort or the engine is the workflow', () => {
  assert.match(words('opus', 'chat', { unavailable: 'provider' }).tip, /does not take an effort/);
  assert.match(words('opus', 'worker', { unavailable: 'workflow' }).tip, /whole orchestration/);
  const off = (unavailable?: EffortUnavailable) => wrap(<EffortPicker value="" onChange={() => {}} model="opus" use="chat" unavailable={unavailable} />);
  assert.match(off('provider'), /<button[^>]*disabled/);
  assert.match(off('workflow'), /<button[^>]*disabled/);
  assert.doesNotMatch(off(), /<button[^>]*disabled/);
});

test('the field carries its label and the tag only shows an effort that was passed', () => {
  assert.match(wrap(<EffortField value="" onChange={() => {}} model="opus" use="chat" />), /<span class="field-label">Effort<\/span>/);
  assert.equal(wrap(<EffortTag effort={null} />), '');
  assert.match(wrap(<EffortTag effort="medium" />), /class="model-tag effort-tag"[^>]*>medium</);
});

test('a team member keeps its effort in the body it is saved with, and the picker can clear it', () => {
  const member = { role: 'qa', model: 'sonnet', responsibility: '', effort: 'high' as const };
  assert.equal(memberBody(member).effort, 'high', 'saving the model alone does not drop the effort');
  assert.equal(memberBody(member, { effort: 'max' }).effort, 'max');
  assert.ok(!('effort' in memberBody(member, { effort: null })), 'unset goes back to the recommendation');
  assert.ok(!('effort' in memberBody({ ...member, effort: undefined })));
});

test('the fixer of a verification keeps its effort through the form', () => {
  const spec = { commands: ['pnpm test'], fixer: true, maxAttempts: 2, effort: 'high' as const };
  const draft = draftOfVerification(spec);
  assert.equal(draft.effort, 'high');
  assert.equal(verificationOf(draft)?.effort, 'high');
  assert.ok(!('effort' in (verificationOf({ ...draft, effort: undefined }) ?? {})));
});

test('a resume or a fork sends the effort chosen, and nothing when it is left unset', () => {
  const chosen = withEffort({ model: 'opus' }, 'xhigh');
  assert.deepEqual({ prompt: 'go', ...chosen }, { prompt: 'go', model: 'opus', effort: 'xhigh' }, 'the composer spreads the choices into the request');
  assert.ok(!('effort' in withEffort(chosen, '')));
  assert.deepEqual(chosen, { model: 'opus', effort: 'xhigh' }, 'the choices it was given are not changed');
});

test("a graph's task carries its effort into the launch, and on the workflow engine only the orchestration's applies", () => {
  const task = { id: 'a', name: 'A', prompt: 'do it', dependsOn: [], effort: 'max' as const };
  assert.equal(cleanTask(task).effort, 'max');
  const editor = (engine: 'graph' | 'workflow') => wrap(<TaskEditor task={task} others={[]} onChange={() => {}} onRemove={() => {}} engine={engine} orchestrationModel="opus" />);
  const effortTrigger = (html: string) => html.match(/<button[^>]*aria-label="Effort"[^>]*>/)?.[0] ?? '';
  assert.doesNotMatch(effortTrigger(editor('graph')), /disabled/);
  assert.match(effortTrigger(editor('workflow')), /disabled/);
});
