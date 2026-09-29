// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { House, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ModelPicker, modelPicks } from '../src/components/ModelPicker';
import { monogramLetters, projectMonogram } from '@agentry/ui/components/icons';
import { isActive, type NavItem } from '../src/components/shell/nav';
import { PhoneHeader } from '../src/components/shell/PhoneHeader';
import { phoneHeaderOf, PHONE_HEADER_ROUTES } from '../src/components/shell/phone-header';
import i18n from '../src/i18n';

// Orchestration 7 (the ecosystem design review): the shell's part of it. Phone headers decided by
// route, the model picker, the monogram rule and which section the sidebar marks.

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );

test.beforeEach(async () => {
  await i18n.changeLanguage('es');
});

test('every phone detail screen heads itself, marked by route, and the tab roots keep the bar', () => {
  assert.equal(phoneHeaderOf('/', true), 'page', "a project's page and its tabs");
  assert.equal(phoneHeaderOf('/', false), 'app', 'Home of every project keeps the bar');
  const detail = [
    // The ecosystem's screens (orchestration 7)
    '/tasks', '/tasks/', '/tasks/milestones', '/tasks/AGN-26', '/projects/new', '/projects/p1/assistant',
    // The rest of the app (CW-8): the chat page is also a task's chat and a flow run's chat
    '/chats/c1', '/chats/c1/', '/chats/new', '/orchestration/o1', '/orchestration/o1/',
    '/chats/c1/changes', '/tasks/AGN-26/changes', '/orchestration/o1/changes', '/orchestration/o1/tasks/t1/changes',
    '/accounts', '/accounts/', '/projects', '/projects/', '/schedules', '/schedules/new', '/schedules/s1/edit', '/schedules/s1/edit/',
    '/usage', '/connectors', '/settings', '/settings/',
  ];
  for (const path of detail) assert.equal(phoneHeaderOf(path), 'page', path);
  // The tab roots and a page that does not exist keep the app's top bar
  for (const path of ['/chats', '/chats/', '/orchestration', '/orchestration/', '/nowhere', '/chats/c1/changes/extra'])
    assert.equal(phoneHeaderOf(path), 'app', path);
  assert.equal(phoneHeaderOf('/chats', true), 'app', 'the project flag is about `/` alone');
  assert.ok(PHONE_HEADER_ROUTES.every((route) => route.phoneHeader === 'page'), 'the table lists only the routes switched over');
});

test("a page's own header: back, the title with its mono line, and ⋯ as the page's actions", () => {
  const html = wrap(
    <PhoneHeader
      title="Desarrollador"
      subtitle=".claude/agents/developer.md"
      more={[{ id: 'remove', label: 'Quitar del equipo', icon: Trash2, destructive: true, onSelect: () => {} }]}
    />,
  );
  assert.match(html, /^<header class="phone-head">/);
  assert.match(html, /<button type="button" class="icon-btn page-back phone-head-back" aria-label="Volver">/);
  assert.match(html, /<h1 class="ellipsis">Desarrollador<\/h1><span class="phone-head-sub ellipsis">\.claude\/agents\/developer\.md<\/span>/);
  assert.match(html, /aria-label="Más acciones"/);
  // No ⋯ when the page has nothing to offer in it
  assert.doesNotMatch(wrap(<PhoneHeader title="Tareas" more={[]} />), /Más acciones/);
});

test('a modal flow leaves by "Cancelar" or ✕ instead of a back arrow', () => {
  const cancel = wrap(<PhoneHeader title="Nueva tarea" dismiss={{ kind: 'cancel', to: '/tasks' }} />);
  assert.match(cancel, /class="phone-head is-modal"/);
  assert.match(cancel, /<a class="btn btn-ghost phone-head-cancel" href="\/tasks" data-discover="true">Cancelar<\/a>|<a class="btn btn-ghost phone-head-cancel" href="\/tasks">Cancelar<\/a>/);
  assert.doesNotMatch(cancel, /aria-label="Volver"/);
  const close = wrap(<PhoneHeader title="Nuevo proyecto" subtitle="paso 2 de 4" dismiss={{ kind: 'close', onDismiss: () => {} }} />);
  assert.match(close, /<button type="button" class="icon-btn phone-head-back" aria-label="Cerrar">/);
});

test('a project monogram is the first letter of its first two words, or a lone word’s first two', () => {
  assert.equal(projectMonogram('claude-wrapper'), 'CW');
  assert.equal(projectMonogram('pagos-api'), 'PA');
  assert.equal(projectMonogram('notas'), 'NO');
  assert.equal(projectMonogram('google docs mcp'), 'GD');
  assert.equal(projectMonogram('señales-éxito'), 'SÉ', 'a word is letters in any script');
  assert.equal(projectMonogram('ñu'), 'ÑU');
  assert.equal(projectMonogram('x'), 'X');
  assert.equal(projectMonogram('---'), '');
  // A person keeps one letter, beside their name
  assert.equal(monogramLetters('yeyo'), 'Y');
});

test('the model picker says the alias as a tag and the model it resolves to', () => {
  const options = [
    { value: 'opus', label: 'Opus 5.5', hint: 'Lo más capaz' },
    { value: 'sonnet', label: 'Sonnet 5' },
    { value: 'haiku', label: 'haiku' },
  ];
  assert.deepEqual(modelPicks(options, 'sonnet').map((pick) => [pick.value, pick.resolved]), [
    ['opus', 'Opus 5.5'],
    ['sonnet', 'Sonnet 5'],
    ['haiku', null],
  ]);
  // A model the CLI does not offer is kept, so opening the picker never drops it
  assert.deepEqual(modelPicks(options, 'claude-opus-4-1').at(-1), { value: 'claude-opus-4-1', resolved: null });
  assert.equal(modelPicks(options, '').length, 3);
  const html = wrap(<ModelPicker value="sonnet" onChange={() => {}} options={options} aria-label="Modelo de QA" />);
  assert.match(html, /class="model-pick"/);
  assert.match(html, /aria-label="Modelo de QA"/);
  assert.match(html, /<span class="model-tag">sonnet<\/span><span class="resolved ellipsis">Sonnet 5<\/span>/);
  assert.match(wrap(<ModelPicker value="opus" onChange={() => {}} options={options} aria-label="Modelo" />), /class="model-tag is-opus">opus/);
  assert.match(wrap(<ModelPicker value="" onChange={() => {}} options={options} placeholder="Por defecto" aria-label="Modelo" />), /model-pick-empty">Por defecto/);
});

test('Projects on every project tab; Tasks on the board, the list, the milestones and an item reached from it', () => {
  const item = (to: string): NavItem => ({ to, label: to, icon: House });
  const [home, tasks, projects, chats] = ['/', '/tasks', '/projects', '/chats'].map(item) as [NavItem, NavItem, NavItem, NavItem];
  // A project's tabs, its board tab included, live at `/` with a project in scope
  assert.equal(isActive(projects, '/', true), true);
  assert.equal(isActive(tasks, '/', true), false, "the project's board tab is the project's, not Tasks'");
  assert.equal(isActive(home, '/', true), false);
  assert.equal(isActive(projects, '/projects/p1/assistant'), true);
  assert.equal(isActive(projects, '/projects/new'), true);
  for (const path of ['/tasks', '/tasks/milestones', '/tasks/AGN-26', '/tasks/AGN-26/changes']) {
    assert.equal(isActive(tasks, path), true, path);
    assert.equal(isActive(projects, path), false, path);
  }
  // A task's chat is a chat
  assert.equal(isActive(chats, '/chats/c1'), true);
  assert.equal(isActive(tasks, '/chats/c1'), false);
  assert.equal(isActive(tasks, '/tasksboard'), false, 'a prefix is not a section');
});
