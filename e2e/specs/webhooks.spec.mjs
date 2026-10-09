// Webhooks (code hosts, phase 6): the receiver, Settings → Integrations → Webhooks and the freshness line of a
// change request, through the fake gh and glab (e2e/fake-hosts), in both themes and on a phone.
//
// Reference screens: DesktopIntegracionesWebhooks*, MobileIntegracionesWebhooks* and DSWebhooks. With E2E_SHOTS
// set the screens are saved for comparing them with the reference screenshots.
//
// 1. Agentry has no public address (the tunnel is tailnet-only, so it never is one), so the card says so and
//    offers no action, GitLab's row included.
// 2. With an address (the page's answer to `GET /projects/:id/webhooks` carries one; everything else is the real
//    server and the real fake gh): the row offers Register, its dialog shows the address and the nine events and
//    never a secret, and its one primary button is the screen's only new gradient. The server refuses to register
//    without a public address, and says so before it runs anything on the host.
// 3. A registration written into the database, with its hook in the fake gh: Test pings through the CLI and the
//    row shows the host's answer; a ping the host cannot deliver makes the row failing with the response; Remove
//    asks first, calls DELETE and the row goes off. gh's argv and every answer and screen carry no secret.
// 3b. The same for a GitLab project, through the fake glab: Test makes the host deliver a push and the row shows the
//    answer; Remove asks first and calls DELETE.
// 4. The receiver: an unknown registration, a missing or wrong signature, and a registration the server holds no
//    secret for answer the same empty 401; GitLab's token is checked the same way; an oversized body is 413.
// 5. The freshness line on the item page, from the page's answer to `GET /change-requests/:id`: instant while the
//    hook is healthy, the periodic read otherwise, paused, and "webhook silent" when a registered hook has gone quiet.
//
// Every screen counts all its gradient surfaces (a primary button, a gradient border, gradient text, the FAB; the
// split New chat button counts once) and fails over two. Axe runs on each new surface in both themes, at full contrast.
//
// What is not covered, and why:
// - A delivery signed with the registration's secret. The secret is made when a hook is registered, which needs a
//   public address, and the server reads its secrets file only when it starts, so no spec can give it one. The core
//   suite replays signed deliveries (recorded from gh) against the receiver.
// - Registering end to end through the fake gh, for the same reason: the dialog is driven up to the server's refusal.
//   The fake gh does answer the create call (e2e/fake-hosts/README.md); a direct run of it is checked at the end.
// - The freshness line from the server: `ChangeRequest.freshness` has no producer yet, so the page's answer carries it.
// - An orchestration's freshness line (it shares the component with the item page).
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const timeout = 420_000;

const GH_ORIGIN = 'https://github.com/acme/shop.git';
const GL_ORIGIN = 'https://gitlab.com/acme/shop.git';
const ADDRESS = 'https://e2e0a1b2c3d4.lhr.life';
const HOOK_ID = '9001';
// What the fake gh was given on stdin: a spec reads it to prove it never reaches a screen, an answer or argv
const SECRET = '5e3c0b7a91d44f6e8a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f';
const GL_HOOK_ID = '7001';
const GL_EVENTS = ['merge_requests_events', 'pipeline_events', 'note_events', 'issues_events'];
const EVENTS = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'pull_request_review_thread', 'check_run', 'check_suite', 'workflow_run', 'issue_comment', 'issues'];
const PHONE = [390, 844];
const STORE = 'e2e-webhooks';
const overflow = `return document.documentElement.scrollWidth - innerWidth`;

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

async function scan(page, check, label) {
  await page.reduceMotion(true);
  const violations = await page.axe();
  check(violations.length === 0, `axe on ${label}: ${JSON.stringify(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })))}`);
}

/**
 * Stands between the app and two answers of the real server, and changes only what the sandbox cannot produce: the
 * public address of `GET /projects/:id/webhooks` (and with it `available`), and `freshness` on `GET /change-requests/:id`.
 * What it adds is read from sessionStorage at each call, so a spec changes it between page loads.
 */
const overlay = `(() => {
  const real = window.fetch.bind(window);
  const config = () => { try { return JSON.parse(sessionStorage.getItem('${STORE}') ?? '{}'); } catch { return {}; } };
  window.fetch = async (input, init) => {
    const res = await real(input, init);
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET').toUpperCase();
    if (method !== 'GET' || !res.ok) return res;
    const parts = url.pathname.split('/');
    const cfg = config();
    const reply = (body) => new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
    if (cfg.address && parts.length === 5 && parts[1] === 'api' && parts[2] === 'projects' && parts[4] === 'webhooks') {
      const body = await res.clone().json();
      if (body.reason === 'no-public-url') return reply({ ...body, available: true, reason: null, publicUrl: cfg.address });
      return reply({ ...body, publicUrl: cfg.address });
    }
    if (cfg.freshness && parts.length === 4 && parts[1] === 'api' && parts[2] === 'change-requests') {
      const body = await res.clone().json();
      const f = cfg.freshness;
      const at = (ms) => (ms === null ? null : new Date(Date.now() + ms).toISOString());
      return reply({ ...body, freshness: { checkedAt: at(-f.checkedAgoMs), nextCheckAt: at(f.nextInMs), source: f.source } });
    }
    return res;
  };
})();`;

export default async ({ page, api, check, dirs }) => {
  const stateDir = join(dirs.dataDir, 'fake-hosts');
  const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fake-hosts');
  const ghRoot = join(dirs.workspaceDir, 'e2e-webhooks-gh');
  const glRoot = join(dirs.workspaceDir, 'e2e-webhooks-gl');
  const projects = [];
  let removeOverlay = null;
  const state = (name, value) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${name}.json`), JSON.stringify(value));
  };
  const ghCalls = () => {
    try {
      return readFileSync(join(stateDir, 'gh.calls'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const glCalls = () => {
    try {
      return readFileSync(join(stateDir, 'glab.calls'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const glRegistrationId = randomUUID();
  const hookFile = join(stateDir, `gh.hook-${HOOK_ID}`);
  const writeHook = (response) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(hookFile, `${ADDRESS}/api/webhooks/github/${registrationId}\n${response}\n`);
    writeFileSync(`${hookFile}.secret`, `${SECRET}\n`);
  };
  const resetFakes = () => {
    try {
      for (const file of readdirSync(stateDir)) if (/^(gh|glab)\.(hook|calls|json|next|created)/.test(file) || file === 'gh.hookseq' || file === 'glab.json' || file === 'glab.hookseq' || file === 'glab.eventseq') rmSync(join(stateDir, file), { force: true });
    } catch {
      // nothing was written
    }
  };
  const repository = (root, origin) => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'e2e@example.com');
    git(root, 'config', 'user.name', 'e2e');
    writeFileSync(join(root, 'README.md'), '# shop\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'first commit');
    git(root, 'remote', 'add', 'origin', origin);
  };
  const setTheme = (name) => page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`);
  const config = (value) => page.eval(`sessionStorage.setItem('${STORE}', ${JSON.stringify(JSON.stringify(value))}); return true`);
  const text = (selector) => page.eval(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  // Every gradient surface of the screen, whatever draws it. The split New chat button is one surface drawn as two buttons.
  const gradients = () =>
    page.eval(
      `// With a dialog open, the page behind it is dimmed and inert: what the person sees lit is the dialog's
       const root = document.querySelector('[role=dialog]') ?? document;
       const seen = new Set();
       const list = [];
       // A surface the person cannot see (the phone's FAB on a desktop, hidden by CSS) is not drawn: it does not count
       const add = (el, kind) => {
         if (seen.has(el) || getComputedStyle(el).display === 'none' || el.getClientRects().length === 0) return;
         seen.add(el);
         list.push({ kind, text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40) });
       };
       for (const b of root.querySelectorAll('.btn-primary')) add(b.closest('.split-btn') ?? b, 'button');
       for (const el of root.querySelectorAll('.grad-border')) add(el, 'border');
       for (const el of root.querySelectorAll('.grad-text')) if (!el.closest('.grad-border')) add(el, 'text');
       for (const el of root.querySelectorAll('.fab')) add(el, 'fab');
       return list`,
    );
  const atMostTwo = async (label) => {
    const every = await gradients();
    check(every.length <= 2, `${label}: at most two gradient surfaces (${JSON.stringify(every)})`);
    return every;
  };
  // A secret never reaches a screen: neither the one the fake gh was given nor anything shaped like one (32 bytes of hex)
  const noSecret = async (label) => {
    const page_ = await page.eval(`return document.body.innerHTML + '\\n' + document.body.innerText`);
    check(!page_.includes(SECRET) && !/\b[0-9a-f]{64}\b/.test(page_), `${label}: no secret on the screen`);
  };
  const press = (scope, label) =>
    page.eval(`const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) throw new Error('no ${label} button in ${scope}'); b.click(); return true`);
  const closeDialog = async () => {
    await page.key('Escape');
    await page.waitFor(`return !document.querySelector('[role=dialog]')`, { label: 'the dialog closes' });
  };
  const rowOf = (id) => `.wh-card [data-project="${id}"]`;
  const kindIs = (id, kind) => `return document.querySelector(${JSON.stringify(rowOf(id))})?.getAttribute('data-kind') === ${JSON.stringify(kind)}`;
  /**
   * Presses a row's action once it can be pressed, as a person would. The row's buttons stay disabled
   * until the last test's refresh of the list has landed, which comes after its toast: a click before
   * then does nothing, and on a busy machine the toast came a whole read ahead of the button.
   */
  const act = async (id, action, wait) => {
    const selector = `${rowOf(id)} [data-action="${action}"]`;
    await page.waitFor(`const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return false;el.scrollIntoView({block:'center'});el.click();return true`, {
      label: `${action} on the row, once it can be pressed`,
    });
    await page.sleep(wait);
  };
  const actionsOf = (id) => page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${rowOf(id)} [data-action]`)})].map((a) => a.getAttribute('data-action'))`);
  const openIntegrations = async (id, kind, label) => {
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(`return document.querySelectorAll('.wh-card [data-project]').length === 2`, { label: `${label}: a row per project` });
    await page.waitFor(kindIs(id, kind), { label: `${label}: the GitHub row is ${kind}` });
  };
  const everyScreen = async (name, label) => {
    await atMostTwo(label);
    await noSecret(label);
    await page.shot(name);
    await scan(page, check, label);
  };
  const toastText = () => page.eval(`return [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);

  const registrationId = randomUUID();
  const dbRun = (sql, ...params) => {
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    try {
      return db.prepare(sql).run(...params);
    } finally {
      db.close();
    }
  };

  try {
    // ---- Two projects: a GitHub repository and a GitLab one ----
    repository(ghRoot, GH_ORIGIN);
    repository(glRoot, GL_ORIGIN);
    // The watcher asks the fake about every open change request while the spec runs and writes back what it answers
    state('gh', { ci: 'passing' });
    state('glab', {});
    await api.post('/hosts/refresh');
    const gh = await api.post('/projects/import', { path: ghRoot, name: 'e2e-webhooks-gh', template: 'software' });
    const gl = await api.post('/projects/import', { path: glRoot, name: 'e2e-webhooks-gl', template: 'software' });
    check(gh.status === 201 && gl.status === 201, `both projects were imported (${gh.status}, ${gl.status})`);
    const ghId = gh.body.id;
    const glId = gl.body.id;
    projects.push(ghId, glId);

    // ---- What the API says without a tunnel ----
    const bare = (await api.get(`/projects/${ghId}/webhooks`)).body;
    check(bare.available === false && bare.reason === 'no-public-url' && bare.publicUrl === null, `no tunnel: no address (${JSON.stringify(bare)})`);
    check(JSON.stringify(bare.events) === JSON.stringify(EVENTS) && bare.canRedeliver === false && bare.registrations.length === 0, `nine events, no redelivery, nothing registered (${JSON.stringify(bare)})`);
    const lab = (await api.get(`/projects/${glId}/webhooks`)).body;
    check(lab.available === false && lab.reason === 'no-public-url' && JSON.stringify(lab.events) === JSON.stringify(GL_EVENTS) && lab.canRedeliver === false, `no tunnel: GitLab has no address either, and its own four events (${JSON.stringify(lab)})`);

    // ---- 1. No public address ----
    await page.goto('/', 300);
    await setTheme('dark');
    removeOverlay = await page.onNewDocument(overlay);
    await config({});
    await openIntegrations(ghId, 'unavailable', 'no address, dark');
    await page.waitFor(kindIs(glId, 'unavailable'), { label: 'the GitLab row' });
    check(/tailnet/.test(await text('.wh-card .wh-notice')), 'with no address the card says the tunnel only reaches the tailnet');
    check(!(await page.eval(`return !!document.querySelector('.wh-card .wh-bar')`)), 'and shows no address line');
    check((await actionsOf(ghId)).length === 0, 'a project with no address to register on offers no action');
    check((await actionsOf(glId)).length === 0, 'a GitLab row with no address offers no action either');
    const gitlabRow = await text(rowOf(glId));
    check(/Meanwhile Agentry reads the pull requests every 2 min/.test(gitlabRow) && !/Not available yet/.test(gitlabRow), `a GitLab row says the same as a GitHub one (${gitlabRow})`);
    check(/Meanwhile Agentry reads the pull requests every 2 min/.test(await text(rowOf(ghId))), `the row says how the pull requests are read meanwhile (${await text(rowOf(ghId))})`);
    check(!/redeliver/i.test(await text('.wh-card')), 'there is no redelivery');
    await everyScreen('webhooks-no-address-dark', 'Webhooks without an address, dark');
    await setTheme('light');
    await openIntegrations(ghId, 'unavailable', 'no address, light');
    await everyScreen('webhooks-no-address-light', 'Webhooks without an address, light');
    await setTheme('dark');

    // ---- 2. An address: the row offers Register, and the dialog says what it will do ----
    await config({ address: ADDRESS });
    await openIntegrations(ghId, 'off', 'with an address, dark');
    check((await actionsOf(ghId)).join(',') === 'register', `an unregistered project offers Register and nothing else (${(await actionsOf(ghId)).join(',')})`);
    check((await text('.wh-card .wh-bar')).includes(ADDRESS) && /Open/.test(await text('.wh-card .wh-bar')), 'the card says where notices arrive, and that it is open');
    check((await actionsOf(glId)).join(',') === 'register', `a GitLab project offers Register too (${(await actionsOf(glId)).join(',')})`);
    check(/Without a webhook, Agentry reads the pull requests every 2 min/.test(await text(rowOf(ghId))), 'an off row says what a webhook is for');
    await everyScreen('webhooks-off-dark', 'Webhooks with an address, dark');
    await setTheme('light');
    await openIntegrations(ghId, 'off', 'with an address, light');
    await everyScreen('webhooks-off-light', 'Webhooks with an address, light');
    await setTheme('dark');
    await page.goto('/settings?tab=integrations', 300);
    await page.waitFor(kindIs(ghId, 'off'), { label: 'the row, off' });

    const callsBefore = ghCalls().length;
    await page.click(`${rowOf(ghId)} [data-action="register"]`, undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .wh-dlg')`, { label: 'the Register dialog' });
    const dialogText = await page.text('[role=dialog]');
    check(dialogText.includes(`${ADDRESS}/api/webhooks/github/`), `the dialog shows the address before anything happens (${dialogText.slice(0, 200)})`);
    const events = await page.eval(`return [...document.querySelectorAll('[role=dialog] .wh-events li .mono')].map((e) => e.textContent)`);
    check(JSON.stringify(events) === JSON.stringify(EVENTS), `and the nine events (${events.join(',')})`);
    check(/32-byte secret/.test(dialogText) && /never shown/i.test(dialogText), 'it says the secret is made, kept and never shown');
    check(/sooner/i.test(dialogText), 'it says a webhook only makes Agentry read sooner');
    check(!(await page.eval(`return !!document.querySelector('[role=dialog] input, [role=dialog] textarea, [role=dialog] [data-copy]')`)), 'the dialog has no field to type or copy a secret in');
    const own = await page.eval(`return [...document.querySelectorAll('[role=dialog] .btn-primary')].map((b) => b.textContent.trim())`);
    check(own.length === 1 && own[0] === 'Register webhook', `Register is the dialog's one gradient action (${JSON.stringify(own)})`);
    check((await gradients()).length === 1, `and the dialog has one gradient surface (${JSON.stringify(await gradients())})`);
    await everyScreen('webhooks-register-dark', 'the Register dialog, dark');
    // The server refuses to register without a tunnel, before it runs anything on the host
    await press('[role=dialog]', 'Register webhook');
    await page.waitFor(`return !!document.querySelector('[role=dialog] [role=alert]')`, { label: 'the server refuses without a tunnel' });
    const refused = await page.text('[role=dialog] [role=alert]');
    check(/public address/i.test(refused) && /could not register/i.test(refused), `the refusal is said in the dialog (${refused})`);
    check(await page.eval(`return [...document.querySelectorAll('[role=dialog] .btn-primary')].some((b) => b.textContent.trim() === 'Try again')`), 'and the button reads Try again');
    check(ghCalls().length === callsBefore, `nothing was run on the host (${ghCalls().slice(callsBefore).join(' / ')})`);
    check((await api.get(`/projects/${ghId}/webhooks`)).body.registrations.length === 0, 'and nothing was registered');
    await noSecret('the refused dialog');
    await closeDialog();
    await setTheme('light');
    await openIntegrations(ghId, 'off', 'dialog, light');
    await page.click(`${rowOf(ghId)} [data-action="register"]`, undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .wh-dlg')`, { label: 'the Register dialog, light' });
    await everyScreen('webhooks-register-light', 'the Register dialog, light');
    await closeDialog();
    await setTheme('dark');

    // ---- 3. A registered hook: the fake gh holds it, the database registers it ----
    const now = new Date().toISOString();
    writeHook('null unused');
    dbRun(
      `INSERT INTO webhook_registrations (id, project_id, host, hostname, repo_path, remote_hook_id, url, events, state, last_delivery_at, last_ping_at, last_response, created_at, updated_at)
       VALUES (?, ?, 'github', 'github.com', 'acme/shop', ?, ?, ?, 'active', NULL, ?, ?, ?, ?)`,
      registrationId,
      ghId,
      HOOK_ID,
      `${ADDRESS}/api/webhooks/github/${registrationId}`,
      JSON.stringify(EVENTS),
      now,
      JSON.stringify({ code: 204, status: 'active' }),
      now,
      now,
    );
    const listed = (await api.get(`/projects/${ghId}/webhooks`)).body;
    check(listed.registrations.length === 1 && listed.registrations[0].remoteHookId === HOOK_ID, `the registration is listed (${JSON.stringify(listed.registrations)})`);
    check(!JSON.stringify(listed).includes(SECRET) && !/"secret"/i.test(JSON.stringify(listed)), 'and the API carries no secret');

    await openIntegrations(ghId, 'active', 'registered, dark');
    check((await actionsOf(ghId)).join(',') === 'test,remove', `a registered project offers Test and Remove, never Register or redelivery (${(await actionsOf(ghId)).join(',')})`);
    const active = await text(rowOf(ghId));
    check(/Active/.test(active) && /last test/i.test(active) && /backup read/i.test(active), `an active row says its state, its last test and its backup read (${active})`);
    check((await text('.wh-card .wh-bar')).includes(ADDRESS), 'the address line is shown');
    check(/1 project/.test(await text('.wh-card .prov-summary')) || /2 projects · 1 with a webhook/.test(await text('.wh-card .prov-summary')), `the summary counts the hook (${await text('.wh-card .prov-summary')})`);
    await everyScreen('webhooks-active-dark', 'an active webhook, dark');
    await setTheme('light');
    await openIntegrations(ghId, 'active', 'registered, light');
    await everyScreen('webhooks-active-light', 'an active webhook, light');
    await setTheme('dark');
    await openIntegrations(ghId, 'active', 'registered, dark again');

    // Test: the CLI pings the hook and reads what the host says about the delivery
    const beforeTest = ghCalls().length;
    await act(ghId, 'test', 300);
    await page.waitFor(`return /answered the test with 204/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '))`, { timeout: 30_000, label: 'the host answered the test' });
    const testCalls = ghCalls().slice(beforeTest);
    check(testCalls.some((c) => c.includes(`-X POST repos/acme/shop/hooks/${HOOK_ID}/pings`)), `Test pings the hook through the CLI (${testCalls.join(' / ')})`);
    check(testCalls.every((c) => !c.includes(SECRET)), 'and no call carries the secret');
    const tested = (await api.get(`/projects/${ghId}/webhooks`)).body.registrations[0];
    check(tested.state === 'active' && tested.lastResponse?.code === 204, `the registration keeps what the host said (${JSON.stringify(tested.lastResponse)})`);
    await noSecret('after Test');

    // A hook the host cannot deliver to: the row says so, with the host's response
    state('gh', { ci: 'passing', hookPing: 'fail' });
    await act(ghId, 'test', 300);
    await page.waitFor(`return /Could not test the webhook/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '))`, { timeout: 30_000, label: 'the failed test is said' });
    await page.waitFor(kindIs(ghId, 'failing'), { label: 'the row is failing' });
    const failing = await text(rowOf(ghId));
    check(/Failing/.test(failing) && /502/.test(failing) && /last response/i.test(failing), `a failing row says the host's last response (${failing})`);
    check(/cannot deliver/.test(failing), 'and what it means');
    check((await actionsOf(ghId)).join(',') === 'test,remove', 'a failing row still offers Test and Remove');
    await everyScreen('webhooks-failing-dark', 'a failing webhook, dark');
    await setTheme('light');
    await openIntegrations(ghId, 'failing', 'failing, light');
    await everyScreen('webhooks-failing-light', 'a failing webhook, light');
    await setTheme('dark');
    // It recovers when the next test is answered
    state('gh', { ci: 'passing' });
    await openIntegrations(ghId, 'failing', 'failing, recovering');
    await act(ghId, 'test', 300);
    await page.waitFor(kindIs(ghId, 'active'), { timeout: 30_000, label: 'a test the host answers makes it active again' });

    // ---- 3b. A GitLab hook: the fake glab holds it, the database registers it ----
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `glab.hook-${GL_HOOK_ID}`), `${ADDRESS}/api/webhooks/gitlab/${glRegistrationId}\n\n`);
    writeFileSync(join(stateDir, `glab.hook-${GL_HOOK_ID}.secret`), `${SECRET}\n`);
    dbRun(
      `INSERT INTO webhook_registrations (id, project_id, host, hostname, repo_path, remote_hook_id, url, events, state, last_delivery_at, last_ping_at, last_response, created_at, updated_at)
       VALUES (?, ?, 'gitlab', 'gitlab.com', 'acme/shop', ?, ?, ?, 'active', NULL, NULL, NULL, ?, ?)`,
      glRegistrationId,
      glId,
      GL_HOOK_ID,
      `${ADDRESS}/api/webhooks/gitlab/${glRegistrationId}`,
      JSON.stringify(GL_EVENTS),
      now,
      now,
    );
    await openIntegrations(ghId, 'active', 'GitLab registered, dark');
    await page.waitFor(kindIs(glId, 'active'), { label: 'the GitLab row is active' });
    check((await actionsOf(glId)).join(',') === 'test,remove', `a registered GitLab project offers Test and Remove (${(await actionsOf(glId)).join(',')})`);
    await everyScreen('webhooks-gitlab-active-dark', 'a GitLab webhook, dark');
    const beforeGlTest = glCalls().length;
    await act(glId, 'test', 300);
    await page.waitFor(`return /GitLab answered the test with 204/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' '))`, { timeout: 30_000, label: 'GitLab answered the test' });
    const glTest = glCalls().slice(beforeGlTest);
    check(glTest.some((c) => c.includes(`-X POST projects/4242/hooks/${GL_HOOK_ID}/test/push_events`)), `Test asks GitLab for a push test through glab (${glTest.join(' / ')})`);
    check(glTest.every((c) => !c.includes(SECRET)), 'and no glab call carries the token');
    const glTested = (await api.get(`/projects/${glId}/webhooks`)).body.registrations[0];
    check(glTested.state === 'active' && glTested.lastResponse?.code === 204 && glTested.lastPingAt !== null, `the registration keeps what GitLab said (${JSON.stringify(glTested)})`);
    await noSecret('after the GitLab test');
    // A hook GitLab cannot deliver to: the newest event says so
    state('glab', { hookPing: 'fail' });
    await act(glId, 'test', 300);
    await page.waitFor(kindIs(glId, 'failing'), { timeout: 30_000, label: 'the GitLab row is failing' });
    state('glab', {});
    await openIntegrations(ghId, 'active', 'GitLab failing, recovering');
    await act(glId, 'test', 300);
    await page.waitFor(kindIs(glId, 'active'), { timeout: 30_000, label: 'a test GitLab answers makes it active again' });
    // Remove: asks first, deletes the hook through glab
    await act(glId, 'remove', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the GitLab removal asks first' });
    check(glCalls().every((c) => !c.includes('-X DELETE')), 'nothing was deleted on GitLab before the person confirmed');
    await press('[role=dialog]', 'Remove webhook');
    await page.waitFor(kindIs(glId, 'off'), { timeout: 30_000, label: 'the GitLab row goes off' });
    check(glCalls().some((c) => c.includes(`-X DELETE projects/4242/hooks/${GL_HOOK_ID}`)), 'Remove deletes the hook on GitLab through glab');
    check(!readdirSync(stateDir).some((f) => f.startsWith(`glab.hook-${GL_HOOK_ID}`)), 'and the hook is gone from the host');

    // ---- A phone ----
    await page.viewport(...PHONE);
    await openIntegrations(ghId, 'active', 'phone, dark');
    check(await page.eval(`return document.querySelectorAll('.wh-card .prov-cell').length === 2 && !document.querySelector('.wh-card .prov-row')`), 'a phone shows cells, not rows');
    check((await page.eval(overflow)) <= 0, 'the phone page does not scroll sideways');
    const small = await page.eval(`return [...document.querySelectorAll('.wh-card .btn')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim())`);
    check(small.length === 0, `the phone targets are at least 44 px (${small.join(', ')})`);
    check(!(await page.eval(`return !!document.querySelector('.wh-card input[type=checkbox]')`)), 'no checkbox on a phone');
    await everyScreen('webhooks-phone-dark', 'Webhooks on a phone, dark');
    await setTheme('light');
    await openIntegrations(ghId, 'active', 'phone, light');
    await everyScreen('webhooks-phone-light', 'Webhooks on a phone, light');
    await setTheme('dark');
    // The Register dialog on a phone, from a project that is off for a moment
    dbRun("UPDATE webhook_registrations SET state = 'removed' WHERE id = ?", registrationId);
    await openIntegrations(ghId, 'off', 'phone, off');
    await page.click(`${rowOf(ghId)} [data-action="register"]`, undefined, 500);
    await page.waitFor(`return !!document.querySelector('[role=dialog] .wh-dlg')`, { label: 'the Register dialog on a phone' });
    check((await page.eval(overflow)) <= 0, 'the phone dialog does not scroll the page sideways');
    check((await gradients()).length === 1, 'the phone dialog has one gradient surface');
    const primary = await page.eval(`const b = document.querySelector('[role=dialog] .btn-primary'); return b ? b.getBoundingClientRect().height : 0`);
    check(primary >= 44, `Register is a 44 px target on a phone (${primary})`);
    await everyScreen('webhooks-phone-register-dark', 'the Register dialog on a phone, dark');
    await closeDialog();
    dbRun("UPDATE webhook_registrations SET state = 'active' WHERE id = ?", registrationId);
    await page.viewport(1440, 900);

    // ---- 4. The receiver ----
    const base = `${api.baseUrl}/api/webhooks`;
    const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: Number(HOOK_ID) });
    // What a host would send, signed with a key the server does not hold: nothing here is the real secret
    const signed = (key) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
    const deliver = async (path, headers, payload = body) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': randomUUID(), ...headers }, body: payload });
      return { status: res.status, body: await res.text(), retry: res.headers.get('retry-after') };
    };
    const unknown = await deliver(`/github/${randomUUID()}`, { 'x-hub-signature-256': signed('anything') });
    check(unknown.status === 401 && unknown.body === '', `an unknown registration is an empty 401 (${JSON.stringify(unknown)})`);
    const wrong = await deliver(`/github/${registrationId}`, { 'x-hub-signature-256': signed('not-the-secret') });
    check(wrong.status === 401 && wrong.body === '', `a wrong signature is the same empty 401 (${JSON.stringify(wrong)})`);
    const missing = await deliver(`/github/${registrationId}`, {});
    check(missing.status === 401 && missing.body === '', `a missing signature is the same (${JSON.stringify(missing)})`);
    const malformed = await deliver(`/github/${registrationId}`, { 'x-hub-signature-256': 'sha256=zz' });
    check(malformed.status === 401 && malformed.body === '', `a malformed signature is the same (${JSON.stringify(malformed)})`);
    // The server holds no secret for this registration (it only reads its secrets when it starts): it refuses, whatever is signed
    const keyless = await deliver(`/github/${registrationId}`, { 'x-hub-signature-256': signed(SECRET) });
    check(keyless.status === 401 && keyless.body === '', `a registration with no stored secret refuses every delivery (${JSON.stringify(keyless)})`);
    const otherHost = await deliver(`/gitlab/${registrationId}`, { 'x-gitlab-token': 'wrong', 'x-gitlab-event': 'Merge Request Hook' });
    check(otherHost.status === 401 && otherHost.body === '', `GitLab's token is checked the same way, and a GitHub registration is not GitLab's (${JSON.stringify(otherHost)})`);
    const huge = await deliver(`/github/${registrationId}`, { 'x-hub-signature-256': signed('anything') }, 'x'.repeat(5 * 1024 * 1024 + 1024));
    // A registration the server holds no secret for is refused before its body is read, so an oversize body costs nothing;
    // the 413 for a registration with a secret is in apps/api/test/webhooks.test.ts
    check(huge.status === 401 && huge.body === '', `an oversize body for a registration with no secret is refused before it is read (${huge.status})`);
    check(!(await fetch(`${base}/github/${registrationId}`)).ok, 'a GET is not a receiver');
    const afterReceiver = (await api.get(`/projects/${ghId}/webhooks`)).body.registrations[0];
    check(afterReceiver.state === 'active' && afterReceiver.lastDeliveryAt === null, `a refused delivery changes nothing (${JSON.stringify({ state: afterReceiver.state, lastDeliveryAt: afterReceiver.lastDeliveryAt })})`);

    // ---- 5. The freshness line of a change request ----
    const made = await api.post(`/projects/${ghId}/work-items`, { title: 'Pull request with a webhook', acceptanceCriteria: [{ text: 'It works' }] });
    await api.post(`/work-items/${made.body.id}/move`, { status: 'in_review' });
    const item = made.body;
    const prId = randomUUID();
    dbRun(
      `INSERT INTO work_item_pull_requests (id, item_id, project_id, phase, number, url, branch, base, ci, conflicts, error_code, error_detail, approved_at, opened_at, closed_at, checked_at, created_at, updated_at, host, hostname)
       VALUES (?, ?, ?, 'open', 21, 'https://github.com/acme/shop/pull/21', ?, 'main', 'passing', '[]', NULL, NULL, ?, ?, NULL, ?, ?, ?, 'github', 'github.com')`,
      prId,
      item.id,
      ghId,
      `task/${item.key.toLowerCase()}`,
      now,
      now,
      now,
      now,
      now,
    );
    dbRun("UPDATE work_items SET waiting = 'merge' WHERE id = ?", item.id);
    const fresh = async (kind, label) => {
      await page.goto(`/tasks/${item.key}`, 300);
      await page.waitFor(`return document.querySelector('.item-pr-wait .fresh')?.getAttribute('data-fresh') === ${JSON.stringify(kind)}`, { timeout: 30_000, label: `${label}: the line says ${kind}` });
    };
    const line = () => text('.item-pr-wait .fresh');
    // Nothing on the line moves while it is not reading: no animation, no spinner
    const still = async (label) => {
      const moving = await page.eval(
        `return [...document.querySelectorAll('.item-pr-wait .fresh, .item-pr-wait .fresh *')].filter((el) => getComputedStyle(el).animationName !== 'none' || el.matches('.spinner, [class*=spin]')).map((el) => el.className)`,
      );
      check(moving.length === 0, `${label}: nothing on the line moves (${moving.join(', ')})`);
    };

    // The hook is healthy (its last test is recent) and the last read came from a delivery
    await config({ freshness: { checkedAgoMs: 40_000, nextInMs: 14 * 60_000, source: 'webhook' } });
    await fresh('instant', 'a healthy hook');
    const instant = await line();
    check(/Instant/.test(instant) && /By webhook/.test(instant) && /last notice/.test(instant), `a healthy hook with a webhook read says Instant and by webhook (${instant})`);
    check(/only makes Agentry read sooner/.test(instant), `and says a webhook only makes Agentry read sooner (${instant})`);
    check(await page.eval(`return !!document.querySelector('.item-pr-wait .fresh .badge-ok')`), 'Instant is ok-coloured, with its word');
    check(await page.eval(`return !!document.querySelector('.item-pr-wait .fresh button')`), 'and the person can Refresh');
    await still('instant');
    await everyScreen('webhooks-fresh-instant-dark', 'the freshness line, instant, dark');
    await setTheme('light');
    await fresh('instant', 'instant, light');
    await everyScreen('webhooks-fresh-instant-light', 'the freshness line, instant, light');
    await setTheme('dark');

    // A poll read: the periodic read in words, and never "Instant"
    await config({ freshness: { checkedAgoMs: 95_000, nextInMs: 25_000, source: 'poll' } });
    await fresh('checked', 'a poll read');
    const polled = await line();
    check(/Checked/.test(polled) && /next in/.test(polled) && !/Instant/.test(polled), `a poll read says when it was read and when it is next, not Instant (${polled})`);
    await still('checked');

    // Reads paused: a last read and no next one
    await config({ freshness: { checkedAgoMs: 5 * 60_000, nextInMs: null, source: 'poll' } });
    await fresh('paused', 'paused');
    check(/Paused/.test(await line()) && /Refresh still works/.test(await line()) && (await page.eval(`return !!document.querySelector('.item-pr-wait .fresh .badge-warn')`)), 'paused says so, with a warn badge and a word');
    await still('paused');

    // The hook has gone quiet: a delivery said so, but the last test is two hours old
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    dbRun('UPDATE webhook_registrations SET last_ping_at = ?, last_delivery_at = NULL WHERE id = ?', old, registrationId);
    await config({ freshness: { checkedAgoMs: 60_000, nextInMs: 90_000, source: 'webhook' } });
    await fresh('silent', 'a silent hook');
    const silent = await line();
    check(/Webhook silent/.test(silent) && !/Instant/.test(silent) && /Meanwhile GitHub is read at the normal pace/.test(silent), `a registered hook that is silent says so and falls back to the normal pace (${silent})`);
    check(await page.eval(`return !!document.querySelector('.item-pr-wait .fresh a[href="/settings?tab=integrations"]')`), 'and links to the webhooks');
    await still('silent');
    await everyScreen('webhooks-fresh-silent-dark', 'the freshness line, silent, dark');
    await setTheme('light');
    await fresh('silent', 'silent, light');
    await everyScreen('webhooks-fresh-silent-light', 'the freshness line, silent, light');
    await setTheme('dark');

    // On a phone the line leads the detail, under the PR panel
    await page.viewport(...PHONE);
    dbRun('UPDATE webhook_registrations SET last_ping_at = ? WHERE id = ?', new Date().toISOString(), registrationId);
    await config({ freshness: { checkedAgoMs: 40_000, nextInMs: 14 * 60_000, source: 'webhook' } });
    await fresh('instant', 'on a phone');
    check((await page.eval(overflow)) <= 0, 'the item does not scroll sideways on a phone');
    const refresh = await page.eval(`const b = document.querySelector('.item-pr-wait .fresh button'); return b ? b.getBoundingClientRect().height : 0`);
    check(refresh >= 44, `Refresh is a 44 px target on a phone (${refresh})`);
    await everyScreen('webhooks-fresh-phone-dark', 'the freshness line on a phone, dark');
    await setTheme('light');
    await fresh('instant', 'phone, light');
    await everyScreen('webhooks-fresh-phone-light', 'the freshness line on a phone, light');
    await setTheme('dark');
    await page.viewport(1440, 900);

    // ---- Remove: asks first, deletes the hook on the host, and the row goes off ----
    await config({ address: ADDRESS });
    await openIntegrations(ghId, 'active', 'before removing');
    await act(ghId, 'remove', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the removal asks first' });
    const ask = await page.text('[role=dialog]');
    check(/Remove the webhook of e2e-webhooks-gh/.test(ask) && /acme\/shop/.test(ask) && /register it again/.test(ask), `the removal names the project, the repository and the way back (${ask})`);
    check(ghCalls().every((c) => !c.includes('-X DELETE')), 'nothing was deleted before the person confirmed');
    check(await page.eval(`return [...document.querySelectorAll('[role=dialog] .btn-danger-solid')].some((b) => b.textContent.trim() === 'Remove webhook')`), 'the confirmation is a destructive button that says what it does');
    check((await gradients()).length === 0, 'and carries no gradient');
    await scan(page, check, 'the removal dialog, dark');
    await closeDialog();
    check(ghCalls().every((c) => !c.includes('-X DELETE')), 'cancelling deletes nothing');
    await act(ghId, 'remove', 400);
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the removal asks again' });
    await press('[role=dialog]', 'Remove webhook');
    await page.waitFor(kindIs(ghId, 'off'), { timeout: 30_000, label: 'the row goes off' });
    check(ghCalls().some((c) => c.includes(`-X DELETE repos/acme/shop/hooks/${HOOK_ID}`)), 'Remove deletes the hook on the host through the CLI');
    check(!readdirSync(stateDir).includes(`gh.hook-${HOOK_ID}`), 'and the host no longer has it');
    check(/Webhook removed/.test(await toastText()), 'the removal is said');
    check((await actionsOf(ghId)).join(',') === 'register', 'a removed project offers Register again');
    await noSecret('after removing');
    const gone = (await api.get(`/projects/${ghId}/webhooks`)).body.registrations;
    check(gone.length === 1 && gone[0].state === 'removed', `the registration is kept as removed (${JSON.stringify(gone.map((r) => r.state))})`);
    // A removed registration refuses deliveries like an unknown one
    check((await deliver(`/github/${registrationId}`, { 'x-hub-signature-256': signed('anything') })).status === 401, 'a removed registration refuses deliveries');
    // Without a hook the same read is a poll read: a removed hook never says Instant
    await config({ freshness: { checkedAgoMs: 40_000, nextInMs: 90_000, source: 'webhook' } });
    await fresh('checked', 'a removed hook');
    check(!/Instant/.test(await line()) && !(await page.eval(`return !!document.querySelector('.item-pr-wait .fresh .badge-warn')`)), `with no hook the line is a plain poll read, neither Instant nor "silent" (${await line()})`);

    // ---- The fake gh answers the create call as the host does: the secret is on stdin, and masked in the answer ----
    const probe = spawnSync(join(fakes, 'gh'), ['api', '--hostname', 'github.com', '-X', 'POST', 'repos/acme/shop/hooks', '--input', '-'], {
      input: JSON.stringify({ name: 'web', active: true, events: EVENTS, config: { url: `${ADDRESS}/api/webhooks/github/probe`, content_type: 'json', secret: SECRET, insecure_ssl: '0' } }),
      env: { ...process.env, AGENTRY_DATA_DIR: dirs.dataDir },
      encoding: 'utf8',
    });
    const created = JSON.parse(probe.stdout);
    check(probe.status === 0 && created.config.secret === '********' && !probe.stdout.includes(SECRET), `the fake gh masks the secret it was given (${probe.stdout.slice(0, 120)})`);
    check(readFileSync(join(stateDir, `gh.hook-${created.id}.secret`), 'utf8').trim() === SECRET, 'and keeps it where only a spec reads it');
    check(ghCalls().every((c) => !c.includes(SECRET)), 'no call of the whole run carried the secret in its arguments');
  } finally {
    await page.reduceMotion(false).catch(() => {});
    await page.viewport(1440, 900).catch(() => {});
    await page.eval(`localStorage.removeItem('agentry-theme'); sessionStorage.removeItem('${STORE}'); return true`).catch(() => {});
    if (removeOverlay) await removeOverlay().catch(() => {});
    for (const id of projects) {
      await api.del(`/projects/${id}`).catch(() => {});
      try {
        dbRun('DELETE FROM webhook_registrations WHERE project_id = ?', id);
      } catch {
        // the database is already closed to us
      }
    }
    try {
      dbRun('DELETE FROM webhook_deliveries WHERE registration_id = ?', registrationId);
    } catch {
      // nothing was recorded
    }
    resetFakes();
    rmSync(ghRoot, { recursive: true, force: true });
    rmSync(glRoot, { recursive: true, force: true });
    await api.post('/hosts/refresh').catch(() => {});
  }
};
