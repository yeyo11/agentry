// Chats screen: one row per chat with its state, control and context, orchestration workers and
// housekeeping out by default, and the filters. Seeds transcripts into the isolated config dir, so
// it never reads the real history.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const line = (o) => JSON.stringify(o);

function seedChat(configDir, projectId, sessionId, { cwd, title, at, inputTokens }) {
  const dir = join(configDir, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      line({ type: 'user', uuid: `${sessionId}-1`, timestamp: at, cwd, version: '2.1.0', message: { role: 'user', content: title } }),
      line({
        type: 'assistant',
        uuid: `${sessionId}-2`,
        timestamp: at,
        message: {
          role: 'assistant',
          id: `msg-${sessionId}`,
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'On it.' }],
          usage: { input_tokens: inputTokens, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    ].join('\n'),
  );
}

/**
 * Clicks the checkbox inside the filter label with this text and waits for it to render the new
 * state. The URL changes before React re-renders, so a second click that only waited for the URL
 * could land on the stale `checked` prop and toggle nothing.
 */
const toggle = async (page, text) => {
  const find = `[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}))?.querySelector('[role=checkbox]')`;
  await page.waitFor(`const i=${find};if(!i)return false;window.__toggled=i.getAttribute('aria-checked');i.click();return true;`, { label: `toggle ${text}` });
  await page.waitFor(`return ${find}?.getAttribute('aria-checked')!==window.__toggled`, { label: `${text} shows its new state` });
};

export default async ({ page, api, check }) => {
  const { configDir } = (await api.get('/system')).body;
  seedChat(configDir, '-work-alpha', 'aaaa-1111', { cwd: '/work/alpha', title: 'Fix the login bug', at: '2026-01-01T10:00:00Z', inputTokens: 150000 });
  seedChat(configDir, '-work-alpha', 'aaaa-2222', { cwd: '/work/alpha', title: 'Add dark mode', at: '2026-01-02T10:00:00Z', inputTokens: 1200 });
  seedChat(configDir, '-tmp-scratch', 'bbbb-1111', { cwd: '/tmp/scratch', title: 'Throwaway experiment', at: '2026-01-03T10:00:00Z', inputTokens: 300 });
  const served = (await api.get('/chats?origin=external')).body;
  check(['aaaa-1111', 'aaaa-2222', 'bbbb-1111'].every((id) => served.some((c) => c.id === id)), 'the three seeded chats are served');
  check(served.length === 3, `only the seeded chats exist (${served.length})`);

  await page.goto('/chats', 1500);
  await page.waitFor(`return document.querySelectorAll('.crow').length === 3`, { label: 'one row per chat' });
  const rows = await page.text('.scard');
  check(rows.includes('Fix the login bug') && rows.includes('Add dark mode') && rows.includes('Throwaway experiment'), 'every chat is listed');
  check((await page.text('main')).includes('3 of 3 chats'), 'the count says how many chats there are');

  // State and origin are words, not just a dot and an icon; resumable is what nearly every chat is,
  // so a row only names its control mode when it is another one. The origin badge is set in
  // capitals by CSS, so its word is read from the DOM
  const origin = await page.eval(`return document.querySelector('.crow .crow-origin .badge')?.textContent ?? ''`);
  check(rows.includes('Idle') && origin === 'Terminal', 'a row says its state and its origin');
  check(!rows.includes('Resumable'), 'a resumable chat carries no control tag');
  // The seeded chats are months old: sorted by activity they fall under one day heading. The heading
  // is set in capitals by CSS, so it is read from the DOM rather than as rendered
  check((await page.eval(`return document.querySelector('.crow-group-head')?.textContent ?? ''`)).includes('Earlier'), 'rows sorted by activity are grouped by day');
  check((await page.eval(`return document.querySelector('main .page-actions a[href="/chats/new"]')`)) === null, 'the page header no longer repeats New chat');
  // Nothing has answered with these models yet, so their window is unknown and no percentage is invented
  check(rows.includes('150k tokens') && !rows.includes('%'), 'the context of a chat with no known window is shown in tokens, without a percentage');
  check(rows.includes('cost not available'), 'a chat the CLI reported no cost for says so');

  // The state filter is a radio group
  await page.click('[aria-label="State"] button', 'Working');
  await page.waitFor(`return document.querySelector('main').innerText.includes('No chats match')`, { label: 'nothing is working' });
  await page.click('[aria-label="State"] button', 'All');
  await page.waitFor(`return document.querySelectorAll('.crow').length === 3`, { label: 'all chats again' });

  // The noise filters are opt-in, behind the Filters button, and every one in force is a chip
  await page.click('main .list-toolbar-filters', 'Filters', 400);
  await page.waitFor(`return !!document.querySelector('.list-toolbar-popover')`, { label: 'the filters popover' });
  // The facet legends are set in capitals by CSS too
  const facets = await page.eval(`return document.querySelector('.list-toolbar-popover')?.textContent ?? ''`);
  check(facets.includes('Origin') && facets.includes('Project') && facets.includes('Model') && facets.includes('claude-sonnet-5'), 'the popover offers origin, project and the models the chats used');
  await toggle(page, 'Internal');
  await page.waitFor(`return location.search.includes('internal=1')`, { label: 'internal in the URL' });
  await toggle(page, 'Internal');
  await toggle(page, 'Orchestration workers');
  await page.waitFor(`return location.search.includes('workers=1')`, { label: 'workers in the URL' });
  await page.waitFor(`return document.querySelector('.list-toolbar-filters')?.getAttribute('aria-label') === 'Filters, 1 active'`, { label: 'the button counts the filter in force' });
  await page.key('Escape');
  await page.click('.filter-chip', 'Orchestration workers', 400);
  await page.waitFor(`return !location.search.includes('workers=')`, { label: 'the chip takes the filter off' });
  await page.waitFor(`return !document.querySelector('.filter-chip')`, { label: 'no chip once no filter is in force' });

  // Search
  await page.fill('input[placeholder="Search title, first prompt, project, id…"]', 'dark mode');
  await page.waitFor(`return document.querySelector('main').innerText.includes('1 of 3 chats')`, { label: 'search narrows the list' });
  check(!(await page.text('main')).includes('Fix the login bug'), 'non-matching chats are hidden');

  await page.click('.link-btn', 'Reset filters', 800);
  await page.waitFor(`return document.querySelectorAll('.crow').length === 3`, { label: 'reset brings every chat back' });

  // The sort Select is a themed listbox: picking an option updates the URL and the order
  await page.select('[aria-label="Sort by"]', 'Recently started');
  await page.waitFor(`return location.search.includes('sort=started')`, { label: 'sort in the URL' });
  check((await page.text('[aria-label="Sort by"]')).includes('Recently started'), 'the trigger shows the picked sort');
  const order = await page.text('.scard');
  check(order.indexOf('Throwaway experiment') < order.indexOf('Add dark mode') && order.indexOf('Add dark mode') < order.indexOf('Fix the login bug'), 'recently started puts the newest chat first');
  check((await page.eval(`return document.querySelectorAll('.crow-group-head').length`)) === 0, 'any other sort is one list, without day headings');
  await page.select('[aria-label="Sort by"]', 'Recent activity');
  await page.waitFor(`return !location.search.includes('sort=')`, { label: 'default sort drops the param' });

  // The keyboard: j and k move a cursor that is focus, x picks the row, Escape lets go
  await page.eval(`document.activeElement?.blur(); return true`);
  await page.key('j');
  await page.key('j');
  await page.key('k');
  check((await page.eval(`return document.activeElement?.closest('.crow')?.dataset.row`)) === '0', 'j and k move focus along the rows');
  check((await page.eval(`return document.activeElement?.closest('.crow')?.classList.contains('is-cursor')`)) === true, 'the focused row is marked');
  await page.key('x');
  await page.waitFor(`return document.querySelector('.bulk-bar')?.innerText.includes('1 selected')`, { label: 'x selects the row and the bulk bar appears' });
  await page.key('Escape');
  await page.waitFor(`return !document.querySelector('.bulk-bar')`, { label: 'Escape clears the selection' });

  // A row opens the chat, which says what can be done with it
  await page.click('.crow-link', 'Fix the login bug', 1000);
  await page.waitFor(`return location.pathname === '/chats/aaaa-1111'`, { label: 'the row opens its chat' });
  await page.waitFor(`return document.querySelector('main').innerText.includes('Context and cost')`, { label: 'the chat page' });
  const chat = await page.text('main');
  check(chat.includes('Resumable'), 'the chat page shows its control');
  check(chat.includes('not available'), 'the cost of a chat the CLI reported none for reads not available');
  // What it has run is a tab of the inspector away
  await page.click('.chat-inspector [role=tab]', 'Activity');
  await page.waitFor(`return document.querySelector('main').innerText.includes('Executions (0)')`, { label: 'the executions in the inspector' });
  check(await page.eval(`return !!document.querySelector('textarea[placeholder^="Send a message"]')`), 'a resumable chat can be written to');
  await page.shot('chat-page');
  await page.goto('/chats', 800);
  await page.shot('chats-list');

  // Bulk delete: one confirmation for every row picked, then the route the chat page uses, per chat
  await page.waitFor(`return document.querySelectorAll('.crow').length === 3`, { label: 'the list again' });
  await page.eval(`[...document.querySelectorAll('.crow')].find((r) => r.innerText.includes('Throwaway experiment')).querySelector('[role=checkbox]').click(); return true`);
  await page.waitFor(`return document.querySelector('.bulk-bar')?.innerText.includes('1 selected')`, { label: 'the row picked with its box' });
  await page.click('.bulk-bar button', 'Delete', 400);
  await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('Delete 1 chat')`, { label: 'one confirmation' });
  await page.click('[role=dialog] button', 'Delete 1 chat', 800);
  await page.waitFor(`return document.querySelectorAll('.crow').length === 2 && !document.querySelector('.bulk-bar')`, { label: 'the chat is gone and the selection with it' });
  check(!(await api.get('/chats?origin=external')).body.some((c) => c.id === 'bbbb-1111'), 'the server deleted it');
};
