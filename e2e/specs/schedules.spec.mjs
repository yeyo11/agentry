// Schedules: a recurring chat is created from the cron builder (which says in words what it will
// do before anything is saved), given an overlap policy, turned off and on (also from the API, which
// the page hears on the event feed instead of polling), run by hand, its history read, and deleted.
// Whatever a run-now starts is removed afterwards, because the chats spec counts what the sandbox holds.

const NAME = 'e2e nightly check';

async function noViolations(page, where, check, options = {}) {
  const found = await page.axe(options);
  const lines = found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target} ${n.why}`));
  check(lines.length === 0, `${where} has accessibility violations:\n${lines.join('\n')}`);
}

export default async ({ page, api, check }) => {
  const started = [];
  let scheduleId = null;
  try {
    check((await api.get('/schedules')).body.length === 0, 'the sandbox starts with no schedules');
    await page.reduceMotion();
    await page.goto('/schedules', 900);
    await page.waitFor(`return document.querySelector('main').innerText.includes('No schedules yet')`, { label: 'the empty state' });
    const notice = await page.text('main');
    check(/skipped, not replayed/i.test(notice), 'the page says a missed window is skipped, not replayed');

    // ---------- the cron builder says what it will do ----------
    await page.click('main .page-actions a', 'New schedule');
    await page.waitFor(`return location.pathname === '/schedules/new' && !!document.querySelector('main .schedule-form')`, { label: 'the form, on a page of its own' });
    check(!(await page.eval(`return !!document.querySelector('.schedule-form')`)), 'a new schedule is a page, not a dialog');
    const preview = async () => page.eval(`return document.querySelector('[data-testid=cron-preview]')?.innerText ?? ''`);
    await page.waitFor(`return /At 09:00/.test(document.querySelector('[data-testid=cron-preview]')?.innerText ?? '')`, { label: 'the default timetable in words' });

    await page.select('.schedule-form .select-trigger', 'Every weekday');
    await page.waitFor(`return /Monday to Friday/.test(document.querySelector('[data-testid=cron-preview]')?.innerText ?? '')`, { label: 'the weekday timetable in words' });
    check((await preview()).includes('At 09:00'), 'the preview keeps the time of day');
    const cron = await page.eval(`return document.querySelector('.schedule-form input.mono').value`);
    check(cron === '0 9 * * 1-5', `the builder wrote the expression (${cron})`);
    check(await page.eval(`return document.querySelector('.schedule-form input.mono').readOnly`), 'the built expression is read-only until Custom is chosen');
    const nextFires = await page.eval(`return document.querySelectorAll('[data-testid=cron-preview] li').length`);
    check(nextFires === 5, `the preview lists the next five fires (${nextFires})`);

    // A hand-written expression that is not valid is said to be wrong, and cannot be saved
    await page.select('.schedule-form .select-trigger', 'Custom expression');
    await page.fill('.schedule-form input.mono', '61 * * * *');
    await page.waitFor(`return document.querySelector('[data-testid=cron-preview]')?.classList.contains('is-invalid')`, { label: 'the invalid expression flagged' });
    const wrong = (await preview()).trim();
    check(wrong.length > 0 && !/At \d/.test(wrong), `the invalid expression says what is wrong, not a timetable (${wrong})`);
    await page.fill('.schedule-form input[placeholder="Morning dependency check"]', NAME);
    await page.fill('.schedule-form textarea', 'Summarise what changed since yesterday');
    check(await page.eval(`return [...document.querySelectorAll('.schedule-form button')].find((b) => b.textContent.includes('Create schedule')).disabled`), 'an invalid expression cannot be saved');
    await noViolations(page, 'the schedule form page', check);

    // The overlap policy says in a sentence what each choice does
    check(/even while the previous one/.test(await page.text('[data-testid=overlap-hint]')), 'the default policy starts every slot, and says so');
    await page.click('.schedule-form [role=radio]', 'Skip', 400);
    check(/recorded as overlapped/.test(await page.text('[data-testid=overlap-hint]')), 'skip says a slot is recorded as overlapped');
    await page.click('.schedule-form [role=radio]', 'Queue', 400);
    check(/At most one waits/.test(await page.text('[data-testid=overlap-hint]')), 'queue says only one slot waits');
    await page.click('.schedule-form [role=radio]', 'Skip', 400);

    await page.fill('.schedule-form input.mono', '0 9 * * 1-5');
    await page.waitFor(`return !document.querySelector('[data-testid=cron-preview]')?.classList.contains('is-invalid') && /Monday to Friday/.test(document.querySelector('[data-testid=cron-preview]')?.innerText ?? '')`, { label: 'the valid expression accepted' });
    await page.click('.schedule-form button', 'Create schedule', 800);
    await page.waitFor(`return location.pathname === '/schedules' && document.querySelector('main').innerText.includes(${JSON.stringify(NAME)})`, { label: 'back on the list, with the schedule' });

    const list = (await api.get('/schedules')).body;
    check(list.length === 1 && list[0].name === NAME, 'the schedule was stored');
    check(list[0].cron === '0 9 * * 1-5' && list[0].enabled === true, 'it stored the expression and starts enabled');
    check(list[0].target.kind === 'chat' && list[0].target.chat.permissionPrompts === 'none', 'a scheduled chat does not wait for a permission prompt');
    check(list[0].overlap === 'skip', `the overlap policy was stored (${list[0].overlap})`);
    scheduleId = list[0].id;
    check((await page.text('.schedule-card')).includes('Skips overlaps'), 'the card says it skips overlaps, in words');

    const card = await page.text('.schedule-card');
    check(card.includes('0 9 * * 1-5'), 'the card shows the expression');
    check(card.includes('At 09:00, on Monday to Friday'), 'the card says the timetable in words');
    check(/Next run/.test(card), 'the card says when it fires next');
    await page.shot('schedules-list');

    // ---------- editing is the same page, filled in ----------
    await page.click(`.schedule-card a[aria-label="Edit ${NAME}"]`);
    await page.waitFor(`return location.pathname === '/schedules/${scheduleId}/edit' && document.querySelector('.schedule-form input[placeholder="Morning dependency check"]')?.value === ${JSON.stringify(NAME)}`, { label: 'the edit page with the schedule' });
    await page.click('.schedule-form button', 'Cancel', 600);
    await page.waitFor(`return location.pathname === '/schedules'`, { label: 'Cancel goes back to the list' });

    // ---------- on and off ----------
    await page.click('.schedule-card [role=switch]');
    await page.waitFor(`return document.querySelector('.schedule-card')?.innerText.includes('Paused')`, { label: 'the card saying it is paused' });
    check((await api.get(`/schedules/${scheduleId}`)).body.enabled === false, 'turning it off is stored');
    check((await page.text('.schedule-card')).includes('Off'), 'a schedule that is off is marked in words');
    await page.click('.schedule-card [role=switch]');
    await page.waitFor(`return document.querySelector('.schedule-card')?.innerText.includes('Next run')`, { label: 'the card firing again' });
    check((await api.get(`/schedules/${scheduleId}`)).body.enabled === true, 'turning it on is stored');

    // A change made elsewhere reaches the page through schedule.changed, with no reload and no 30 s poll
    await api.post(`/schedules/${scheduleId}/disable`);
    await page.waitFor(`return document.querySelector('.schedule-card')?.innerText.includes('Paused')`, { label: 'the page hearing the change from the feed', timeout: 8000 });
    await api.post(`/schedules/${scheduleId}/enable`);
    await page.waitFor(`return document.querySelector('.schedule-card')?.innerText.includes('Next run')`, { label: 'the page hearing it back on', timeout: 8000 });

    // ---------- run now, and the history ----------
    await page.click('.schedule-card button', 'Run now', 800);
    const runs = await (async () => {
      for (let i = 0; i < 40; i++) {
        const body = (await api.get(`/schedules/${scheduleId}/runs`)).body;
        if (body.length > 0) return body;
        await page.sleep(250);
      }
      return [];
    })();
    check(runs.length === 1, `run now recorded one run (${runs.length})`);
    check(runs[0].slot === undefined, 'a run started by hand has no slot');
    for (const run of runs) if (run.chatId) started.push(run.chatId);

    await page.click('.schedule-card .collapsible-trigger', 'Run history', 600);
    await page.waitFor(`return document.querySelectorAll('.schedule-card tbody tr').length >= 1`, { label: 'the history rows' });
    const history = await page.text('.schedule-card table');
    check(/Run by hand/.test(history), 'the history says the run was started by hand');
    check(/Started|failed/i.test(history), 'the history says how the run ended, in words');
    if (runs[0].chatId) check(await page.eval(`return document.querySelector('.schedule-card tbody a[href^="/chats/"]') !== null`), 'a started run links to its chat');
    await noViolations(page, '/schedules with a card and its history', check);

    // ---------- light theme ----------
    await page.eval(`localStorage.setItem('agentry-theme', 'light'); return true`);
    await page.goto('/schedules', 900);
    await page.waitFor(`return !!document.querySelector('.schedule-card')`, { label: 'the card in the light theme' });
    await noViolations(page, '/schedules in the light theme', check);
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`);
    await page.goto('/schedules', 900);

    // ---------- delete ----------
    await page.click(`.schedule-card button[aria-label="Delete ${NAME}"]`);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the confirmation' });
    await page.click('[role=dialog] button', 'Delete', 800);
    await page.waitFor(`return document.querySelector('main').innerText.includes('No schedules yet')`, { label: 'the empty state again' });
    check((await api.get('/schedules')).body.length === 0, 'the schedule is gone');
    scheduleId = null;
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    if (scheduleId) await api.del(`/schedules/${scheduleId}`).catch(() => {});
    for (const id of started) {
      await api.post(`/chats/${id}/stop`).catch(() => {});
      await api.del(`/chats/${id}`).catch(() => {});
    }
  }
};
