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

/** Clicks the checkbox inside the filter label with this text. */
const toggle = (page, text) =>
  page.waitFor(
    `const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}));` +
      `const i=l?.querySelector('[role=checkbox]');if(!i)return false;i.click();return true;`,
    { label: `toggle ${text}` },
  );

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

  // State and control are words, not just colours
  check(rows.includes('Idle') && rows.includes('Terminal') && rows.includes('Resumable'), 'a row says its state, its origin and its control');
  // Nothing has answered with these models yet, so their window is unknown and no percentage is invented
  check(rows.includes('150k tokens') && !rows.includes('%'), 'the context of a chat with no known window is shown in tokens, without a percentage');
  check(rows.includes('cost not available'), 'a chat the CLI reported no cost for says so');

  // The state filter is a radio group
  await page.click('[aria-label="State"] button', 'Working');
  await page.waitFor(`return document.querySelector('main').innerText.includes('No chats match')`, { label: 'nothing is working' });
  await page.click('[aria-label="State"] button', 'All');
  await page.waitFor(`return document.querySelectorAll('.crow').length === 3`, { label: 'all chats again' });

  // The noise filters are opt-in
  await toggle(page, 'Internal');
  await page.waitFor(`return location.search.includes('internal=1')`, { label: 'internal in the URL' });
  await toggle(page, 'Internal');
  await toggle(page, 'Orchestration workers');
  await page.waitFor(`return location.search.includes('workers=1')`, { label: 'workers in the URL' });
  await toggle(page, 'Orchestration workers');
  await page.waitFor(`return !location.search.includes('workers=')`, { label: 'workers back out' });

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
  await page.select('[aria-label="Sort by"]', 'Recent activity');
  await page.waitFor(`return !location.search.includes('sort=')`, { label: 'default sort drops the param' });

  // A row opens the chat, which says what can be done with it
  await page.click('.crow-link', 'Fix the login bug', 1000);
  await page.waitFor(`return location.pathname === '/chats/aaaa-1111'`, { label: 'the row opens its chat' });
  await page.waitFor(`return document.querySelector('main').innerText.includes('Context and cost')`, { label: 'the chat page' });
  const chat = await page.text('main');
  check(chat.includes('Resumable') && chat.includes('Executions (0)'), 'the chat page shows its control and its executions');
  check(chat.includes('not available'), 'the cost of a chat the CLI reported none for reads not available');
  check(await page.eval(`return !!document.querySelector('textarea[placeholder^="Send a message"]')`), 'a resumable chat can be written to');
  await page.shot('chat-page');
  await page.goto('/chats', 800);
  await page.shot('chats-list');
};
