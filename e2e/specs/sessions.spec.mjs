// Sessions screen: active-only by default, grouping by project, and the noise filters.
// Seeds transcripts into the isolated config dir, so it never reads the real history.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const line = (o) => JSON.stringify(o);

function seedSession(configDir, projectId, sessionId, { cwd, title, at }) {
  const dir = join(configDir, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      line({ type: 'user', uuid: `${sessionId}-1`, timestamp: at, cwd, version: '2.1.0', message: { role: 'user', content: title } }),
      line({ type: 'assistant', uuid: `${sessionId}-2`, timestamp: at, message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'On it.' }] } }),
    ].join('\n'),
  );
}

/** Clicks the checkbox inside the filter label with this text. */
const toggle = (page, text) =>
  page.waitFor(
    `const l=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(text)}));` +
      `const i=l?.querySelector('input[type=checkbox]');if(!i)return false;i.click();return true;`,
    { label: `toggle ${text}` },
  );

export default async ({ page, api, check }) => {
  const { configDir } = (await api.get('/system')).body;
  seedSession(configDir, '-work-alpha', 'aaaa-1111', { cwd: '/work/alpha', title: 'Fix the login bug', at: '2026-01-01T10:00:00Z' });
  seedSession(configDir, '-work-alpha', 'aaaa-2222', { cwd: '/work/alpha', title: 'Add dark mode', at: '2026-01-02T10:00:00Z' });
  seedSession(configDir, '-tmp-scratch', 'bbbb-1111', { cwd: '/tmp/scratch', title: 'Throwaway experiment', at: '2026-01-03T10:00:00Z' });
  check((await api.get('/sessions')).body.length === 3, 'the three seeded sessions are served');

  // Nothing is running, so the default view is the active-only empty state
  await page.goto('/sessions', 1500);
  await page.waitFor(`return document.querySelector('main').innerText.includes('No active sessions')`, { label: 'active-only empty state' });
  const emptyText = await page.text('main');
  check(emptyText.includes('Show all sessions'), 'the empty state offers all sessions');
  check(!emptyText.includes('Throwaway experiment'), 'temporary projects stay hidden');

  await page.click('button', 'Show all sessions');
  await page.waitFor(`return document.querySelectorAll('.ssection').length > 0`, { label: 'grouped sections' });
  check((await page.text('main')).includes('2 of 3 sessions'), 'the temporary session is filtered out of the count');
  check((await page.eval(`return document.querySelectorAll('.ssection').length`)) === 1, 'both sessions of the project share one section');
  const section = await page.text('.ssection');
  check(section.includes('alpha') && section.includes('Fix the login bug') && section.includes('Add dark mode'), 'the section groups the project sessions');

  // The temporary toggle brings the scratch project back
  await toggle(page, 'Temporary projects');
  await page.waitFor(`return document.querySelectorAll('.ssection').length === 2`, { label: 'temporary project section' });
  check((await page.text('main')).includes('3 of 3 sessions'), 'all sessions shown with temporary enabled');
  await toggle(page, 'Temporary projects');
  await page.waitFor(`return document.querySelectorAll('.ssection').length === 1`, { label: 'temporary project hidden again' });

  // Search and flat layout
  await page.fill('input[placeholder="Search title, first prompt, project, id…"]', 'dark mode');
  await page.waitFor(`return document.querySelector('main').innerText.includes('1 of 3 sessions')`, { label: 'search narrows the list' });
  check(!(await page.text('main')).includes('Fix the login bug'), 'non-matching sessions are hidden');

  await page.click('.link-btn', 'Reset filters', 800);
  await page.click('[aria-label="Layout"] button', 'Flat');
  await page.waitFor(`return document.querySelectorAll('.ssection').length === 0 && !!document.querySelector('.scard')`, { label: 'flat layout' });
  check((await page.text('main')).includes('2 of 3 sessions'), 'reset keeps the All view and default noise filters');
  await page.shot('sessions-grouped');
};
