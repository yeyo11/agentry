// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantProposalCount, AssistantRunDetail } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { formatRunClock } from '../src/components/assistant/run';
import i18n from '../src/i18n';
import { LiveWriting } from '../src/pages/home/resources/CreateWithAI';

// The assistant's screens in orchestration 6: "Create with AI" shows the file as it is written (gap
// 12), and a run's clock reads as the references write it (gap 23).

const zero: AssistantProposalCount = { total: 0, pending: 0, accepted: 0, discarded: 0, superseded: 0 };
const writing = (over: Partial<AssistantRunDetail> = {}): AssistantRunDetail => ({
  id: 'r1',
  projectId: 'p',
  kind: 'resources',
  status: 'running',
  model: 'sonnet',
  description: 'An agent that reads each Spanish sentence against the glossary',
  resourceKind: 'agents',
  chatId: 'c1',
  empty: false,
  template: 'software',
  sources: [],
  findings: [],
  counts: { 'team-member': zero, resource: zero, 'work-item': zero },
  costUsd: 0.01,
  durationMs: null,
  error: null,
  supersedes: null,
  supersededBy: null,
  startedAt: new Date(Date.now() - 18_000).toISOString(),
  endedAt: null,
  proposals: [],
  ...over,
});

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test('"Create with AI" shows the file as the chat writes it, and where it will be saved', () => {
  // The dialog waited on a still slot until the run answered whole
  const content = '---\nname: glossary-reviewer\ndescription: Reads each new sentence\n';
  const html = wrap(<LiveWriting run={writing({ draft: { kind: 'agents', name: 'glossary-reviewer', content } })} scope="project" phone={false} />);
  const words = text(html);
  assert.match(words, /Escribiendo \.claude\/agents\/glossary-reviewer\.md/);
  assert.doesNotMatch(words, /El archivo aparece aquí/);
  // Still live: the energy border and the running clock, from the first second in minutes
  assert.match(html, /class="suggestion-run is-live live-energy create-ai-live"/);
  assert.match(words, /0:1[89]/);
  // In the user's scope the path has no .claude/ in front
  assert.match(text(wrap(<LiveWriting run={writing({ draft: { kind: 'agents', name: 'glossary-reviewer', content } })} scope="user" phone={false} />)), /Escribiendo agents\/glossary-reviewer\.md/);
});

test('before the first part of the file, the still slot says it will fill in', () => {
  for (const draft of [undefined, null, { kind: 'agents' as const, name: null, content: '' }]) {
    const words = text(wrap(<LiveWriting run={writing({ draft })} scope="project" phone={false} />));
    assert.match(words, /El archivo aparece aquí en cuanto empiece a escribirlo/);
    assert.doesNotMatch(words, /Escribiendo \./);
  }
});

test("a run's clock reads minutes and seconds from the first second", () => {
  // It read "41s" where the references have "0:41"
  assert.equal(formatRunClock(41_000), '0:41');
  assert.equal(formatRunClock(0), '0:00');
  assert.equal(formatRunClock(725_000), '12:05');
  assert.equal(formatRunClock(3_725_000), '1:02:05');
});
