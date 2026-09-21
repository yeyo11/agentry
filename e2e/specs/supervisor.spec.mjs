// The supervisor's settings: off by default, turned on and given a ceiling from Settings, and a
// ceiling the server refuses. A proposal only exists once a live worker turns bad and a model
// answers, so Send, Edit and Dismiss on the health card are covered by the unit tests of core and
// the API, not here: this spec never starts a model.
const DEFAULTS = { enabled: false, model: 'haiku', autoSend: false, maxCostUsd: 0.05 };

export default async ({ page, api, check }) => {
  const before = await api.get('/settings/supervisor');
  check(before.status === 200, `the supervisor settings are read (${before.status})`);
  try {
    await api.put('/settings/supervisor', DEFAULTS);

    await page.goto('/settings?tab=supervisor', 1500);
    await page.waitFor(`return document.querySelector('[role=tabpanel]')?.innerText.includes('Propose hints for workers that look stuck')`, {
      label: 'the supervisor tab',
    });
    const panel = await page.text('[role=tabpanel]');
    for (const text of ['Model', 'Cost limit per proposal (USD)', 'Send each proposal to the worker on its own']) {
      check(panel.includes(text), `the supervisor tab has "${text}"`);
    }
    check(await page.eval(`return document.querySelector('[role=tabpanel] button[type=submit]').disabled`), 'nothing to save before a change');

    // Turned on from the form, with a ceiling of its own
    await page.eval(
      `[...document.querySelectorAll('[role=tabpanel] [role=switch]')].find((s) => s.closest('label')?.textContent.includes('Propose hints')).click(); return true`,
    );
    await page.fill('[role=tabpanel] input[aria-label="Cost limit per proposal (USD)"]', '0.2');
    await page.click('[role=tabpanel] button[type=submit]', 'Save', 800);
    await page.waitFor(`return document.body.innerText.includes('Supervisor settings saved')`, { label: 'the settings are saved' });
    const saved = (await api.get('/settings/supervisor')).body;
    check(saved.enabled === true && saved.maxCostUsd === 0.2 && saved.model === 'haiku' && saved.autoSend === false, `the settings are stored (${JSON.stringify(saved)})`);

    // The form refuses a ceiling the server would, and the server refuses it for a client that skips the form
    await page.fill('[role=tabpanel] input[aria-label="Cost limit per proposal (USD)"]', '9');
    await page.waitFor(`return document.querySelector('[role=tabpanel]').innerText.includes('The limit has to be above $0')`, { label: 'the ceiling is refused' });
    check(await page.eval(`return document.querySelector('[role=tabpanel] button[type=submit]').disabled`), 'a ceiling out of range cannot be saved');
    const refused = await api.put('/settings/supervisor', { ...DEFAULTS, maxCostUsd: 9 });
    check(refused.status === 400, `the server refuses a ceiling above $5 (${refused.status})`);

    const violations = await page.axe({ include: '[role=tabpanel]' });
    check(violations.length === 0, `the supervisor tab has accessibility violations: ${JSON.stringify(violations)}`);
  } finally {
    await api.put('/settings/supervisor', before.body ?? DEFAULTS).catch(() => {});
  }
};
