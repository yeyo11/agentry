// A person's chat at its provider's limit, and what the page offers: the banner with its actions, the
// handoff the next agent would receive, a wait that is set and stopped, and a move to Codex that
// leaves the old chat ending in a divider and the new one with a header link and a handoff card.
//
// Claude is the fake CLI (`FAKE-LIMIT` is a rejected `rate_limit_event` and a 429), Codex the fake of
// e2e/fake-providers. Nothing is moved without a click: a person's chat never moves on its own.
export const fakeCli = true;
export const timeout = 170_000;

const overflow = `return document.documentElement.scrollWidth - innerWidth`;

async function scan(page, check, label) {
  await page.reduceMotion(true);
  await page.sleep(500);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => [n.target, n.why]) })))}`);
}

export default async ({ page, api, check, dirs }) => {
  const saved = (await api.get('/providers/settings')).body;
  const created = [];
  const theme = (name) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);
  const text = (selector) => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
  // The chat reaches its limit when the provider's reading says so; the page reads the same fact
  const limited = async (prompt = 'FAKE-LIMIT') => {
    const started = await api.post('/chats', { prompt, cwd: dirs.workspaceDir, provider: 'claude-code', permissionPrompts: 'host' });
    check(started.status < 300, `a Claude chat starts (${started.status} ${JSON.stringify(started.body)})`);
    created.push(started.body.id);
    const end = Date.now() + 40_000;
    for (;;) {
      const status = (await api.get('/providers/claude-code')).body;
      const chat = (await api.get(`/chats/${started.body.id}?limit=1`)).body?.chat;
      if (status?.limit?.state === 'exhausted' && chat && chat.state !== 'working') return chat;
      if (Date.now() > end) throw new Error(`timed out waiting for the chat to reach its limit (${JSON.stringify(status?.limit)})`);
      await page.sleep(250);
    }
  };
  const clickButton = (label) => page.click('.lim .btn', label, 400);

  try {
    // A model the chat runs on needs a counterpart before it can move; a chat with none needs nothing
    const probe = await limited();
    const mapping = probe.model ? [{ from: { provider: 'claude-code', model: probe.model }, to: { provider: 'codex', model: 'gpt-6.1-sol' }, origin: 'person', at: new Date().toISOString() }] : [];
    await api.put('/providers/settings', {
      ...saved,
      rotation: { onLimit: { action: 'handoff', allowed: ['handoff', 'restart', 'wait'], maxWaitHours: 6, maxMoves: 2 }, modelMap: mapping },
    });
    await api.post('/providers/refresh');

    // ---- The banner at the limit, in both themes ----
    await page.viewport(1440, 900);
    await page.goto('/', 300);
    await theme('dark');
    await page.goto(`/chats/${probe.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.lim .lim-title')`, { label: 'the limit banner' });
    const title = await text('.lim .lim-title');
    check(/Claude Code reached its .*limit/.test(title), `the banner names the provider and the limit (${JSON.stringify(title)})`);
    check(/Resets|reset time is not known/.test(await text('.lim .lim-reset')), 'the banner says when it resets, or that it does not know');
    const primaries = await page.eval(`return [...document.querySelectorAll('.lim .btn-primary')].map((b) => b.textContent.trim())`);
    check(primaries.length === 1 && /^Continue on Codex$/.test(primaries[0]), `the setting's action is the one primary (${JSON.stringify(primaries)})`);
    const composerOff = await page.eval(`return document.querySelector('.lim-composer textarea')?.disabled === true`);
    check(composerOff, 'the box under the banner cannot take a message while the chat is at its limit');
    check(!(await page.eval(`return !!document.querySelector('.lim .spinner, .lim .shimmer')`)), 'nothing in the banner moves: a limit is not live work');
    await page.shot('provider-rotation-limit-dark');
    await scan(page, check, 'a chat at its limit, dark');
    await theme('light');
    await page.goto(`/chats/${probe.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.lim .lim-title')`, { label: 'the limit banner, light' });
    await page.shot('provider-rotation-limit-light');
    await scan(page, check, 'a chat at its limit, light');
    await theme('dark');
    await page.goto(`/chats/${probe.id}`, 1200);

    // ---- The handoff, exactly as it would be sent, and sent nowhere yet ----
    await clickButton('See the handoff');
    await page.waitFor(`return !!document.querySelector('.dialog .hand-text') && document.querySelector('.dialog .hand-text').innerText.length > 40`, { label: 'the handoff text' });
    const handoff = await text('.dialog .hand-text');
    check(/What was asked/.test(handoff), 'the preview carries the first section of the handoff');
    check((await text('.dialog')).includes('Nothing has been sent yet'), 'the sheet says nothing was sent');
    await page.shot('provider-rotation-handoff-dark');
    await scan(page, check, 'the move dialog');
    const before = (await api.get(`/chats/${probe.id}?limit=1`)).body.chat;
    check(!before.continuedIn, 'looking at the handoff moves nothing');
    await page.click('.dialog .btn', 'Cancel', 400);
    await page.waitFor(`return !document.querySelector('.dialog')`, { label: 'the dialog closes' });

    // ---- A wait is set and then cancelled ----
    await clickButton('Wait for the reset');
    await page.waitFor(`return /Waiting for Claude Code/.test(document.querySelector('.lim .lim-title')?.textContent ?? '')`, { label: 'the waiting banner' });
    const waits = (await api.get(`/providers/moves?chatId=${probe.id}&state=waiting`)).body;
    check(Array.isArray(waits) && waits.length === 1, `the wait is a row of the move history (${JSON.stringify(waits)})`);
    check(!(await page.eval(`return !!document.querySelector('.lim .btn-primary')`)), 'a waiting banner has no primary action');
    check((await text('.lim')).includes('Move now') && (await text('.lim')).includes('Stop waiting'), 'a waiting banner offers Move now and Stop waiting');
    await page.shot('provider-rotation-waiting-dark');
    await scan(page, check, 'a chat that waits for the reset');
    await clickButton('Stop waiting');
    await page.waitFor(`return /reached its/.test(document.querySelector('.lim .lim-title')?.textContent ?? '')`, { label: 'back at the limit after the wait is stopped' });
    const after = (await api.get(`/providers/moves?chatId=${probe.id}&state=waiting`)).body;
    check(after.length === 0, 'a wait that was stopped is no longer open');

    // ---- The move: a new chat on Codex with a handoff, linked both ways ----
    await clickButton('Continue on Codex');
    await page.waitFor(`return !!document.querySelector('.dialog .hand-text')`, { label: 'the move dialog' });
    await page.click('.dialog .btn-primary', undefined, 600);
    await page.waitFor(`return location.pathname !== ${JSON.stringify(`/chats/${probe.id}`)} && location.pathname.startsWith('/chats/')`, { label: 'the new chat opens' });
    const next = decodeURIComponent((await page.eval(`return location.pathname`)).split('/').pop());
    created.push(next);
    const old = (await api.get(`/chats/${probe.id}?limit=1`)).body.chat;
    const fresh = (await api.get(`/chats/${next}?limit=1`)).body.chat;
    check(old.continuedIn?.chatId === next && old.continuedIn.provider === 'codex' && old.continuedIn.action === 'handoff', `the old chat points at the new one (${JSON.stringify(old.continuedIn)})`);
    check(fresh.continuedFrom?.chatId === probe.id && fresh.provider === 'codex', `the new chat points back, on Codex (${JSON.stringify(fresh.continuedFrom)})`);

    await page.waitFor(`return !!document.querySelector('.cont-from') && !!document.querySelector('.hand-card')`, { label: 'the continued header and the handoff card' });
    check((await text('.cont-from')).includes('Continued from Claude Code'), 'the new chat says where it continues from');
    check((await page.eval(`return document.querySelector('.hand-card [aria-expanded]')?.getAttribute('aria-expanded')`)) === 'false', 'the handoff card starts collapsed');
    check(!(await page.eval(`return !!document.querySelector('.hand-card .hand-text')`)), 'a collapsed card does not show the text');
    await page.click('.hand-card [aria-expanded]', undefined, 300);
    check(/What was asked/.test(await text('.hand-card .hand-text')), 'opening the card shows the handoff the agent received');
    await page.shot('provider-rotation-continued-dark');
    await scan(page, check, 'the continued chat, dark');
    await theme('light');
    await page.goto(`/chats/${next}`, 1200);
    await page.waitFor(`return !!document.querySelector('.hand-card')`, { label: 'the handoff card, light' });
    await scan(page, check, 'the continued chat, light');
    await theme('dark');

    // The old chat ends with a divider and no banner; the divider leads to the new chat
    await page.goto(`/chats/${probe.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.cont-div')`, { label: 'the divider at the end of the old chat' });
    check(/Continued on Codex/.test(await text('.cont-div')), `the divider says where the work went (${JSON.stringify(await text('.cont-div'))})`);
    check(!(await page.eval(`return !!document.querySelector('.lim .lim-acts')`)), 'a chat that moved on offers no more actions');
    await page.shot('provider-rotation-divider-dark');
    await scan(page, check, 'the old chat with its divider');
    await page.click('.cont-div', undefined, 800);
    await page.waitFor(`return location.pathname.endsWith(${JSON.stringify(encodeURIComponent(next))})`, { label: 'the divider opens the new chat' });

    // ---- A phone: the actions stack, the sheet is a bottom sheet, nothing scrolls sideways ----
    const second = await limited();
    await page.viewport(390, 844);
    await page.goto(`/chats/${second.id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.lim .lim-acts')`, { label: 'the banner on a phone' });
    check((await page.eval(overflow)) <= 0, 'the banner does not scroll sideways on a phone');
    const small = await page.eval(`return [...document.querySelectorAll('.lim-acts .btn')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim())`);
    check(small.length === 0, `every action is at least 44 px tall on a phone (${JSON.stringify(small)})`);
    await page.shot('provider-rotation-limit-phone');
    await scan(page, check, 'the banner on a phone');
    await clickButton('See the handoff');
    await page.waitFor(`return !!document.querySelector('[role=dialog] .hand-text')`, { label: 'the sheet on a phone' });
    check((await page.eval(overflow)) <= 0, 'the sheet does not scroll sideways on a phone');
    await page.shot('provider-rotation-sheet-phone');
    await scan(page, check, 'the move sheet on a phone');
  } finally {
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    for (const id of created) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      await api.del(`/chats/${id}`).catch(() => {});
    }
    await api.put('/providers/settings', saved).catch(() => {});
    await api.post('/providers/refresh').catch(() => {});
  }
};
