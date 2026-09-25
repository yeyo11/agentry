// The chat page after the redesign: one header line, a turn's tool calls folded into one step, the
// rest of what the page offers one press away (the ⋯ menu, the inspector, the status line under the
// composer), and New chat with its prompt first. Seeds a terminal chat with a turn of three calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION = 'e2e-chat-page-0000-0000-000000000000';
const INSPECTOR_KEY = 'agentry-chat-inspector';
const line = (o) => JSON.stringify(o);
const at = (s) => `2026-01-03T10:00:${String(s).padStart(2, '0')}.000Z`;

function seed(configDir) {
  const dir = join(configDir, 'projects', '-work-chat-page');
  mkdirSync(dir, { recursive: true });
  const base = { cwd: '/work/chat-page', version: '2.1.0', sessionId: SESSION };
  const call = (uuid, s, id, name, input) => ({ ...base, type: 'assistant', uuid, timestamp: at(s), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (uuid, s, id, content, isError = false) => ({ ...base, type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  const lines = [
    { ...base, type: 'user', uuid: 'cp-1', timestamp: at(0), message: { role: 'user', content: 'Tidy the build scripts' } },
    { ...base, type: 'assistant', uuid: 'cp-2', timestamp: at(1), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Looking at them first.' }] } },
    call('cp-3', 2, 'toolu_a', 'Read', { file_path: '/work/chat-page/package.json' }),
    result('cp-4', 3, 'toolu_a', '{ "scripts": {} }'),
    call('cp-5', 4, 'toolu_b', 'Grep', { pattern: 'build' }),
    result('cp-6', 5, 'toolu_b', 'scripts/build.sh'),
    call('cp-7', 9, 'toolu_c', 'Bash', { command: 'npm run build', description: 'Build it once' }),
    result('cp-8', 12, 'toolu_c', 'exit 1', true),
    { ...base, type: 'assistant', uuid: 'cp-9', timestamp: at(13), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Two scripts merged.' }] } },
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map(line).join('\n'));
}

export default async ({ page, api, check }) => {
  const { configDir } = (await api.get('/system')).body;
  seed(configDir);
  try {
    // Every spec starts on about:blank, whose storage is out of reach: open the app first
    await page.goto('/', 800);
    await page.eval(`localStorage.removeItem(${JSON.stringify(INSPECTOR_KEY)}); return true`);
    await page.goto(`/chats/${SESSION}`, 1500);
    await page.waitFor(`return !!document.querySelector('.chat-head h1')`, { label: 'the chat header' });

    // ---- one header line: title, a pill that says state and who holds it, icon actions ----
    const head = await page.eval(`const h=document.querySelector('.chat-head');return {height:h.getBoundingClientRect().height,text:h.innerText}`);
    check(head.height <= 60, `the header is one line (${head.height}px)`);
    // The pill is uppercase by CSS (Night Shift): its words are read from the DOM
    const pill = await page.eval(`return document.querySelector('.chat-pill')?.textContent ?? ''`);
    check(pill.includes('Idle') && pill.includes('resumable'), `the pill says the state and who holds the chat (${pill})`);
    check(!head.text.includes(SESSION), 'the raw id is not in the header');

    // ---- the turn's three calls are one step, folded because it is done ----
    const step = await page.eval(
      `const s=document.querySelector('.msg-step');return s?{text:s.innerText,tools:[...s.querySelectorAll('.step-tools .badge')].map((b)=>b.textContent).join(' · '),state:s.querySelector('.collapsible-trigger')?.dataset.state}:null`,
    );
    check(step !== null, 'the tool calls are folded into a step');
    check(step?.text.includes('3 tools') && step?.text.includes('1 failed'), `the step says how many calls and how many failed (${step?.text})`);
    check(step?.tools === 'Read · Grep · Bash', `the step names its tools in order, each as a badge (${step?.tools})`);
    check(step?.state === 'closed', 'a step that is done is folded');
    // Claude speaks once for the whole turn: the answer after the step does not repeat the author
    const heads = await page.eval(`return document.querySelectorAll('.transcript .msg-head').length`);
    check(heads === 2, `the author line shows only when the author changes (${heads} heads)`);

    await page.click('.msg-step .collapsible-trigger');
    await page.waitFor(`return document.querySelectorAll('.msg-step .call-row').length === 3`, { label: 'the step opens onto its calls' });
    check((await page.eval(`return document.querySelectorAll('.msg-step .call-row.is-error').length`)) === 1, 'the failed call has its own rail');
    check((await page.text('.msg-step .call-row.is-error')).includes('failed'), 'the failed call says so in words');

    // ---- the ⋯ menu holds what the header used to spell out ----
    await page.focus('.chat-head button[aria-label="More chat actions"]');
    await page.key('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the chat menu' });
    const menu = await page.text('[role=menu]');
    for (const item of ['Export Markdown', 'Export JSON', 'Fork', 'Subagent messages', 'Copy chat id', 'Delete']) check(menu.includes(item), `the menu offers ${item}`);
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=menu]')`, { label: 'the menu closes' });

    // ---- the inspector: a drawer with four tabs, open by default on a wide screen, and remembered closed ----
    const tabs = await page.eval(`return [...document.querySelectorAll('.chat-inspector [role=tab]')].map((t)=>t.textContent.trim()).join('|')`);
    check(tabs === 'Summary|Activity|Changes|Environment', `the inspector has its four tabs (${tabs})`);
    check((await page.text('.chat-inspector')).includes(SESSION), 'the id lives in the inspector');
    check(!(await page.eval(`return !!document.querySelector('.chat-head button[aria-label="Chat details"]')`)), 'with a drawer beside it the header needs no details button');
    await page.click('.chat-inspector button[aria-label="Hide details"]');
    await page.waitFor(`return !document.querySelector('.chat-inspector [role=tab]') && !!document.querySelector('.chat-inspector .insp-rail')`, { label: 'the drawer folds into its rail' });
    const railWidth = await page.eval(`return document.querySelector('.chat-inspector').getBoundingClientRect().width`);
    check(railWidth <= 60, `the folded drawer is a thin rail (${railWidth}px)`);
    await page.goto(`/chats/${SESSION}`, 1200);
    await page.waitFor(`return !!document.querySelector('.chat-head h1')`, { label: 'the chat again' });
    check(!(await page.eval(`return !!document.querySelector('.chat-inspector [role=tab]')`)), 'a folded drawer stays folded after a reload');
    // A tab's own button in the rail opens the drawer on that tab
    await page.click('.insp-rail button[aria-label="Changes"]');
    await page.waitFor(`return document.querySelector('.chat-inspector [role=tab][aria-selected=true]')?.textContent.trim() === 'Changes'`, { label: 'the drawer opens on Changes' });
    await page.click('.chat-inspector [role=tab]', 'Summary');

    // ---- the status line under the composer opens what a resume may start with ----
    const status = await page.text('.composer-status');
    check(status.includes('claude-sonnet-5') && status.includes('no preset') && status.includes('MCP: CLI default'), `the status line says what the next message runs with (${status})`);
    await page.click('.composer-status');
    await page.waitFor(`return !!document.querySelector('.composer-options [aria-label="Permission mode for the new execution"]')`, { label: 'the run options' });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('.composer-options')`, { label: 'the run options close' });

    // ---- on a phone the inspector is a sheet, and nothing scrolls sideways ----
    await page.viewport(390, 844);
    await page.goto(`/chats/${SESSION}`, 1200);
    await page.waitFor(`return !!document.querySelector('.chat-head h1')`, { label: 'the chat on a phone' });
    check(!(await page.eval(`return !!document.querySelector('.chat-inspector')`)), 'no side panel on a phone');
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `the chat does not scroll sideways on a phone (${overflow}px)`);
    // At the narrowest phone the header keeps its title and every action inside the screen
    await page.viewport(320, 640);
    await page.waitFor(`return !!document.querySelector('.chat-head button[aria-label="More chat actions"]')`, { label: 'the header at 320px' });
    const past = await page.eval(`return [...document.querySelectorAll('.chat-head *')].filter((e)=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+0.5||r.left<-0.5)}).length`);
    check(past === 0, `nothing in the header leaves a 320px screen (${past} elements do)`);
    const titleWidth = await page.eval(`return document.querySelector('.chat-head h1').getBoundingClientRect().width`);
    check(titleWidth >= 60, `the title keeps room to be read at 320px (${titleWidth}px)`);
    await page.focus('.chat-head button[aria-label="More chat actions"]');
    await page.key('Enter');
    await page.waitFor(`return !!document.querySelector('[role=menu]')`, { label: 'the chat menu on a phone' });
    check((await page.text('[role=menu]')).includes('Search'), 'on a phone search is in the menu');
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=menu]')`, { label: 'the menu closes' });
    await page.viewport(390, 844);
    await page.click('.chat-head button[aria-label="Chat details"]');
    await page.waitFor(`return !!document.querySelector('[role=dialog] .chat-inspector-body')`, { label: 'the inspector as a sheet' });
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the sheet closes' });
    await page.viewport(1440, 900);

    // ---- New chat: the chat's own shape, settings behind the line under the box ----
    await page.goto('/chats/new', 1200);
    await page.waitFor(`return !!document.querySelector('.run-layout .composer textarea')`, { label: 'the new chat box' });
    check(await page.eval(`return document.querySelector('main textarea') === document.querySelector('.composer textarea')`), 'the box is the first field');
    check(await page.eval(`return !!document.querySelector('.new-welcome-example')`), 'the page says what it is for before anything is typed');
    check(!(await page.eval(`return !!document.querySelector('input[aria-label="Model"]')`)), 'the settings are out of the way until asked for');
    check((await page.text('.composer-status')).includes('default model'), 'the line under the box says where the chat will run');
    await page.click('.composer-status', undefined, 400);
    await page.waitFor(`return !!document.querySelector('input[aria-label="Model"]')`, { label: 'the settings open' });
    await page.key('Escape');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem(${JSON.stringify(INSPECTOR_KEY)}); return true`).catch(() => {});
    // Later specs count the seeded chats
    await api.del(`/chats/${SESSION}`).catch(() => {});
  }
};
