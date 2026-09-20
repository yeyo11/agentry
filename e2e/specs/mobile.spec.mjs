// Transcripts on a phone. The windowed list takes the scroller it is rendered in at its word: if
// the narrow layout lets that element grow with its content, something else scrolls, the list
// measures a viewport as tall as the whole log and never moves its window, and the page is blank
// wherever the reader looks. That is what run pages did at 1100px and below; a chat is what a run
// page became, so both a chat read from its transcript and one Agentry just started are checked.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOTAL = 400;
const SESSION = 'e2e-mobile-0000-0000-000000000000';
const PROJECT = '-work-mobile';
const mark = (i) => `p${String(i).padStart(4, '0')}`;

function entry(i) {
  const base = { uuid: `mobile-${mark(i)}`, timestamp: new Date(Date.UTC(2026, 0, 2, 9, 0, i)).toISOString(), cwd: '/work/mobile', version: '2.1.0', sessionId: SESSION };
  return i % 2 === 0
    ? { ...base, type: 'user', message: { role: 'user', content: `${mark(i)} Can you check the layout on a phone?` } }
    : { ...base, type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: `${mark(i)} Checked. ${'The rows wrap at this width. '.repeat(1 + (i % 7))}` }] } };
}

/** Rows of the windowed list that are actually on screen, below the topbar. */
const onScreen = (scroller) =>
  `const s=document.querySelector('${scroller}');const v=s.getBoundingClientRect();const top=Math.max(v.top,0),bottom=Math.min(v.bottom,innerHeight);` +
  `return [...s.querySelectorAll('[data-index]')].filter(r=>{const b=r.getBoundingClientRect();return b.height>0&&b.bottom>top&&b.top<bottom}).length`;
const settle = (page) => page.eval(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))));return true`);

export default async ({ page, api, check, dirs }) => {
  const dir = join(dirs.configDir, 'projects', PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), Array.from({ length: TOTAL }, (_, i) => JSON.stringify(entry(i))).join('\n'));
  let chatId = null;

  try {
    await page.viewport(390, 844);

    // ---- A chat read from its transcript: the list follows its scroller wherever the reader goes ----
    await page.goto(`/chats/${SESSION}`, 300);
    await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('${mark(TOTAL - 1)}')`, { label: 'the newest message is rendered' });
    await page.waitFor(`const m=document.querySelector('.run-scroll');return m.scrollHeight-m.scrollTop-m.clientHeight<4`, { label: 'the log sits at its bottom' });
    check((await page.eval(onScreen('.run-scroll'))) > 0, 'the chat lands with rows on screen');
    await page.eval(`document.querySelector('.run-scroll').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));return true`);
    for (const at of [0.6, 0.3]) {
      await page.eval(`const m=document.querySelector('.run-scroll');m.scrollTop=(m.scrollHeight-m.clientHeight)*${at};return true`);
      await settle(page);
      check((await page.eval(onScreen('.run-scroll'))) > 0, `the chat still shows rows after scrolling to ${at * 100}% of it`);
    }

    // ---- A chat Agentry started: its log scrolls inside a bounded stage, never the page around it ----
    // Without a login the chat goes nowhere, and its log is short: the height it would reach with a
    // long one is stood in for by a filler, which the stage must not grow to hold.
    const created = await api.post('/chats', { prompt: 'hello', name: 'e2e-mobile-chat' });
    check(created.status === 201, `the chat was created (${created.status})`);
    chatId = created.body.id;
    await page.goto(`/chats/${chatId}`, 300);
    await page.waitFor(`return !!document.querySelector('.run-scroll')`, { label: 'the chat log' });
    await page.eval(`const f=document.createElement('div');f.id='e2e-filler';f.style.height='20000px';f.style.flexShrink='0';document.querySelector('.run-scroll').append(f);return true`);
    await settle(page);
    const stage = await page.eval(
      `const st=document.querySelector('.run-stage').getBoundingClientRect(),s=document.querySelector('.run-scroll');` +
        `return {stage:st.height,client:s.clientHeight,scroll:s.scrollHeight,view:innerHeight}`,
    );
    check(Math.abs(stage.stage - stage.view * 0.62) <= 2, `the chat stage keeps its height on a phone (${stage.stage.toFixed(0)}px of ${stage.view}px)`);
    check(stage.client < stage.view && stage.scroll > stage.client, `the chat log scrolls itself (${stage.client}px showing ${stage.scroll}px)`);
    await page.eval(`document.getElementById('e2e-filler')?.remove();return true`);
    await page.shot('mobile-chat');
  } finally {
    await page.viewport(1440, 900);
    // Later specs count the seeded chats
    await api.del(`/chats/${SESSION}`);
    if (chatId) {
      await api.post(`/chats/${chatId}/stop`);
      for (let i = 0; i < 40; i++) {
        if ((await api.del(`/chats/${chatId}`)).status === 200) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
};
