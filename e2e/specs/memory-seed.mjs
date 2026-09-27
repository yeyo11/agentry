// What the Memory and Documents specs start from: a project of the "Professional software" template
// with its documents folder, tasks tied to documents a team role wrote, memory proposals waiting for
// the person, a journal, the CLI's CLAUDE.md and memory files, and two tasks waiting under the flow.
// Proposals, a role's document ties and the waiting state are what flow runs write; the fake CLI
// has no structured results, so they are written straight into the sandbox's database, the way
// accounts-config.spec.mjs seeds its rows. Everything else goes through the API.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SPEC_TEXT = `# Board with fixed columns and limits

Specification of **the board**. A project's board has five fixed columns, in this order, and they cannot be edited.

## Columns

- **Backlog**: what someone asked for and nobody refined yet.
- **To do**: refined, with acceptance criteria.
- **In progress**: a chat or an orchestration node works on it.
- **In review**: waits for QA's verification or yours.
- **Done**: only you approve this step.

## Limit per column

Each column may have an optional limit. Going over it is allowed: the column says so in words, in the warning colour, and moving a card is never blocked.
`;

const DOCS = {
  'docs/specs/board.md': SPEC_TEXT,
  'docs/specs/links.md': '# Link tasks with chats and orchestrations\n\nA task keeps every chat that worked on it.\n',
  'docs/adr/ADR-007-links.md': '# ADR-007 · Links are rows\n\nA task\'s links are rows, not a JSON field.\n',
  'docs/plans/ecosystem.md': '# The project ecosystem\n\nModules per project.\n',
  'docs/architecture.md': '# Architecture\n\nOne CLI, many chats.\n',
  'docs/status.md': '# Status\n\nWhere the project stands.\n',
};

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** A project imported from a new directory, with every module on and the flow off, so nothing runs. */
export async function seedProject({ api, check, dirs }, name) {
  const dir = join(dirs.workspaceDir, name);
  mkdirSync(dir, { recursive: true });
  const imported = await api.post('/projects/import', { path: dir, name, template: 'software' });
  check(imported.status === 201, `the project was imported (${imported.status} ${JSON.stringify(imported.body)})`);
  const project = imported.body;
  for (const module of ['board', 'team', 'documents', 'memory']) check(project.modules.includes(module), `the template switched ${module} on`);
  const settings = (await api.get(`/projects/${project.id}/settings`)).body;
  const saved = await api.put(`/projects/${project.id}/settings`, { ...settings, flow: { ...(settings.flow ?? { columns: {} }), enabled: false, maxBounces: 3 } });
  check(saved.status === 200, `the flow is off while the spec seeds (${saved.status} ${JSON.stringify(saved.body)})`);
  return project;
}

/**
 * Seeds the Memory and Documents data of `project`. Returns the items and paths a spec checks.
 */
export async function seedEcosystem({ api, check, dirs }, project) {
  const pid = project.id;
  const make = async (body) => {
    const made = await api.post(`/projects/${pid}/work-items`, body);
    check(made.status === 201, `"${body.title}" was created (${made.status} ${JSON.stringify(made.body)})`);
    return made.body;
  };
  const board = await make({ title: 'Board with fixed columns and limits', type: 'story' });
  const links = await make({ title: 'Link tasks with chats and orchestrations', type: 'story' });
  const tables = await make({ title: 'Work item tables in SQLite' });
  const templates = await make({ title: 'Project templates', type: 'story', acceptanceCriteria: [{ text: 'Five templates' }] });
  const cost = await make({ title: 'The cost summary counts the cache twice', type: 'bug' });
  const settings = await make({ title: 'Per-project settings in a JSON' });

  for (const [path, content] of Object.entries(DOCS)) {
    const written = await api.put(`/projects/${pid}/documents/file?path=${encodeURIComponent(path)}`, { content });
    check(written.status === 200, `${path} was written (${written.status} ${JSON.stringify(written.body)})`);
  }
  const tie = async (item, path, kind) => {
    const tied = await api.post(`/work-items/${item.id}/documents`, { path, kind });
    check(tied.status === 201 || tied.status === 200, `${path} was tied to ${item.key} (${tied.status} ${JSON.stringify(tied.body)})`);
    return tied.body;
  };
  await tie(board, 'docs/specs/board.md', 'spec');
  await tie(tables, 'docs/adr/ADR-007-links.md', 'adr');
  await tie(links, 'docs/specs/links.md', 'spec');

  // The CLI's own memory: CLAUDE.md and two memory files
  const claudeMd = await api.put(`/config/instructions?project=${pid}&variant=shared`, { content: '# Agentry\n\nREST API, web UI and multi-agent orchestration around the Claude Code CLI.\n\n## The one rule\n\nThe CLI only.\n' });
  check(claudeMd.status === 200, `CLAUDE.md was written (${claudeMd.status})`);
  for (const [name, content] of [
    ['MEMORY.md', '- [Tests](tests.md) — core tests take three minutes\n'],
    ['tests.md', '---\nname: tests\ndescription: core tests take three minutes\nmetadata:\n  type: project\n---\n\nRun them under timeout 300.\n'],
  ]) {
    const put = await api.put(`/memory/${pid}/${name}`, { content });
    check(put.status === 200, `memory ${name} was written (${put.status} ${JSON.stringify(put.body)})`);
  }

  // A decision written by hand, and a closed item (the move to Done writes its entry)
  const note = await api.post(`/projects/${pid}/journal`, { kind: 'decision', text: 'Tasks carry no dates or estimates' });
  check(note.status === 201 || note.status === 200, `a journal entry was added (${note.status} ${JSON.stringify(note.body)})`);
  const moved = await api.post(`/work-items/${settings.id}/move`, { status: 'done' });
  check(moved.status === 200, `an item reached Done (${moved.status} ${JSON.stringify(moved.body)})`);

  const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
  // The server writes to the same file (the event log, the health samples): wait for its turn
  db.exec('PRAGMA busy_timeout = 10000');
  try {
    // What flow runs would have written: the role that wrote each document…
    const role = db.prepare('UPDATE work_item_links SET team_role = ?, role = ?, created_at = ? WHERE item_id = ? AND document_path = ?');
    role.run('architect', 'work', iso(60 * 48), board.id, 'docs/specs/board.md');
    role.run('architect', 'work', iso(60 * 30), tables.id, 'docs/adr/ADR-007-links.md');
    role.run('product-owner', 'refine', iso(60 * 20), links.id, 'docs/specs/links.md');

    // …three memory proposals waiting for the person…
    const propose = db.prepare(
      `INSERT INTO memory_proposals (id, project_id, target_kind, target_file, target_section, text, reason, status, proposed_by_kind, proposed_by_role, item_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'agent', ?, ?, ?)`,
    );
    propose.run(randomUUID(), pid, 'instructions', null, 'Conventions', 'Migrations are appended to the end of `MIGRATIONS`; one that exists is never edited.', 'Two tasks broke a database that way.', 'architect', tables.id, iso(40));
    propose.run(randomUUID(), pid, 'memory', 'e2e-badges.md', null, 'e2e specs read a badge text case-insensitively: the CSS upper-cases it.', 'A spec failed on it twice.', 'qa', templates.id, iso(25));
    propose.run(randomUUID(), pid, 'memory', 'tests.md', null, 'Core tests take about 3 minutes: run them with `timeout 300`.', 'A run was cut at two minutes.', 'developer', board.id, iso(20));

    // …a decision a role proposed and the person approved…
    db.prepare(
      `INSERT INTO journal_entries (id, project_id, kind, text, item_id, author_kind, author_role, approved_by_kind, document_path, created_at)
       VALUES (?, ?, 'decision', ?, ?, 'agent', 'architect', 'person', ?, ?)`,
    ).run(randomUUID(), pid, "A task's links are rows, not a JSON field", tables.id, 'docs/adr/ADR-007-links.md', iso(60 * 26));

    // …and two tasks the flow left waiting: QA passed one, and sent the other back three times
    const wait = db.prepare('UPDATE work_items SET status = ?, waiting = ?, bounces = ? WHERE id = ?');
    wait.run('in_review', 'approval', 1, templates.id);
    // The flow leaves an item that used its last bounce where verification left it, in review
    wait.run('in_review', 'bounces', 3, cost.id);
    const link = db.prepare(`INSERT INTO work_item_links (id, item_id, kind, role, team_role, created_at) VALUES (?, ?, 'chat', 'verify', 'qa', ?)`);
    link.run(randomUUID(), templates.id, iso(15));
    link.run(randomUUID(), cost.id, iso(10));
    const comment = db.prepare(`INSERT INTO work_item_comments (id, item_id, author_kind, author_role, body, created_at, updated_at) VALUES (?, ?, 'agent', 'qa', ?, ?, ?)`);
    comment.run(randomUUID(), templates.id, 'Every criterion holds: the five templates are offered and each preselects its modules.', iso(14), iso(14));
    comment.run(randomUUID(), cost.id, 'The cache is still counted twice when a chat resumes; criterion 2 asks that it is not.', iso(9), iso(9));
  } finally {
    db.close();
  }
  return { board, links, tables, templates, cost, settings };
}
