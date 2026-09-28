// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { monogramLetters } from '../src/components/icons';
import i18n from '../src/i18n';
import { PhoneAssistantRow, PhoneHead, ProjectHead } from '../src/pages/home/ProjectHead';

// Gap 8 of orchestration 6: once a project had a team, nothing on its page led to its assistant.
// The header carries it, a ghost before "New chat here" and "New task" (decision 3 of the design
// review), on every tab but the two that are forms of their own, Ajustes and Recursos.

const project: Project = { id: 'p 1', name: 'shop', path: '/tmp/shop', worktrees: [], exists: true, chatCount: 3, lastActivity: null, key: 'SHOP', modules: ['board', 'team'] };

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test("every tab's header leads to the project's assistant, beside the ways to start work", () => {
  const html = wrap(<ProjectHead project={project} primaryTask={false} />);
  const actions = [...html.matchAll(/<a [^>]*class="(btn[^"]*)"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/a>/g)].map((m) => `${m[2]}|${m[1]}`);
  assert.deepEqual(actions, ['Asistente|btn btn-ghost project-head-assistant', 'Nuevo chat aquí|btn', 'Nueva tarea|btn']);
  assert.match(html, /href="\/projects\/p%201\/assistant"/);
  assert.match(html, /aria-label="Asistente de shop"/);
  // The gradient stays on New task on Summary: the assistant never takes the primary
  assert.match(wrap(<ProjectHead project={project} primaryTask />), /class="btn btn-primary"[^>]*>(?:<svg.*?<\/svg>)?Nueva tarea/);
});

test('a tab that is a form of its own leaves the header without actions', () => {
  const html = wrap(<ProjectHead project={project} primaryTask={false} actions={false} />);
  assert.doesNotMatch(html, /page-actions/);
  assert.match(html, /<h1>shop<\/h1>/);
});

test("a phone's project header is the page's own: back, monogram, name, key and path, and a sheet", () => {
  const html = wrap(<PhoneHead project={project} />);
  assert.match(html, /class="phone-head project-phone-head"/);
  assert.match(html, /aria-label="Volver a proyectos"/);
  assert.match(html, /class="phone-head-lead"><span class="monogram"[^>]*>SH</);
  assert.match(html, /SHOP · \/tmp\/shop/);
  assert.match(html, /phone-head-more/);
  // The assistant has its own row under the header, not a second way in the header
  assert.doesNotMatch(html, /project-head-assistant/);
});

test("a phone's assistant row leads to the assistant and says what it does while nothing waits", () => {
  const html = wrap(<PhoneAssistantRow project={project} />);
  assert.match(html, /<a [^>]*href="\/projects\/p%201\/assistant"[^>]*class="card project-assistant-row"|class="card project-assistant-row"[^>]*href="\/projects\/p%201\/assistant"/);
  assert.match(html, /Asistente del proyecto/);
  assert.match(html, /Lee el proyecto y te propone equipo, recursos y tareas/);
});

test('a one-word project gets a two-letter monogram, as the references draw it; a person keeps one', () => {
  // "nodo" showed "N" where the references have "NO"
  assert.equal(monogramLetters('nodo', true), 'NO');
  assert.equal(monogramLetters('claude-wrapper', true), 'CW');
  assert.equal(monogramLetters('x', true), 'X');
  assert.equal(monogramLetters('yeyo'), 'Y');
  assert.match(wrap(<ProjectHead project={{ ...project, name: 'nodo' }} primaryTask={false} />), /class="monogram"[^>]*>NO</);
});
