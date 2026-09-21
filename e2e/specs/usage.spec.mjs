// Usage and export: cost and tokens over time, by project and by model, with a range picker, the
// chart's figures also given as a table (a chart drawn in colour alone fails the accessibility spec),
// and a chat's transcript downloaded as Markdown and as JSON. A chat is laid out on disk the way the
// CLI keeps it and removed afterwards, because the chats spec counts what the sandbox holds.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT = '-work-e2e-usage';
const SESSION = 'e2e-usage-session';
const line = (o) => JSON.stringify(o);

async function noViolations(page, where, check) {
  const found = await page.axe();
  const lines = found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target} ${n.why}`));
  check(lines.length === 0, `${where} has accessibility violations:\n${lines.join('\n')}`);
}

const rows = (page) => page.eval(`return document.querySelectorAll('main .usage-table tbody tr').length`);

export default async ({ page, api, check, dirs }) => {
  const at = new Date().toISOString();
  const projectDir = join(dirs.configDir, 'projects', PROJECT);
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${SESSION}.jsonl`),
      [
        { type: 'user', uuid: 'u1', timestamp: at, cwd: '/work/e2e-usage', version: '2.1.0', message: { role: 'user', content: 'how many tokens did this take' } },
        {
          type: 'assistant',
          uuid: 'u2',
          timestamp: at,
          message: {
            role: 'assistant',
            id: 'msg-usage',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'About fifteen hundred.' }],
            usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      ]
        .map(line)
        .join('\n'),
    );

    await page.reduceMotion();
    await page.goto('/usage', 900);
    await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the chart' });

    // ---------- the figures agree with the API, and are on the page as text ----------
    const series = (await api.get('/usage/series?bucket=day')).body;
    check(series.points.length > 0, 'the API returns a series');
    const tokens = series.points.reduce((sum, p) => sum + p.tokens, 0);
    check(tokens >= 1500, `the seeded chat is in the series (${tokens} tokens)`);

    const chart = await page.eval(`const svg = document.querySelector('main svg[role=img]'); return { label: svg.getAttribute('aria-label'), description: document.getElementById(svg.getAttribute('aria-describedby') ?? '')?.textContent ?? '' }`);
    check(/over time/i.test(chart.label ?? ''), `the chart is named (${chart.label})`);
    check((chart.description ?? '').length > 20, 'the chart is described in words, not only drawn');

    // The default range is 30 days, so the page and this request cover the same days
    const today = new Date();
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from = day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29));
    const range = (await api.get(`/usage/series?bucket=day&from=${from}&to=${day(today)}`)).body;
    const expected = range.points.reduce((sum, p) => sum + p.tokens, 0);
    const tile = await page.eval(`return [...document.querySelectorAll('.usage-tile')].find((t) => t.innerText.includes('TOKENS') || /tokens/i.test(t.innerText))?.querySelector('.usage-tile-value')?.innerText ?? ''`);
    check(tile.replace(/[^\d]/g, '') === String(expected), `the tokens tile shows what the API reports (${tile} vs ${expected})`);
    check((await page.text('main')).includes('server’s time zone'), 'the page says which time zone the days are in');

    // ---------- the table behind the chart ----------
    await page.click('main .collapsible-trigger', 'Show the figures as a table', 500);
    await page.waitFor(`return document.querySelectorAll('main .usage-table tbody tr').length > 0`, { label: 'the table rows' });
    check((await rows(page)) === range.points.length, `the table has one row per day (${await rows(page)} of ${range.points.length})`);
    const headers = await page.eval(`return [...document.querySelectorAll('main .usage-table thead th')].map((th) => th.textContent.trim())`);
    check(headers.join('|') === 'Period|Cost|Tokens|Chats', `the table columns (${headers.join('|')})`);
    await page.shot('usage-dark');

    // ---------- range and grouping ----------
    await page.click('main [role=radio]', '7 days', 700);
    await page.waitFor(`return document.querySelectorAll('main .usage-table tbody tr').length === 7`, { label: 'seven days of rows' });
    await page.click('main [role=radio]', 'Week', 700);
    await page.waitFor(`const n = document.querySelectorAll('main .usage-table tbody tr').length; return n >= 1 && n <= 2`, { label: 'weekly rows' });
    check(/Week of/.test(await page.text('main .usage-table tbody')), 'a week is named by the day it starts');
    await page.click('main [role=radio]', 'Day', 500);

    // A range that cannot be asked for is said to be wrong instead of being sent
    const daysAgo = (n) => day(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
    await page.click('main [role=radio]', 'Custom', 500);
    await page.fill('main .filter-bar label:first-child input', '2026-02-31');
    await page.fill('main .filter-bar label:nth-child(2) input', day(today));
    await page.waitFor(`return document.querySelector('main .filter-bar')?.innerText.includes('YYYY-MM-DD')`, { label: 'the invalid day said out loud' });
    await page.fill('main .filter-bar label:first-child input', daysAgo(4));
    await page.waitFor(`return document.querySelectorAll('main .usage-table tbody tr').length === 5`, { label: 'the custom range applied' });
    await page.fill('main .filter-bar label:first-child input', daysAgo(-2));
    await page.waitFor(`return document.querySelector('main .filter-bar')?.innerText.includes('after the end')`, { label: 'a backwards range said out loud' });
    check((await rows(page)) === 5, 'the last range that could be asked for stays on screen while the next one is wrong');
    await page.click('main [role=radio]', '30 days', 500);

    // ---------- by project and by model ----------
    const breakdown = (await api.get(`/usage/breakdown?from=${from}&to=${day(today)}`)).body;
    check(breakdown.byModel.some((m) => m.key === 'claude-sonnet-5'), 'the model the chat ran is in the breakdown');
    const cards = await page.text('main .usage-slices');
    check(/By project/.test(cards) && /By model/.test(cards), 'both breakdowns are on the page');
    check(cards.includes('claude-sonnet-5'), 'the model is named on the page');
    check(cards.includes('No project'), 'chats under no project are named in words');
    const lists = await page.eval(`return [...document.querySelectorAll('main .slice-list')].map((ul) => ul.getAttribute('aria-label'))`);
    check(lists.length === 2, `each breakdown is a named list (${lists.join(', ')})`);
    // A cost nobody reported reads as such, never as $0.00
    check(/Not reported/.test(cards), 'a terminal chat, which reports tokens only, shows its cost as not reported');

    await page.click('main [role=radio]', 'Tokens', 500);
    const sonnet = breakdown.byModel.find((m) => m.key === 'claude-sonnet-5');
    const shown = sonnet.tokens.toLocaleString('en-US');
    check((await page.text('main .usage-slices')).includes(shown), `the breakdown follows the metric chosen (${shown} tokens for the model)`);

    // ---------- accessibility in both themes ----------
    await noViolations(page, '/usage (dark)', check);
    await page.eval(`localStorage.setItem('agentry-theme', 'light'); return true`);
    await page.goto('/usage', 900);
    await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the chart in the light theme' });
    await noViolations(page, '/usage (light)', check);
    await page.shot('usage-light');
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`);
    await page.viewport(420, 900);
    await page.goto('/usage', 900);
    await page.waitFor(`return !!document.querySelector('main svg[role=img]')`, { label: 'the chart on a phone' });
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    check(overflow <= 1, `/usage scrolls sideways by ${overflow}px at 420px`);
    await page.viewport(1440, 900);

    // ---------- export ----------
    await page.goto(`/chats/${SESSION}`, 1200);
    await page.waitFor(`return !!document.querySelector('main a[href$="format=markdown"]')`, { label: 'the export links' });
    const links = await page.eval(`return [...document.querySelectorAll('main a[download]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() }))`);
    check(links.some((l) => l.text === 'Export Markdown') && links.some((l) => l.text === 'Export JSON'), `both export links are on the chat (${links.map((l) => l.text).join(', ')})`);

    const md = await page.eval(`const r = await fetch(document.querySelector('main a[href$="format=markdown"]').href); return { status: r.status, disposition: r.headers.get('content-disposition'), body: await r.text() }`);
    check(md.status === 200 && /attachment/.test(md.disposition ?? ''), `the Markdown export downloads (${md.status}, ${md.disposition})`);
    check(md.body.includes('how many tokens did this take') && md.body.includes('About fifteen hundred.'), 'the Markdown export holds the conversation');
    const json = await page.eval(`const r = await fetch(document.querySelector('main a[href$="format=json"]').href); return { status: r.status, disposition: r.headers.get('content-disposition'), body: await r.json() }`);
    check(json.status === 200 && /attachment/.test(json.disposition ?? ''), `the JSON export downloads (${json.status})`);
    check(Array.isArray(json.body.entries) && json.body.entries.length >= 2 && json.body.chat?.id === SESSION, 'the JSON export holds the chat and its entries');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); return true`).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
  }
};
