// Transcript search: the view holds only the newest page, so the browser's own find cannot reach a
// message further back. The search field asks the API, loads the pages up to the hit, scrolls the
// windowed list to it and marks the match. Seeds a long transcript into the isolated config dir.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION = 'search-long-1';
const ENTRIES = 700;
const line = (o) => JSON.stringify(o);

function seed(configDir) {
  const dir = join(configDir, 'projects', '-work-search');
  mkdirSync(dir, { recursive: true });
  const at = '2026-01-01T10:00:00Z';
  const lines = Array.from({ length: ENTRIES }, (_, i) =>
    i % 2 === 0
      ? line({ type: 'user', uuid: `s-${i}`, timestamp: at, cwd: '/work/search', version: '2.1.0', message: { role: 'user', content: `question number ${i}` } })
      : line({ type: 'assistant', uuid: `s-${i}`, timestamp: at, message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `answer number ${i}` }] } }),
  );
  // Three hits far above the newest page (one only inside a closed fold), one inside it
  lines[11] = line({ type: 'assistant', uuid: 's-11', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'the first Platypus sighting' }] } });
  lines[100] = line({ type: 'assistant', uuid: 's-100', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat notes.txt' } }] } });
  // Past what the fold's one-line hint shows, so only opening it reveals the match
  lines[101] = line({ type: 'user', uuid: 's-101', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `${'notes '.repeat(60)}\nthe platypus burrow` }] } });
  lines[301] = line({ type: 'assistant', uuid: 's-301', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'a platypus again' }] } });
  lines[650] = line({ type: 'assistant', uuid: 's-650', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'the last platypus' }] } });
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.join('\n'));
}

const count = (page) => page.eval(`return document.querySelector('.find-count')?.textContent ?? ''`);
const focusedText = (page) => page.eval(`return document.querySelector('.transcript > [data-focused]')?.innerText ?? ''`);

export default async ({ page, api, check }) => {
  const { configDir } = (await api.get('/system')).body;
  seed(configDir);
  try {
    const found = (await api.get(`/chats/${SESSION}/search?q=PLATYPUS`)).body;
    check(found.total === ENTRIES && found.hits.map((h) => h.index).join() === '11,101,301,650', 'the API finds every hit, loaded or not');

    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return !!document.querySelector('.transcript [data-index]')`, { label: 'the transcript' });
    check(!(await page.text('main')).includes('first Platypus'), 'the oldest hit is not on the page before searching');

    // Ctrl+F opens the field in the page, focused
    await page.key('f', 2);
    await page.waitFor(`return document.activeElement?.classList.contains('find-input')`, { label: 'the search field has focus' });
    await page.type('platypus');
    await page.waitFor(`return document.querySelector('.find-count')?.textContent === '1 of 4'`, { label: 'the newest hit first' });
    await page.waitFor(`return document.querySelector('.transcript > [data-focused]')?.innerText.includes('the last platypus')`, { label: 'the newest hit focused' });

    // Enter walks back up the conversation, reading the pages the hits are on
    await page.key('Enter');
    await page.waitFor(`return document.querySelector('.find-count')?.textContent === '2 of 4'`, { label: 'the second hit' });
    await page.waitFor(`return document.querySelector('.transcript > [data-focused]')?.innerText.includes('a platypus again')`, { label: 'a hit on an earlier page' });
    // A match inside a closed tool result opens it
    await page.key('Enter');
    await page.waitFor(`return document.querySelector('.transcript > [data-focused]')?.innerText.includes('the platypus burrow')`, { label: 'the fold of the hit opened' });
    await page.waitFor(`return CSS.highlights.get('transcript-find-current')?.size === 1`, { label: 'the match in the fold marked' });
    await page.key('Enter');
    await page.waitFor(`return document.querySelector('.transcript > [data-focused]')?.innerText.includes('the first Platypus')`, { label: 'the oldest hit, pages back' });
    check((await count(page)) === '4 of 4', 'the counter follows');
    const onScreen = await page.eval(
      `const r=document.querySelector('.transcript > [data-focused]').getBoundingClientRect();return r.bottom>0&&r.top<innerHeight`,
    );
    check(onScreen, 'the hit is scrolled into view');
    const marked = await page.eval(`return CSS.highlights?.get('transcript-find-current')?.size ?? -1`);
    check(marked === 1, `the match in the current hit is marked (${marked})`);

    await page.shot('search-oldest-hit');

    // Shift+Enter goes back down the conversation
    await page.key('Enter', 8);
    await page.waitFor(`return document.querySelector('.find-count')?.textContent === '3 of 4'`, { label: 'Shift+Enter steps back' });
    check((await focusedText(page)).includes('the platypus burrow'), 'the hit in the fold again');

    // A second Ctrl+F in the field is left to the browser
    const passedOn = await page.eval(
      `let prevented=null;const f=(e)=>{prevented=e.defaultPrevented};addEventListener('keydown',f);` +
        `document.querySelector('.find-input').dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));` +
        `removeEventListener('keydown',f);return prevented===false`,
    );
    check(passedOn, 'a second Ctrl+F falls through to the browser find');

    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.find-bar')`, { label: 'Escape closes the search' });
    check(!(await page.eval(`return !!document.querySelector('.transcript > [data-focused]')`)), 'closing drops the focused hit');

    // The header button opens it again, with the query kept
    await page.click('button', 'Search');
    await page.waitFor(`return document.querySelector('.find-input')?.value === 'platypus'`, { label: 'the button reopens the search' });
  } finally {
    // Later specs count the seeded chats
    await api.del(`/chats/${SESSION}`);
  }
};
