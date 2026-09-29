// What the accessibility specs share (this file is not a spec: the runner only picks `*.spec.mjs`).
// Accessibility is checked instead of asserted: axe-core over every page in both themes and at phone
// width, the overlays that open over them, the keyboard paths the palette must not be the only way
// around, and the contrast of the theme tokens (which axe cannot judge over gradients and tints).
// Findings are gathered and reported together, so one run says everything that is wrong.
//
// The pages are cut into four specs by screen group (a11y-core, a11y-shell, a11y-projects and
// a11y-team), so that the e2e shards can run them side by side instead of one of them carrying
// three and a half minutes of scans alone. Each one seeds the same content through `a11ySpec`: a chat
// (with a subagent and a background task), a project with its board (an epic, work items with
// criteria and a relation, a milestone) and an orchestration whose workers fail in the sandbox, so
// the pages are scanned with content in them. All of it is removed afterwards because the chats
// spec counts what the sandbox holds. The assistant's screens (orchestration 4) are scanned without
// the CLI: an empty project's run reads nothing, starts no chat, and offers the template's team at once.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/core/test/fixtures');
const PROJECT = '-work-e2e-a11y';
export const SESSION = 'e2e-a11y-session';
export const AGENT = 'a1b2c3d4e5f60718';

const line = (o) => JSON.stringify(o);

// ---------- contrast of the tokens ----------

const luminance = ([r, g, b]) => {
  const channel = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `#rrggbb` or `rgba(r, g, b, a)` as [r, g, b, a] */
function parseColor(text) {
  const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(text.trim());
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1].split(',').map((v) => v.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  return null;
}
const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];

const SURFACES = ['--bg', '--bg-elev', '--bg-sunken', '--bg-hover'];
const TEXTS = ['--text', '--text-muted', '--text-faint', '--accent', '--accent-2', '--ok', '--warn', '--bad', '--info', '--idle'];
const SOFT = { '--ok': '--ok-soft', '--warn': '--warn-soft', '--bad': '--bad-soft', '--info': '--info-soft', '--idle': '--idle-soft', '--accent': '--accent-soft', '--accent-2': '--accent-2-soft' };

export async function tokenContrast(page, theme, problems) {
  const names = [...SURFACES, ...TEXTS, ...Object.values(SOFT), '--accent-text', '--gradient-accent'];
  const values = await page.eval(
    `const cs = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, cs.getPropertyValue(n).trim()]))`,
  );
  const color = (name) => parseColor(values[name] ?? '');
  const fail = (what, got) => problems.push(`[${theme}] token contrast: ${what} is ${got.toFixed(2)}:1, needs 4.5:1`);
  for (const surface of SURFACES) {
    const bg = color(surface);
    if (!bg) continue;
    for (const text of TEXTS) {
      const fg = color(text);
      if (fg && ratio(over(fg, bg), bg) < 4.5) fail(`${text} on ${surface}`, ratio(fg, bg));
      const soft = color(SOFT[text] ?? '');
      if (fg && soft) {
        const tinted = over(soft, bg);
        if (ratio(fg, tinted) < 4.5) fail(`${text} on its tint over ${surface}`, ratio(fg, tinted));
      }
    }
  }
  const stops = [...(values['--gradient-accent'] ?? '').matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]));
  const onAccent = color('--accent-text');
  for (const stop of stops) {
    if (onAccent && stop && ratio(onAccent, stop) < 4.5) fail('--accent-text on the accent gradient', ratio(onAccent, stop));
  }
  if (stops.length === 0) problems.push(`[${theme}] token contrast: --gradient-accent has no colour stops to check`);
}

// ---------- axe ----------

/** Scans the page as it is and files each new finding once, however many pages repeat it (the shell does). */
function scanner() {
  const seen = new Map();
  const scan = async (page, where, { rules } = {}) => {
    for (const violation of await page.axe({ rules })) {
      for (const node of violation.nodes) {
        const key = `${violation.id}|${node.target}`;
        const known = seen.get(key);
        if (known) {
          known.also += 1;
          continue;
        }
        seen.set(key, { where, violation, node, also: 0 });
      }
    }
  };
  const report = (problems) => {
    for (const { where, violation, node, also } of seen.values()) {
      problems.push(
        `[${where}] ${violation.id} (${violation.impact}): ${violation.help}${also ? ` — also on ${also} more page(s)` : ''}\n      ${node.target}\n      ${node.html}\n      ${node.why}`,
      );
    }
  };
  return { scan, report };
}

// Modal content is outside every landmark by design: the dialog is what names it. Radix hides the page
// behind an open menu from screen readers but leaves its controls focusable, with focus trapped in the menu.
export const OVERLAY_RULES = { region: { enabled: false }, 'aria-hidden-focus': { enabled: false } };

export const settle = async (page, path) => {
  await page.goto(path, 500);
  await page.waitFor(`const m = document.querySelector('main'); return m && m.innerText.trim().length > 20 && !m.querySelector('[aria-busy=true]')`, { label: `${path} content` });
  await page.sleep(400);
};

// ---------- the keyboard ----------

export const focusInfo = `
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const style = getComputedStyle(el);
  const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || '';
  // A ring is an outline; a text field shows one as a shadow, and a wrapper (the composer) can show it for its field
  const outlined = (node) => { const s = getComputedStyle(node); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; };
  const shadowed = (node) => getComputedStyle(node).boxShadow !== 'none';
  const field = ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) || el.isContentEditable;
  const ring = outlined(el) || (field && shadowed(el)) || [...document.querySelectorAll(':focus-within')].some((node) => node !== el && (outlined(node) || (field && shadowed(node))));
  return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name: name.trim().replace(/\\s+/g, ' ').slice(0, 60), href: el.getAttribute('href'), cls: el.className?.toString().slice(0, 40), ring, visible: style.visibility !== 'hidden' && el.getClientRects().length > 0 };`;

// ---------- the pages, by group ----------

export const SETTINGS_TABS = ['account', 'instructions', 'settings', 'mcp', 'agents', 'skills', 'commands', 'output-styles', 'rules', 'files', 'memory', 'plugins', 'supervisor', 'security', 'remote', 'install', 'notifications'];

/** Every desktop page is scanned in both themes; Home is the selected project's page, so each theme starts from All projects */
export async function scanBothThemes(page, pages, scan, each) {
  for (const theme of ['dark', 'light']) {
    await page.eval(`localStorage.setItem('agentry-theme', ${JSON.stringify(theme)}); localStorage.removeItem('agentry:project'); return true`);
    if (each) await each(theme);
    for (const path of pages) {
      await settle(page, path);
      await scan(page, `${theme} ${path}`);
    }
  }
}

/** At phone width, in the dark theme: axe, and no page scrolls sideways */
export async function scanNarrow(page, pages, scan, problems) {
  await page.eval(`localStorage.setItem('agentry-theme', 'dark'); return true`);
  await page.viewport(420, 900);
  for (const path of pages) {
    await settle(page, path);
    await scan(page, `420px ${path}`);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    if (overflow > 1) problems.push(`[420px ${path}] the page scrolls sideways by ${overflow}px`);
  }
}

/** At tablet width, no page scrolls sideways */
export async function checkTablet(page, pages, problems) {
  await page.viewport(768, 900);
  for (const path of pages) {
    await settle(page, path);
    const overflow = await page.eval('return document.documentElement.scrollWidth - window.innerWidth');
    if (overflow > 1) problems.push(`[768px ${path}] the page scrolls sideways by ${overflow}px`);
  }
  await page.viewport(1440, 900);
}

/** Status is never colour alone */
export async function checkStatusWords(page, pages, problems) {
  for (const path of pages) {
    await settle(page, path);
    const bare = await page.eval(`
      const bare = [];
      for (const badge of document.querySelectorAll('.badge-ok, .badge-warn, .badge-bad, .badge-idle')) {
        if (!badge.querySelector('svg, .spinner') || !badge.textContent.trim()) bare.push(badge.outerHTML.slice(0, 120));
      }
      for (const dot of document.querySelectorAll('main .status-dot')) {
        if (!dot.getAttribute('aria-label') && !(dot.parentElement?.textContent ?? '').trim()) bare.push(dot.outerHTML.slice(0, 120));
      }
      return bare;`);
    for (const html of bare) problems.push(`[${path}] a status is shown by colour alone (needs its words and an icon): ${html}`);
  }
}

/**
 * One accessibility spec: seeds the content, hands `checks` everything it needs, reports every
 * finding in one assertion, and removes what it seeded whatever happened.
 */
export function a11ySpec(checks) {
  return async ({ page, api, check, dirs }) => {
    const problems = [];
    const { scan, report } = scanner();
    const at = new Date().toISOString();
    const projectDir = join(dirs.configDir, 'projects', PROJECT);
    const sessionDir = join(projectDir, SESSION);
    const tasksRoot = join(tmpdir(), `claude-${String(process.getuid?.() ?? 0)}`, PROJECT);
    const workspace = join(dirs.workspaceDir, 'e2e-a11y');
    let projectId = null;
    let emptyProjectId = null;
    let orchestrationId = null;
    const workItems = [];
    const orchestrationChats = [];

    try {
      // ---------- seed ----------
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(projectDir, `${SESSION}.jsonl`),
        [
          { type: 'user', uuid: 'd1', timestamp: at, cwd: '/work/e2e-a11y', version: '2.1.0', message: { role: 'user', content: 'survey the build and tell me what to fix' } },
          {
            type: 'assistant',
            uuid: 'd2',
            timestamp: at,
            message: {
              role: 'assistant',
              id: 'msg-a11y',
              model: 'claude-sonnet-5',
              content: [
                { type: 'text', text: '### What to fix\n\n1. The **lint** step is slow\n2. A flaky test\n3. Stale `README` links\n\n| step | time |\n| --- | --- |\n| lint | 41s |\n| test | 12s |\n\n```bash\npnpm lint --fix\n```' },
                { type: 'tool_use', id: 'toolu_explore01', name: 'Task', input: { description: 'Survey the build scripts', prompt: 'List the build scripts' } },
              ],
              usage: { input_tokens: 2400, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            },
          },
          { type: 'user', uuid: 'd3', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_explore01', content: 'ok' }] }, toolUseResult: { agentId: AGENT } },
        ]
          .map(line)
          .join('\n'),
      );
      cpSync(join(FIXTURES, 'agent-session'), sessionDir, { recursive: true });
      mkdirSync(join(tasksRoot, SESSION, 'tasks'), { recursive: true });
      writeFileSync(join(tasksRoot, SESSION, 'tasks', 'bg-sub-1.output'), 'watching the build\nrebuilt in 12ms\n');

      mkdirSync(workspace, { recursive: true });
      // Every module on, so the project page has its Board and Memory tabs to scan
      const imported = await api.post('/projects/import', { path: workspace, name: 'e2e-a11y', template: 'software' });
      check(imported.status === 201, `the project was imported (${imported.status})`);
      projectId = imported.body.id;
      // A board with something on every kind of mark: types, an urgent priority, an epic, labels, a
      // checklist half done, a blocker, a milestone, and a column over its limit
      const settings = (await api.get(`/projects/${projectId}/settings`)).body;
      await api.put(`/projects/${projectId}/settings`, { ...settings, board: { ...settings.board, columnLimits: { in_progress: 1 } } });
      const milestone = (await api.post(`/projects/${projectId}/milestones`, { name: 'v1.0', description: 'The first release' })).body;
      const make = async (body) => {
        const made = await api.post(`/projects/${projectId}/work-items`, body);
        check(made.status === 201, `"${body.title}" was created (${made.status})`);
        workItems.push(made.body.id);
        return made.body;
      };
      const epic = await make({ title: 'Accessible board', type: 'epic', status: 'in_progress' });
      const story = await make({
        title: 'Read the board with a screen reader',
        type: 'story',
        status: 'in_progress',
        priority: 'urgent',
        labels: ['a11y'],
        epicId: epic.id,
        milestoneId: milestone.id,
        description: 'Every card says its **key**, its column and its priority in words.',
        acceptanceCriteria: [{ text: 'Cards are named', checked: true }, { text: 'Moves are announced' }],
      });
      const blocker = await make({ title: 'Name the columns', type: 'task', status: 'todo', milestoneId: milestone.id });
      await make({ title: 'Focus ring on cards', type: 'bug', status: 'done', milestoneId: milestone.id });
      await api.post(`/work-items/${blocker.id}/relations`, { type: 'blocks', itemId: story.id });
      await api.post(`/work-items/${story.id}/comments`, { body: 'Check it with the keyboard only.' });
      const board = `/tasks?project=${projectId}`;
      const itemPage = `/tasks/${story.key}?project=${projectId}`;

      // Orchestration 3's screens with something in them: the template's team (so the board, the item
      // and the flow name roles), a document tied to the story, and a journal entry. The flow stays
      // off, so no run starts in the sandbox; the story is assigned to a role
      const team = await api.post(`/projects/${projectId}/team/from-template`, {});
      check(team.status === 200 || team.status === 201, `the template's team (${team.status})`);
      const spec = await api.put(`/projects/${projectId}/documents/file?path=${encodeURIComponent('docs/specs/board.md')}`, { content: '# Board\n\nEvery card says its key.\n' });
      check(spec.status === 200, `a document was written (${spec.status})`);
      await api.post(`/work-items/${story.id}/documents`, { path: 'docs/specs/board.md', kind: 'spec' });
      await api.post(`/projects/${projectId}/journal`, { kind: 'decision', text: 'Cards name their column in words' });
      await api.request('PATCH', `/work-items/${story.id}`, { assignee: { kind: 'role', role: 'developer' } });
      const project = `/?project=${projectId}`;
      const ecosystem = [
        `${project}&view=team`,
        `${project}&view=team&member=developer`,
        `${project}&view=team&section=flow`,
        `${project}&view=team&section=activity`,
        `${project}&view=documents`,
        `${project}&view=documents&doc=${encodeURIComponent('docs/specs/board.md')}`,
        `${project}&view=documents&doc=${encodeURIComponent('docs/specs/board.md')}&mode=edit`,
        `${project}&view=memory&section=journal`,
        `${project}&view=memory&section=cli`,
      ];
      const milestones = `/tasks/milestones?project=${projectId}`;

      // Orchestration 4's screens: the assistant of a project that has not asked it anything, and of
      // an empty one with the template's team to accept member by member
      const emptyDir = join(dirs.workspaceDir, 'e2e-a11y-empty');
      mkdirSync(emptyDir, { recursive: true });
      const emptyProject = await api.post('/projects/import', { path: emptyDir, name: 'e2e-a11y-empty', template: 'software' });
      check(emptyProject.status === 201, `the empty project was imported (${emptyProject.status})`);
      emptyProjectId = emptyProject.body.id;
      const emptyRun = await api.post(`/projects/${emptyProjectId}/assistant/runs`, { kind: 'project' });
      check(emptyRun.status === 201 && emptyRun.body.empty === true, `the empty project's run reads nothing (${emptyRun.status} ${JSON.stringify(emptyRun.body?.empty)})`);
      const assistant = [`/projects/${projectId}/assistant`, `/projects/${emptyProjectId}/assistant`];

      // Nothing is logged in inside the sandbox, so the first task fails, the one behind it is blocked
      // and the graph waits for a decision: the states the board has to show without colour alone
      const created = await api.post('/orchestrations', {
        name: 'e2e-a11y-board',
        objective: 'a graph whose first task fails',
        cwd: workspace,
        maxAttempts: 1,
        tasks: [
          { id: 'survey', name: 'Survey', prompt: 'Survey the code' },
          { id: 'fix', name: 'Fix', prompt: 'Fix what the survey found', dependsOn: ['survey'] },
        ],
      });
      check(created.status === 201, `the orchestration was created (${created.status})`);
      orchestrationId = created.body.id;
      for (let i = 0; i < 80; i++) {
        const state = (await api.get(`/orchestrations/${orchestrationId}`)).body;
        for (const task of state?.tasks ?? []) if (task.sessionId && !orchestrationChats.includes(task.sessionId)) orchestrationChats.push(task.sessionId);
        if (state && state.status !== 'running') break;
        await page.sleep(500);
      }

      await page.reduceMotion();
      await page.goto('/');

      await checks({ page, api, problems, scan, fx: { projectId, orchestrationId, story, board, itemPage, milestones, ecosystem, assistant } });

      report(problems);
      check(problems.length === 0, `${problems.length} accessibility finding(s):\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
    } finally {
      await page.reduceMotion(false).catch(() => {});
      await page.viewport(1440, 900).catch(() => {});
      await page.eval(`localStorage.removeItem('agentry-theme'); localStorage.removeItem('agentry:project'); return true`).catch(() => {});
      if (orchestrationId) await api.del(`/orchestrations/${orchestrationId}`).catch(() => {});
      for (const id of orchestrationChats) await api.del(`/chats/${id}`).catch(() => {});
      for (const id of workItems.reverse()) await api.del(`/work-items/${id}`).catch(() => {});
      if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
      if (emptyProjectId) await api.del(`/projects/${emptyProjectId}`).catch(() => {});
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(tasksRoot, { recursive: true, force: true });
    }
  };
}
