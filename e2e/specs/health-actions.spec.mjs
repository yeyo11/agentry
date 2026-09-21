// The three ways to step in on a worker that looks stuck, from its chat's health card: send it a
// hint, cancel the command that hangs, interrupt the turn. They act on a live process, so this spec
// runs against the fake CLI (e2e/fake-cli): a chat whose two commands really run (`sleep`, one as a
// pipeline so that it is a tree of processes) and whose heartbeats say they have run for minutes,
// which is what makes the `hung-command` signal fire without waiting for it. The fake writes what it
// heard to a log, which is how this spec knows a hint reached the process and not only the page.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export const fakeCli = true;

const HINT = 'E2E-HINT: find out what the pipe is waiting for.';
const HEALTH = '.obs-health';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the fake CLI logged, one fact per line. */
const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A pid and every process under it, from /proc: what a cancel must end, read the way the wrapper reads it. */
function tree(root) {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const name of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === out[i]) out.push(Number(name));
      } catch {
        // gone in between
      }
    }
  }
  return out;
}
const alive = (pid) => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\)\s+/s, '').startsWith('Z');
  } catch {
    return false;
  }
};

/** Polls a condition on this side of the browser: the process table, the fake's log, the API. */
async function until(condition, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(200);
  }
}

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  if (!existsSync('/proc/self/stat')) {
    console.log('  (health-actions: cancelling a command needs /proc; nothing to check here)');
    return;
  }
  const started = await api.post('/chats', { prompt: 'elapsed: 200\nrun: sleep 600 | cat\nrun: sleep 601', cwd: dirs.workspaceDir });
  check(started.status === 201, `the chat started: ${JSON.stringify(started.body)}`);
  const id = started.body.id;
  const commandOf = (command) => logOf(fake.log).find((e) => e.event === 'command' && e.command === command);
  try {
    await page.goto(`/chats/${id}`, 1500);
    await page.waitFor(`return document.querySelector('${HEALTH}')?.innerText.includes('sleep 600 | cat')`, { label: 'the hung-command signal of the first command' });
    const first = await until(() => commandOf('sleep 600 | cat'), 'the fake started the first command');
    const firstTree = tree(first.commandPid);
    check(firstTree.length >= 2 && firstTree.every(alive), `the first command is a tree of live processes: ${firstTree.join(', ')}`);

    // A hint: the box comes written for the signal, and what is sent reaches the process
    await page.click(`${HEALTH} button`, 'Send a hint');
    await page.waitFor(`return document.querySelector('${HEALTH} textarea')?.value.includes('sleep 600 | cat')`, { label: 'the hint box, written for the signal' });
    await page.fill(`${HEALTH} textarea`, HINT);
    await page.click(`${HEALTH} button[type=submit]`, 'Send the hint');
    await until(() => logOf(fake.log).some((e) => e.event === 'stdin' && e.text.includes(HINT)), 'the hint reached the CLI process');
    check(firstTree.every(alive), 'a hint leaves the command running');

    // Cancel: after a confirmation, the command's whole tree goes and the worker carries on
    await page.click(`${HEALTH} button`, 'Cancel the command');
    await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the cancel confirmation' });
    await page.eval(`[...document.querySelector('[role=dialog]').querySelectorAll('button')].find((b) => b.textContent.includes('Cancel the command')).click(); return true;`);
    await until(() => firstTree.every((pid) => !alive(pid)), 'every process of the cancelled command is gone');
    const second = await until(() => commandOf('sleep 601'), 'the worker went on to its next command');
    check(logOf(fake.log).filter((e) => e.event === 'started').length === 1, 'the same CLI process went on: nothing was restarted');
    await page.waitFor(
      `const t = document.querySelector('main').innerText; return t.includes('Heard: A hint from the person following this chat') && t.includes('Heard: A person cancelled the command');`,
      { label: 'the worker answered the hint and the notice of the cancel' },
    );
    await page.waitFor(`return document.querySelector('${HEALTH}')?.innerText.includes('sleep 601')`, { label: 'the signal moved to the second command' });

    // Interrupt: the turn ends, its command with it, and the process stays for the next message
    const secondTree = tree(second.commandPid);
    check(secondTree.every(alive), 'the second command is running');
    await page.click(`${HEALTH} button`, 'Interrupt');
    await until(() => logOf(fake.log).some((e) => e.event === 'control' && e.subtype === 'interrupt'), 'the interrupt reached the CLI as a control request');
    await until(() => secondTree.every((pid) => !alive(pid)), 'the interrupted command is gone');
    const idle = await until(async () => {
      const { body } = await api.get(`/chats/${id}`);
      return body?.chat?.state === 'idle' && body.chat.execution ? body.chat : null;
    }, 'the chat is idle with its process kept');
    check(idle.execution !== null, 'the process is kept after an interrupt');
    await page.waitFor(`return !document.querySelector('${HEALTH}')`, { label: 'no signal to step in on once the turn ended' });
  } finally {
    // Stopped and removed, so the sandbox holds what it held before
    await api.post(`/chats/${id}/stop`);
    await until(async () => (await api.get(`/chats/${id}`)).body?.chat?.execution === null, 'the chat stopped', 10_000).catch(() => {});
    await api.del(`/chats/${id}`);
  }
};
