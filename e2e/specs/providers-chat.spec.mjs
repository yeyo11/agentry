// The provider on the chat page, the chats list and New chat, against the fake agents of
// e2e/fake-providers (they speak the real protocols from the recordings, see its README).
//
// Codex is the sandbox's default fake (`run.mjs` seeds its override); Copilot is pointed at its fake
// here through Settings → Providers' binary override and put back at the end.
//
// What is not covered: an OpenCode chat whose history comes from a fixture database. It needs the
// recorded schema built with `node:sqlite` and an `OPENCODE_DB` the server was started with, which
// the sandbox does not set; the driver side has its own test (packages/core/test/opencode-transcripts.test.ts).
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const fakeCli = true;
export const timeout = 170_000;

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-providers');
const overflow = `return document.documentElement.scrollWidth - innerWidth`;

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

export default async ({ page, api, check, dirs }) => {
  const saved = (await api.get('/providers/settings')).body;
  const created = [];
  const ready = (id) => page.waitFor(`return fetch('/api/providers/${id}').then((r) => r.json()).then((s) => s.state === 'ready')`, { label: `${id} is ready` });
  const theme = (name) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);

  try {
    await api.put('/providers/settings', { ...saved, providers: { ...saved.providers, copilot: { enabled: true, binaryPath: join(fakes, 'copilot') } }, defaultProvider: null });
    await api.post('/providers/refresh');
    await ready('codex');
    await ready('copilot');

    // ---- A chat on the fake Codex: the provider in the header and its words in the transcript ----
    const codex = await api.post('/chats', { prompt: 'TURN tidy the build', cwd: dirs.workspaceDir, provider: 'codex', permissionPrompts: 'host' });
    check(codex.status < 300 && codex.body.provider === 'codex', `the chat starts on codex (${codex.status} ${codex.body?.provider})`);
    created.push(codex.body.id);
    await page.viewport(1440, 900);
    await page.goto('/', 300);
    await theme('dark');
    await page.goto(`/chats/${codex.body.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.chat-head .prov-badge')`, { label: 'the provider badge in the header' });
    check((await page.text('.chat-head .prov-badge')).trim() === 'Codex', 'the header names the provider');
    await page.waitFor(`return document.body.innerText.includes('reply: TURN tidy the build')`, { label: 'the fake codex answer' });
    const words = await page.eval(`return document.body.innerText`);
    check(!/commandExecution|COMMANDEXECUTION|fileChange|acceptEdits/.test(words), 'no wire identifier reaches the screen');
    check(!words.includes('Claude is working'), 'nothing in the chat page names Claude on a Codex chat');
    await page.shot('providers-chat-codex-dark');
    await scan(page, check, 'a Codex chat, dark');

    // The details panel names the agent too
    const details = await page.eval(`return [...document.querySelectorAll('.insp-facts dt')].map((d) => d.textContent.trim())`);
    check(details.includes('Agent'), `the details list the agent (${details.join(', ')})`);

    await theme('light');
    await page.goto(`/chats/${codex.body.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.chat-head .prov-badge')`, { label: 'the badge, light' });
    await scan(page, check, 'a Codex chat, light');
    await theme('dark');

    // ---- The permission request of a fake Copilot, answered from the chat ----
    const copilot = await api.post('/chats', { prompt: 'ASK execute', cwd: dirs.workspaceDir, provider: 'copilot', permissionPrompts: 'host' });
    check(copilot.status < 300 && copilot.body.provider === 'copilot', `the chat starts on copilot (${copilot.status})`);
    created.push(copilot.body.id);
    await page.goto(`/chats/${copilot.body.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.permission .btn-primary')`, { label: 'the permission request' });
    check((await page.text('.chat-head .prov-badge')).trim() === 'GitHub Copilot', 'the header names Copilot');
    check((await page.text('.permission-head')).length > 0 && !/execute\b/.test(await page.text('.permission-head')), 'the kind of tool is said in words, not as the wire names it');
    await page.shot('providers-chat-copilot-permission');
    await page.click('.permission .btn-primary', undefined, 800);
    await page.waitFor(`return !document.querySelector('.permission')`, { label: 'the request is answered' });

    // ---- The chats list: the mark of each chat's agent ----
    await page.goto('/chats', 800);
    await page.waitFor(`return document.querySelectorAll('.crow .prov-mark').length >= 2`, { label: 'a mark on each row' });
    const marks = await page.eval(`return [...document.querySelectorAll('.crow .prov-mark')].map((m) => m.getAttribute('aria-label'))`);
    check(marks.includes('Codex') && marks.includes('GitHub Copilot'), `the rows carry their agent (${marks.join(', ')})`);
    await page.shot('providers-chats-dark');
    await scan(page, check, 'the chats list, dark');
    await theme('light');
    await page.goto('/chats', 800);
    await page.waitFor(`return document.querySelectorAll('.crow .prov-mark').length >= 2`, { label: 'the marks, light' });
    await scan(page, check, 'the chats list, light');
    await theme('dark');

    // ---- New chat: the picker, the model locked on Copilot, the modes of the provider ----
    await page.goto('/chats/new', 800);
    await page.waitFor(`return !!document.querySelector('.composer-status')`, { label: 'the options chip' });
    await page.click('.composer-status', undefined, 400);
    await page.waitFor(`return !!document.querySelector('[aria-label="Agent"]')`, { label: 'the agent picker' });
    const picked = await api.get('/providers');
    const first = picked.body.find((p) => p.state === 'ready' || p.state === 'degraded');
    check(Boolean(first), 'at least one provider is ready');
    // Pick Copilot: its model field is disabled and says why
    await page.click('[aria-label="Agent"]', undefined, 300);
    await page.click('[role=option]', 'GitHub Copilot', 300);
    await page.waitFor(`return document.querySelector('input[aria-label="Model"]')?.disabled === true`, { label: 'the model is locked on Copilot' });
    check((await page.eval(`return document.body.innerText`)).includes('GitHub Copilot picks the model when the chat starts'), 'the reason is said next to the model');
    await page.shot('providers-newchat-copilot');
    await scan(page, check, 'New chat on Copilot, dark');
    // Back to Codex: the model can be chosen again
    await page.click('[aria-label="Agent"]', undefined, 300);
    await page.click('[role=option]', 'Codex', 300);
    await page.waitFor(`return document.querySelector('input[aria-label="Model"]')?.disabled === false`, { label: 'the model is free on Codex' });

    // ---- The same pages on a phone ----
    await page.viewport(390, 844);
    await page.goto(`/chats/${codex.body.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.chat-head .prov-badge')`, { label: 'the badge on a phone' });
    check((await page.eval(overflow)) <= 0, 'the chat header does not scroll sideways on a phone');
    await scan(page, check, 'a Codex chat on a phone');
    await page.goto('/chats', 800);
    await page.waitFor(`return document.querySelectorAll('.crow .prov-mark').length >= 2`, { label: 'the marks on a phone' });
    check((await page.eval(overflow)) <= 0, 'the chats list does not scroll sideways on a phone');
    await page.shot('providers-chats-phone-dark');
    await scan(page, check, 'the chats list on a phone');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    for (const id of created) await api.post(`/chats/${id}/stop`).catch(() => {});
    await api.put('/providers/settings', saved).catch(() => {});
    await api.post('/providers/refresh').catch(() => {});
  }
};
