// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api';
import { phoneHeaderOf } from '../src/components/shell/phone-header';
import i18n from '../src/i18n';
import { AgentryAssistant } from '../src/pages/agentry-assistant/Entry';
import { AssistantGreeting } from '../src/pages/agentry-assistant/Greeting';
import { AGENTRY_ASSISTANT_PATH, STARTERS } from '../src/pages/agentry-assistant/model';
import { ProjectScopeProvider } from '../src/lib/project-scope';
import { TooltipProvider } from '@agentry/ui/components/controls/Tooltip';

// CW-18, the web part: the entry screen, its greeting and starters, the greeting of an assistant's
// chat, and the call that starts it.

const wrap = (children: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TooltipProvider>
          <ProjectScopeProvider>{children}</ProjectScopeProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('the entry is a route of its own, headed by its page on a phone, apart from the project assistant', () => {
  assert.equal(AGENTRY_ASSISTANT_PATH, '/assistant');
  assert.equal(phoneHeaderOf('/assistant'), 'page');
  assert.equal(phoneHeaderOf('/assistant/'), 'page');
  assert.equal(phoneHeaderOf('/projects/p1/assistant'), 'page', 'the project assistant keeps its own entry');
});

for (const language of ['en', 'es'] as const) {
  test(`the entry greets, offers its starters as buttons that fill the box, and has no project required (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<AgentryAssistant />);
    const words = text(html);
    assert.match(words, language === 'es' ? /Hola, soy el asistente de Agentry/ : /Hi, I'm the Agentry assistant/);
    assert.equal((html.match(/class="as-starter"/g) ?? []).length, STARTERS.length);
    for (const { key } of STARTERS) {
      assert.ok(words.includes(i18n.t(`assistant:agentry.starter.${key}.title`)), key);
      assert.ok(words.includes(i18n.t(`assistant:agentry.starter.${key}.ask`)), key);
    }
    // A starter only fills the composer: the one send button is disabled until there is text
    assert.match(html, /<button type="submit" class="composer-send"[^>]*disabled/);
    assert.doesNotMatch(html, /as-context/, 'with no project in scope there is no context chip');
    // Never the gradient on the mark, never an Empty illustration
    assert.doesNotMatch(html, /grad-border|illustration/);
  });

  test(`the greeting is the first message of an assistant's chat (${language})`, async () => {
    await i18n.changeLanguage(language);
    const html = wrap(<AssistantGreeting />);
    assert.match(html, /class="as-greeting"/);
    assert.ok(text(html).includes(i18n.t('assistant:agentry.greeting')));
  });
}

test('starting posts the prompt, the project and the model to /assistant/chats', async () => {
  const real = globalThis.fetch;
  let seen: { url: string; method: string; body: unknown; language: string | null } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body)),
      language: new Headers(init?.headers).get('accept-language'),
    };
    return new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await i18n.changeLanguage('es');
    const chat = await api.startAgentryAssistantChat({ prompt: '¿Cuánto he gastado hoy?', projectId: 'p1', model: 'sonnet' });
    assert.equal(chat.id, 'c1');
    assert.ok(seen?.url.endsWith('/assistant/chats'));
    assert.equal(seen?.method, 'POST');
    assert.deepEqual(seen?.body, { prompt: '¿Cuánto he gastado hoy?', projectId: 'p1', model: 'sonnet' });
    assert.equal(seen?.language, 'es');
  } finally {
    globalThis.fetch = real;
  }
});
