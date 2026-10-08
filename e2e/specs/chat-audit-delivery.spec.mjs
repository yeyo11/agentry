// Reproductions of the chat message audit (docs/reports/chat-audit/repro.md) in the browser, against
// the fake CLI: a message sent during a turn and then lost, "Send now", files, switching chats,
// typing while a send is on its way, and a message sent while a permission prompt waits. The fake
// writes a transcript in the CLI's own shape (`"@transcript": true`), so a reload reads what the CLI
// would have written, including the `queued_command` line of a message it read mid-turn.
//
// They were written as reproductions of the audit's bugs, and are kept to show each one fixed
// (docs/chat-delivery.md): every scenario reports REPRODUCED or NOT REPRODUCED instead of failing the
// run, and `check` guards only the setup. B2 is the sound path and must keep working. They run only
// with E2E_CHAT_AUDIT=1; E2E_CHAT_AUDIT_OUT=<file> also writes the findings as JSON, and
// E2E_CHAT_AUDIT_ONLY=A,C runs only those scenarios (A, B1, B2, C, C2, D, E, F, G).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 480_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(condition, label, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(150);
  }
}

const SCRIPTS = {
  'AUDIT-A': 'run: sleep 4\nrun: sleep 2\nsay: Scripts tidied.',
  'AUDIT-B1': 'run: sleep 2\nrun: sleep 30\nsay: Done.',
  'AUDIT-B2': 'run: true\nhold: audit-b2.hold\nsay: Done.',
  'AUDIT-C': 'run: true\nhold: audit-c.hold\nsay: Done.',
  'AUDIT-K': 'run: true\nhold: audit-c2.hold\nsay: Done.',
  'AUDIT-G': 'run: true\nhold: audit-g.hold\nsay: Done.',
  'AUDIT-D1': 'run: true\nhold: audit-d1.hold\nsay: Done.',
  'AUDIT-D2': 'run: true\nhold: audit-d2.hold\nsay: Done.',
  'AUDIT-E': 'run: true\nhold: audit-e.hold\nsay: Done.',
  'AUDIT-F': 'run: true\nask: rm -rf build\nsay: Done.',
};
const HOLDS = ['audit-b2.hold', 'audit-c.hold', 'audit-c2.hold', 'audit-d1.hold', 'audit-d2.hold', 'audit-e.hold', 'audit-g.hold'];

/** What the page shows of the queued cards and the person's rows. */
const VIEW = `
  const cards = [...document.querySelectorAll('.chat-queued-item')].map((li) => ({
    text: li.querySelector('.chat-queued-text')?.textContent ?? '',
    lost: !!li.querySelector('.icon-btn'),
  }));
  const rows = [...document.querySelectorAll('.transcript .msg-user')].map((m) => m.innerText);
  const lostFoot = !!document.querySelector('.chat-queued.is-lost');
  const sendNow = !!document.querySelector('.chat-queued-foot .btn');
  return { cards, rows, lostFoot, sendNow, box: document.querySelector('.composer textarea')?.value ?? null,
    chips: document.querySelectorAll('.attachments-pending .attachment-chip').length };`;

/** A paste of one small text file into the composer's box, as a person's Ctrl+V of a file. */
const PASTE_FILE = (name) => `
  const box = document.querySelector('.composer textarea'); if (!box) return false;
  const dt = new DataTransfer(); dt.items.add(new File(['audit ${name}\\n'], '${name}', { type: 'text/plain' }));
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true;`;

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  if (process.env.E2E_CHAT_AUDIT !== '1') {
    console.log('  (chat-audit-delivery: audit reproductions; set E2E_CHAT_AUDIT=1 to run them)');
    return;
  }
  const findings = [];
  const report = (id, reproduced, evidence) => {
    findings.push({ id, reproduced, evidence });
    console.log(`  ${id}: ${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'} — ${JSON.stringify(evidence)}`);
  };
  const savedScripts = existsSync(fake.scripts) ? readFileSync(fake.scripts, 'utf8') : null;
  writeFileSync(fake.scripts, JSON.stringify({ ...SCRIPTS, '@transcript': true }));
  const started = [];
  const hold = (name) => writeFileSync(join(dirs.workspaceDir, name), '');
  const log = () => logOf(fake.log);
  const startChat = async (prompt, extra = {}) => {
    const res = await api.post('/chats', { prompt, cwd: dirs.workspaceDir, ...extra });
    check(res.status === 201, `the chat "${prompt}" started: ${JSON.stringify(res.body)}`);
    started.push(res.body.id);
    return res.body.id;
  };
  // Each scenario stands alone: the chats an earlier one left running are stopped, or nine scenarios
  // in one sandbox reach the server's limit on concurrent runs and the last one cannot start its chat
  const retire = async () => {
    for (const id of started.splice(0)) await api.post(`/chats/${id}/stop`).catch(() => {});
  };
  const pidOf = (id) => log().find((e) => e.event === 'started' && e.argv.includes(id))?.pid;
  const view = () => page.eval(VIEW);
  const open = async (id) => {
    await page.goto(`/chats/${id}`, 1200);
    await page.waitFor(`return !!document.querySelector('.composer textarea')`, { label: 'the composer' });
  };
  // The page queues a message only when it shows the chat working (C-8): wait for that, as a person would see it
  const working = () => page.waitFor(`return !!document.querySelector('.composer.is-working')`, { label: 'the page to show the chat working' });
  const want = (key) => !process.env.E2E_CHAT_AUDIT_ONLY || process.env.E2E_CHAT_AUDIT_ONLY.split(',').includes(key);
  const send = async (text) => {
    await page.fill('.composer textarea', text);
    await page.click('.composer-send');
  };
  const state = async (id) => (await api.get(`/chats/${id}`)).body?.chat?.state;
  const servedUserTexts = async (id) => ((await api.get(`/chats/${id}`)).body?.entries ?? []).filter((e) => e.role === 'user').flatMap((e) => e.blocks.filter((b) => b.type === 'text').map((b) => b.text));
  const transcriptLines = (id) => {
    const dir = join(dirs.configDir, 'projects', dirs.workspaceDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const file = join(dir, `${id}.jsonl`);
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const waitLost = (text, ms = 15_000) =>
    until(async () => (await view()).cards.some((c) => c.text.includes(text) && c.lost), `the card "${text}" to be called lost`, ms).then(
      () => true,
      () => false,
    );

  try {
    await page.goto('/', 800);

    // ---------- Symptom 1, C-1 / S-4 / C-7: a message read mid-turn is called lost, and a reload loses it ----------
    if (want('A')) {
      await retire();
      const MSG = 'also list the files';
      const id = await startChat('AUDIT-A tidy the scripts');
      await open(id);
      await until(() => log().some((e) => e.event === 'command' && e.command === 'sleep 4' && e.pid === pidOf(id)), 'the first command');
      await working();
      await send(MSG);
      const card = await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card').catch(() => false);
      const absorbed = await until(() => log().some((e) => e.event === 'absorbed' && e.pid === pidOf(id) && e.texts.includes(MSG)), 'the CLI to read it mid-turn').catch(() => false);
      await until(async () => (await state(id)) === 'idle', 'the turn to end');
      const answeredOnPage = await until(async () => (await page.eval(`return document.querySelector('.transcript')?.innerText ?? ''`)).includes(`Heard: ${MSG}`), 'the answer on the page').catch(() => false);
      const lost = await waitLost(MSG);
      const lines = transcriptLines(id);
      const cliLine = lines.find((l) => l.type === 'attachment' && l.attachment?.type === 'queued_command' && l.attachment.prompt === MSG);
      const userLine = lines.some((l) => l.type === 'user' && l.message?.content === MSG);
      await open(id);
      await sleep(800);
      const afterReload = (await view()).rows.some((r) => r.includes(MSG));
      const served = (await servedUserTexts(id)).includes(MSG);
      report('C-1 / S-4 (symptom 1)', Boolean(absorbed && lost && !afterReload), {
        cardShown: Boolean(card),
        agentReadItMidTurn: Boolean(absorbed),
        answerOnPage: Boolean(answeredOnPage),
        cardCalledLostAfterTurn: lost,
        transcriptHasQueuedCommand: Boolean(cliLine),
        transcriptHasUserLine: userLine,
        onPageAfterReload: afterReload,
        servedByGetChat: served,
      });
    }

    // ---------- C-2: "Send now" cuts the turn that is already answering the message ----------
    if (want('B1')) {
      await retire();
      const MSG = 'use the staging config';
      const id = await startChat('AUDIT-B1 deploy the preview');
      await open(id);
      await until(() => log().some((e) => e.event === 'command' && e.command === 'sleep 2' && e.pid === pidOf(id)), 'the first command');
      await working();
      await send(MSG);
      // Shown until the agent reads it, which can be a moment later: seen or not, what counts is after
      const cardShown = await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card', 5000).catch(() => false);
      await until(() => log().some((e) => e.event === 'absorbed' && e.pid === pidOf(id) && e.texts.includes(MSG)), 'the CLI to read it mid-turn');
      await until(() => log().some((e) => e.event === 'command' && e.command === 'sleep 30' && e.pid === pidOf(id)), 'the work on it to start');
      await sleep(800);
      const before = await view();
      const offered = before.sendNow && before.cards.some((c) => c.text === MSG);
      if (offered) await page.click('.chat-queued-foot .btn');
      const cut = await until(() => log().find((e) => e.event === 'command-ended' && e.command === 'sleep 30' && e.pid === pidOf(id)), 'the second command to end', 10_000).catch(() => null);
      report('C-2 (symptom 2, Send now)', Boolean(offered && cut?.interrupted), {
        cardShown: Boolean(cardShown),
        agentHadReadIt: true,
        sendNowStillOffered: offered,
        turnAnsweringItInterrupted: Boolean(cut?.interrupted),
      });
    }

    // ---------- Send now on a message the CLI still holds: the sound path ----------
    if (want('B2')) {
      await retire();
      const MSG = 'and the changelog';
      const id = await startChat('AUDIT-B2 bump the version');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      await sleep(600);
      await send(MSG);
      await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card');
      await page.click('.chat-queued-foot .btn');
      const read = await until(() => log().some((e) => e.event === 'turn' && e.pid === pidOf(id) && e.text === MSG), 'the CLI to read it as a turn', 10_000).catch(() => false);
      const cleared = await until(async () => !(await view()).cards.some((c) => c.text === MSG), 'the card to clear', 10_000).catch(() => false);
      report('Send now, message still queued (expected sound)', !(read && cleared), { readAsNextTurn: Boolean(read), cardCleared: Boolean(cleared) });
    }

    // ---------- C-3: a message with a file never matches its card ----------
    if (want('C')) {
      await retire();
      const MSG = 'look at this file, please';
      const id = await startChat('AUDIT-C review the notes');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      await sleep(600);
      await page.waitFor(PASTE_FILE('notes.txt'), { label: 'paste a file' });
      await page.waitFor(`return document.querySelectorAll('.attachments-pending .attachment-chip').length === 1 && !document.querySelector('.attachments-pending .spin')`, { label: 'the file uploaded' });
      await send(MSG);
      await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card');
      await sleep(1500);
      const shownTwice = (await view()).rows.some((r) => r.includes(MSG));
      hold('audit-c.hold');
      const read = await until(() => log().some((e) => e.event === 'turn' && e.pid === pidOf(id) && e.text.startsWith(MSG)), 'the CLI to read it as a turn').catch(() => false);
      const lost = await waitLost(MSG);
      let restoredText = null;
      let restoredFiles = null;
      if (lost) {
        await page.click('.chat-queued-item .icon-btn');
        const after = await view();
        restoredText = after.box;
        restoredFiles = after.chips;
      }
      const cleared = !(await view()).cards.some((c) => c.text === MSG);
      report('C-3 (files)', Boolean(read && (lost || shownTwice || !cleared)), { readByCli: Boolean(read), rowAndCardAtOnce: shownTwice, cardCalledLost: lost, cardCleared: cleared, restoredText, restoredFiles });
    }

    // ---------- C-3: Restore hands back the words and the files of a message that was lost ----------
    if (want('C2')) {
      await retire();
      const MSG = 'keep this file for later';
      const id = await startChat('AUDIT-K file the report');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      await sleep(600);
      await page.waitFor(PASTE_FILE('report.txt'), { label: 'paste a file' });
      await page.waitFor(`return document.querySelectorAll('.attachments-pending .attachment-chip').length === 1 && !document.querySelector('.attachments-pending .spin')`, { label: 'the file uploaded' });
      await send(MSG);
      await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card');
      // Stopped before the agent read it: the message dies with the process, and the page is told
      await api.post(`/chats/${id}/stop`);
      const lost = await waitLost(MSG);
      let after = null;
      if (lost) {
        await page.click('.chat-queued-item .icon-btn');
        await sleep(300);
        after = await view();
      }
      report('C-3 (Restore keeps the files)', !(lost && after?.box?.includes(MSG) && after?.chips === 1), { cardCalledLost: lost, restoredText: after?.box ?? null, restoredFiles: after?.chips ?? null });
    }

    // ---------- C-4: a queued card follows the person into another chat, and Send now stops that one ----------
    if (want('D')) {
      await retire();
      const MSG = 'note for the first chat';
      const first = await startChat('AUDIT-D1 first chat');
      const second = await startChat('AUDIT-D2 second chat');
      await until(() => [first, second].every((id) => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id))), 'both turns at their hold');
      await sleep(600);
      await open(first);
      await send(MSG);
      await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card');
      // Within the app, as a sidebar link moves: no reload
      await page.eval(`history.pushState(null, '', '/chats/${second}'); dispatchEvent(new PopStateEvent('popstate')); return true`);
      await page.waitFor(`return location.pathname.endsWith('${second}') && (document.querySelector('.transcript')?.innerText ?? '').includes('AUDIT-D2')`, { label: 'the second chat' });
      await sleep(800);
      const onSecond = (await view()).cards.some((c) => c.text === MSG);
      const controlsBefore = log().filter((e) => e.event === 'control' && e.subtype === 'interrupt').length;
      if (onSecond) await page.click('.chat-queued-foot .btn');
      const interrupt = await until(() => log().filter((e) => e.event === 'control' && e.subtype === 'interrupt').slice(controlsBefore)[0], 'an interrupt', 8_000).catch(() => null);
      report('C-4 (switching chats)', Boolean(onSecond && interrupt?.pid === pidOf(second)), {
        cardOfFirstChatShownOnSecond: onSecond,
        interruptHit: interrupt ? (interrupt.pid === pidOf(second) ? 'second chat' : interrupt.pid === pidOf(first) ? 'first chat' : 'other') : 'none',
      });
      hold('audit-d1.hold');
      hold('audit-d2.hold');
    }

    // ---------- C-5: what is typed while a send is on its way is erased ----------
    if (want('E')) {
      await retire();
      const id = await startChat('AUDIT-E write the docs');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      // A slow network (or a resume, which spawns a process): the POST takes two seconds
      await page.eval(`const f = window.fetch; window.fetch = async (input, init) => { const u = String(input?.url ?? input); if ((init?.method ?? input?.method) === 'POST' && u.includes('/messages')) await new Promise((r) => setTimeout(r, 2000)); return f(input, init); }; return true`);
      await send('first message');
      await page.focus('.composer textarea');
      await page.type('second thought');
      await page.waitFor(PASTE_FILE('later.txt'), { label: 'paste a file while sending' });
      const during = await view();
      await until(() => log().some((e) => e.event === 'stdin' && e.pid === pidOf(id) && e.text === 'first message'), 'the first message to reach the CLI');
      await sleep(1500);
      const after = await view();
      report('C-5 (typing while sending)', !(after.box?.includes('second thought') && after.chips === 1), { boxWhileSending: during.box, chipsWhileSending: during.chips, boxAfter: after.box, chipsAfter: after.chips });
      hold('audit-e.hold');
    }

    // ---------- C-8: a message sent while a permission prompt waits gets no card ----------
    if (want('F')) {
      await retire();
      const MSG = 'skip that, just list the build dir';
      const id = await startChat('AUDIT-F clean the build', { permissionPrompts: 'host' });
      await open(id);
      await page.waitFor(`return !!document.querySelector('.permission .permission-actions .btn-primary')`, { label: 'the permission prompt' });
      const waitingState = await state(id);
      await send(MSG);
      await until(() => log().some((e) => e.event === 'stdin' && e.pid === pidOf(id) && e.text === MSG), 'the message to reach the CLI');
      await sleep(1500);
      const v = await view();
      const card = v.cards.some((c) => c.text === MSG);
      await page.click('.permission .permission-actions .btn-primary');
      const absorbed = await until(() => log().some((e) => e.event === 'absorbed' && e.pid === pidOf(id) && e.texts.includes(MSG)), 'the CLI to read it').catch(() => false);
      await until(async () => (await state(id)) === 'idle', 'the turn to end');
      await open(id);
      await sleep(800);
      const afterReload = (await view()).rows.some((r) => r.includes(MSG));
      report('C-8 (sent during a permission prompt)', !card, { chatState: waitingState, cardShown: card, rowShown: v.rows.some((r) => r.includes(MSG)), readByCli: Boolean(absorbed), onPageAfterReload: afterReload });
    }

    // ---------- C-13: after a reload, a message still waiting is a queued card ----------
    if (want('G')) {
      await retire();
      const MSG = 'and update the readme';
      const id = await startChat('AUDIT-G write the release notes');
      await open(id);
      await until(() => log().some((e) => e.event === 'command-ended' && e.command === 'true' && e.pid === pidOf(id)), 'the turn to reach its hold');
      await sleep(600);
      await send(MSG);
      await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the queued card');
      await open(id);
      const afterReload = await until(async () => (await view()).cards.some((c) => c.text === MSG), 'the card after a reload', 8000).catch(() => false);
      const listed = ((await api.get(`/chats/${id}`)).body?.chat?.pending ?? []).some((m) => m.text === MSG);
      hold('audit-g.hold');
      const cleared = await until(async () => !(await view()).cards.some((c) => c.text === MSG), 'the card to clear once read', 10_000).catch(() => false);
      report('C-13 (a reload loses the waiting card)', !afterReload, { cardAfterReload: Boolean(afterReload), listedByGetChat: listed, clearedOnceRead: Boolean(cleared) });
    }
  } finally {
    for (const name of HOLDS) hold(name);
    for (const id of started) await api.post(`/chats/${id}/stop`).catch(() => {});
    if (savedScripts === null) rmSync(fake.scripts, { force: true });
    else writeFileSync(fake.scripts, savedScripts);
    for (const name of HOLDS) rmSync(join(dirs.workspaceDir, name), { force: true });
    if (process.env.E2E_CHAT_AUDIT_OUT) writeFileSync(process.env.E2E_CHAT_AUDIT_OUT, JSON.stringify(findings, null, 2));
    // Specs after this one read the projects directory: the transcripts the fake wrote go with it
    const dir = join(dirs.configDir, 'projects', dirs.workspaceDir.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const id of started) rmSync(join(dir, `${id}.jsonl`), { force: true });
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
};
