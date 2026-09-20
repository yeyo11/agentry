// The accounts page against a stub claude-swap: an account's config directory (set, and taken back),
// a rotation policy (created, listed, deleted) and the usage history (a chart with its table).
//
// The sandbox starts with no claude-swap, and pages.spec asserts the page says so, so this spec puts
// a stub where the wrapper looks for one and takes it away again, whatever happens in between.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIST = {
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: 'one@example.com',
      active: true,
      usageStatus: 'ok',
      usage: { fiveHour: { pct: 40.0, resetsAt: null, countdown: null }, sevenDay: { pct: 10.0, resetsAt: null, countdown: null } },
      usageFetchedAt: new Date().toISOString(),
    },
    {
      number: 2,
      email: 'two@example.com',
      alias: 'work',
      active: false,
      usageStatus: 'ok',
      usage: { fiveHour: { pct: 5.0, resetsAt: null, countdown: null }, sevenDay: { pct: 1.0, resetsAt: null, countdown: null } },
      usageFetchedAt: new Date().toISOString(),
    },
  ],
};

export default async ({ page, api, check, dirs }) => {
  // The wrapper was started with CSWAP_BIN pointing here, at a file that does not exist
  const bin = resolve(dirs.dataDir, '..', 'no-cswap');
  const configDir = join(mkdtempSync(join(tmpdir(), 'agentry-e2e-acct-')), 'claude-one');
  const workspace = join(dirs.workspaceDir, 'e2e-accounts');
  mkdirSync(workspace, { recursive: true });
  const seeded = [];
  let projectId = null;
  const policies = [];

  const installed = async () => (await api.get('/accounts?refresh=1')).body;

  try {
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "cswap 0.26.0" ;;\n  list) echo '${JSON.stringify(LIST)}' ;;\n  *) echo "unexpected: $*" >&2; exit 2 ;;\nesac\n`);
    chmodSync(bin, 0o755);
    check((await installed()).cswap.installed === true, 'the stub claude-swap was found');

    // Readings to draw: two accounts over the last hours, written where the sampler writes them
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 5000');
    const insert = db.prepare('INSERT OR IGNORE INTO usage_history (account, window, at, pct) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      for (const [account, pct] of [[1, 10 + i * 4], [2, 5 + i]]) {
        const at = new Date(now - (12 - i) * 10 * 60_000).toISOString();
        insert.run(account, '5h', at, pct);
        seeded.push([account, at]);
      }
    }
    db.close();

    await page.goto('/accounts', 1500);
    await page.waitFor(`return document.querySelector('main')?.innerText.includes('one@example.com')`, { label: 'the accounts' });

    // ---------- usage history ----------
    await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the usage chart' });
    const chart = await page.eval(`const svg = document.querySelector('main svg[role=img]'); return { name: svg.querySelector('title')?.textContent ?? '', desc: svg.querySelector('desc')?.textContent ?? '', lines: svg.querySelectorAll('path').length }`);
    check(chart.name.length > 0 && chart.desc.includes('one@example.com'), 'the chart is named and described for a screen reader');
    check(chart.lines === 2, `the chart draws a line per account (saw ${chart.lines})`);
    await page.click('main button', 'Show the figures as a table', 500);
    const table = await page.text('main table');
    check(table.includes('#1') && table.includes('#2'), 'the figures are in a table behind the chart');
    // The window and the range both have a "7 days": the range is the group named Range
    await page.click('[aria-label="Range"] [role=radio]', '7 days', 600);
    await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the chart over seven days' });

    // ---------- config directory ----------
    await page.click('main button', 'Config directory', 500);
    await page.fill('input[aria-label="Config directory of one@example.com"]', 'relative/path');
    check((await page.text('main')).includes('The path must be absolute.'), 'a relative path is refused before it is sent');
    await page.fill('input[aria-label="Config directory of one@example.com"]', configDir);
    await page.click('main button', 'Use this directory', 800);
    await page.waitFor(`return document.querySelector('main')?.innerText.includes('own directory')`, { label: 'the account shows its own directory' });
    let overview = await installed();
    check(overview.configs.some((c) => c.number === 1 && c.configDir === configDir), 'the config directory was saved');
    check(existsSync(configDir), 'the directory was created');
    check((await page.text('main')).includes(`CLAUDE_CONFIG_DIR=${configDir} claude`), 'the page says the account needs its own login');

    await page.click('main button', 'Back to shared', 500);
    await page.click('[role=dialog] button', 'Back to shared', 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the confirmation closed' });
    overview = await installed();
    check(!overview.configs.some((c) => c.number === 1 && c.configDir), 'the account is back on the shared directory');

    // ---------- rotation policy ----------
    const imported = await api.post('/projects/import', { path: workspace, name: 'e2e-accounts' });
    check(imported.status === 201, `the project was imported (${imported.status})`);
    projectId = imported.body.id;
    await page.goto('/accounts', 1500);
    await page.click('main button', 'New policy', 500);
    await page.click('.chips button', 'e2e-accounts', 300);
    await page.click('.chips button', '#2 · work', 300);
    check((await page.text('[aria-labelledby=policy-order]')).includes('#2 · work'), 'the account joins the order');
    await page.click('main button', 'Create policy', 800);
    await page.waitFor(`return document.querySelector('main')?.innerText.includes('moves on at')`, { label: 'the policy is listed' });
    const listed = (await api.get('/accounts/policies')).body;
    check(listed.length === 1 && listed[0].projects.includes(projectId) && listed[0].order?.[0] === 2, 'the policy was stored with its project and order');
    policies.push(...listed.map((p) => p.id));

    await page.click('button[aria-label^="Delete the policy"]', undefined, 500);
    await page.click('[role=dialog] button', 'Delete', 800);
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the confirmation closed' });
    await page.sleep(500);
    check((await api.get('/accounts/policies')).body.length === 0, 'the policy was deleted');
    policies.length = 0;
  } finally {
    await api.put('/accounts/1/config', { configDir: null }).catch(() => {});
    for (const id of policies) await api.del(`/accounts/policies/${id}`).catch(() => {});
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
    try {
      const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
      db.exec('PRAGMA busy_timeout = 5000');
      const remove = db.prepare('DELETE FROM usage_history WHERE account = ? AND at = ?');
      for (const [account, at] of seeded) remove.run(account, at);
      db.close();
    } catch {
      // the rows are only a chart's input: leaving some behind breaks nothing
    }
    rmSync(bin, { force: true });
    rmSync(resolve(configDir, '..'), { recursive: true, force: true });
    // pages.spec expects the page to say claude-swap is missing, so the wrapper must find that out again
    await api.get('/accounts?refresh=1').catch(() => {});
  }
};
