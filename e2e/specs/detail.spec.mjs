// Execution detail: a subagent and the background task it launched open in a side panel from the
// chat that owns them, and the panel is part of the address. The session is laid out on disk the
// way the CLI keeps it (fixtures shared with the core tests) and removed afterwards, because the
// sessions spec counts what is in the sandbox.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/core/test/fixtures');
const PROJECT = '-work-e2e-detail';
const SESSION = 'e2e-detail-session';
const AGENT = 'a1b2c3d4e5f60718';

const line = (o) => JSON.stringify(o);

export default async ({ page, api, check, dirs }) => {
  const at = new Date().toISOString();
  const projectDir = join(dirs.configDir, 'projects', PROJECT);
  const sessionDir = join(projectDir, SESSION);
  // Where the CLI keeps what a background task printed: one temp directory per user and project
  const tasksRoot = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, PROJECT);
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${SESSION}.jsonl`),
      [
        { type: 'user', uuid: 'd1', timestamp: at, cwd: '/work/e2e-detail', message: { role: 'user', content: 'survey the build' } },
        { type: 'user', uuid: 'd2', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'ok' }] }, toolUseResult: { agentId: AGENT } },
      ]
        .map(line)
        .join('\n'),
    );
    cpSync(join(FIXTURES, 'agent-session'), sessionDir, { recursive: true });
    mkdirSync(join(tasksRoot, SESSION, 'tasks'), { recursive: true });
    writeFileSync(join(tasksRoot, SESSION, 'tasks', 'bg-sub-1.output'), 'watching the build\nrebuilt in 12ms\n');

    const task = (await api.get('/tasks')).body.find((t) => t.id === 'bg-sub-1');
    check(task?.chat.id === SESSION, 'the task carries its chat, so its output can be read');
    check(typeof task?.ownerId === 'string', 'the task is marked as launched by a subagent');
    const shown = task?.description || task?.id;

    // The chat page: the task hangs off the subagent that launched it, and its output opens in a
    // panel that the address remembers
    await page.goto(`/chats/${SESSION}`, 1200);
    // Branches are on the inspector's Environment tab
    await page.click('.chat-inspector [role=tab]', 'Environment');
    await page.waitFor(`return document.querySelector('main').innerText.includes('Branches (')`, { label: 'the branches of the chat' });
    await page.click('main .detail-task-link', shown);
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('rebuilt in 12ms')`, { label: 'the task output in the panel' });
    check((await page.eval('return location.search')).includes('detail=task'), 'the open panel is in the address');
    await page.shot('detail-task');

    await page.goto(`/chats/${SESSION}${await page.eval('return location.search')}`, 1200);
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('rebuilt in 12ms')`, { label: 'the panel back after a reload' });

    await page.key('Escape');
    check(!(await page.eval(`return document.querySelector('[role=dialog]') !== null`)), 'Escape closes the panel');
    check(!(await page.eval('return location.search')).includes('detail='), 'closing drops it from the address');

    // The subagent's prompt, result and transcript, and its task one click away
    await page.click('.chat-inspector [role=tab]', 'Environment');
    await page.click('main .detail-task-link', 'Survey the build scripts');
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('List the build scripts')`, { label: 'the subagent prompt in the panel' });
    const panel = await page.text('[role=dialog]');
    check(panel.includes('Found 3 build scripts'), 'the panel shows what the subagent reported back');
    check(/background tasks it launched/i.test(panel), 'the panel lists the tasks the subagent launched');
    await page.shot('detail-subagent');

    await page.click('[role=dialog] .detail-task-link', undefined, 800);
    await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText.includes('rebuilt in 12ms')`, { label: 'the task panel opened from the subagent' });
    check((await page.eval('return location.search')).includes('detail=task'), 'opening the task replaces the subagent in the address');

    // Clicking outside closes it
    await page.eval(`document.querySelector('.overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true`);
    await page.waitFor(`return document.querySelector('[role=dialog]') === null`, { label: 'the panel to close on a click outside' });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(tasksRoot, { recursive: true, force: true });
  }
};
