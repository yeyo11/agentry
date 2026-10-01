// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { JournalEntry, JournalPage } from '@agentry/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { keys } from '../src/api';
import { ConfirmProvider } from '@agentry/ui/components/Dialog';
import { ToastProvider } from '@agentry/ui/components/Toast';
import i18n from '../src/i18n';
import { Journal } from '../src/pages/home/memory/Journal';

// Gap 23 of orchestration 6: the phone journal showed the person's monogram alone, where the
// reference (MobileMemoriaDiario) writes "Tú" beside it.

const entry = (id: string, over: Partial<JournalEntry>): JournalEntry => ({
  id,
  projectId: 'p',
  kind: 'note',
  text: `Entry ${id}`,
  itemId: null,
  item: null,
  author: { kind: 'person' },
  approvedBy: null,
  proposalId: null,
  documentPath: null,
  sources: [],
  createdAt: new Date().toISOString(),
  ...over,
});

test('a phone journal names the person "Tú" beside their mark, and a role by its avatar', async () => {
  await i18n.changeLanguage('es');
  const client = new QueryClient();
  const page: JournalPage = {
    entries: [
      entry('a', { kind: 'closed', text: 'Settings per project', approvedBy: { kind: 'person' } }),
      entry('b', { kind: 'note', text: 'Keep the key short' }),
      entry('c', { kind: 'decision', text: 'One table per stream', author: { kind: 'agent', role: 'architect' } }),
    ],
    total: 3,
    handed: { entries: 3, bytes: 100 },
    nextBefore: null,
  };
  client.setQueryData(keys.journalPage('p', { limit: 30 }), page);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ToastProvider>
          <ConfirmProvider>
            <Journal projectId="p" phone />
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const lines = [...html.matchAll(/<div class="journal-card-by">(.*?)<\/div>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  // The closed item and the note are the person's, named "Tú"; "written by you" would say it twice.
  // The architect's decision carries its avatar and its role's name
  assert.deepEqual([...lines].sort(), ['AR Arquitecto', 'T Tú', 'T Tú · aprobaste el paso a Hecho']);
});
