// A failed flow run everywhere the item shows a run (decision 8 of the ecosystem design review,
// reference screens DesktopTarea, MobileTareaActividad, DesktopChatFlujo and MobileChatFlujo): QA's
// verification of an item was cut off by restarts, the person retried it and the retry passed. The
// item's links name each run by its role and stage, its activity tells the failure in words drawn
// from the run and the retry as history, and the failed run's chat heads itself with the item it was
// for and a banner saying why, with what the retry did. The runs are seeded in the database, as
// team.spec does: the flow is never switched on, so nothing starts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const timeout = 180_000;

const FAILED = 'e2e-runs-failed-0000-0000-000000000001';
const PASSED = 'e2e-runs-passed-0000-0000-000000000002';
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** A chat of the project's directory, as the CLI would have written it. */
function seedChat(configDir, cwd, id, prompt, answer, minutes) {
  const dir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const base = { cwd, version: '2.1.0', sessionId: id };
  const lines = [
    { ...base, type: 'user', uuid: `${id}-1`, timestamp: ago(minutes), message: { role: 'user', content: prompt } },
    { ...base, type: 'assistant', uuid: `${id}-2`, timestamp: ago(minutes - 1), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: answer }] } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

export default async ({ page, api, check, dirs }) => {
  let projectId = null;
  try {
    const dir = join(dirs.workspaceDir, 'e2e-item-runs');
    mkdirSync(dir, { recursive: true });
    const imported = await api.post('/projects/import', { path: dir, name: 'e2e-item-runs', template: 'software' });
    check(imported.status === 201, `a software project was imported (${imported.status})`);
    projectId = imported.body.id;
    await api.post(`/projects/${projectId}/team/from-template`, {});
    const item = (await api.post(`/projects/${projectId}/work-items`, { title: 'Project templates', acceptanceCriteria: [{ text: 'Five templates' }] })).body;
    await api.post(`/work-items/${item.id}/move`, { status: 'in_review' });

    seedChat(dirs.configDir, dir, FAILED, `QA · ${item.key}`, 'Criteria 1 to 3 hold; on to 4.', 1200);
    seedChat(dirs.configDir, dir, PASSED, `QA · ${item.key}`, 'Every criterion holds.', 20);
    const db = new DatabaseSync(join(dirs.dataDir, 'wrapper.db'));
    db.exec('PRAGMA busy_timeout = 15000');
    const link = db.prepare("INSERT INTO work_item_links (id, item_id, kind, role, chat_id, created_at, team_role) VALUES (?, ?, 'chat', 'verify', ?, ?, 'qa')");
    link.run('e2e-runs-link-1', item.id, FAILED, ago(1200));
    link.run('e2e-runs-link-2', item.id, PASSED, ago(20));
    const run = db.prepare(
      "INSERT INTO flow_runs (id, project_id, item_id, role, agent, model, stage, column_name, state, chat_id, outcome, error, cause, retry_of, restarts, queued_at, started_at, ended_at) VALUES (?, ?, ?, 'qa', 'qa', 'sonnet', 'verify', 'in_review', 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    run.run('e2e-runs-failed', projectId, item.id, FAILED, 'failed', 'cut off by a restart (restarts: 2 of 2)', 'restarts', null, 2, ago(1200), ago(1200), ago(1195));
    run.run('e2e-runs-passed', projectId, item.id, PASSED, 'passed', null, null, 'e2e-runs-failed', 0, ago(20), ago(20), ago(15));
    // The comment the core writes on a failure, in English: the page draws it from the run instead
    db.prepare(
      "INSERT INTO work_item_comments (id, item_id, author_kind, author_role, source_kind, source_chat_id, body, created_at, updated_at) VALUES ('e2e-runs-comment', ?, 'agent', 'qa', 'chat', ?, 'This verification run failed and moved nothing: cut off by a restart (restarts: 2 of 2).', ?, ?)",
    ).run(item.id, FAILED, ago(1195), ago(1195));
    db.close();

    // ---- the item: its links and its activity ----
    await page.viewport(1440, 1024);
    await page.goto(`/tasks/${item.key}`, 1500);
    await page.waitFor(`return document.querySelectorAll('.work-link-row.is-run').length === 2`, { label: "both runs' links" });
    const links = await page.text('.work-links');
    check(links.includes(`QA verifies ${item.key}`), `each run is named by its role and stage (${links})`);
    const failedRow = await page.eval(`return [...document.querySelectorAll('.work-link-row.is-run')].find((r) => r.querySelector('.badge-bad'))?.textContent ?? ''`);
    check(failedRow.includes('failed') && failedRow.includes('It was cut off 3 times: Agentry restarted while it verified it.'), `the failed run says why, in words (${failedRow})`);
    check(failedRow.includes('cut off by a restart (restarts: 2 of 2)'), 'the raw error under the worded reason');
    check(await page.eval(`return !!document.querySelector('.work-link-row.is-run .work-link-raw.mono')`), 'the raw error is in mono');
    check(await page.eval(`return !!document.querySelector('.work-link-row.is-run .role-avatar')`), "a run's link leads with its role's squircle");

    const activity = await page.text('.workitem-activity');
    check(!activity.includes('moved nothing'), "the core's English comment is not printed");
    check(activity.includes('This verification failed and did not move the task.') && activity.includes('The task stays in In review.'), `the failure is told from the run (${activity.slice(0, 400)})`);
    check(activity.includes('Verification retried'), 'the retry is part of the history');
    check(!/\bagent\b/.test(activity), 'no repeated "agent" badge on a role\'s comment');
    const seeChat = await page.eval(`return document.querySelector('.workitem-activity .comment-run-chat')?.getAttribute('href')`);
    check(seeChat === `/chats/${FAILED}`, `"See the chat" opens the failed run's chat (${seeChat})`);

    // ---- the failed run's chat: the row names the step, the banner says why and what the retry did ----
    await page.goto(`/chats/${FAILED}`, 1500);
    await page.waitFor(`return !!document.querySelector('.chat-run-failed')`, { label: 'the failure banner', timeout: 30_000 });
    const row = await page.text('.chat-part-of-item');
    check(row.includes(`Verification of ${item.key}`) && row.includes('Project templates'), `the row names the step and the item (${row})`);
    check(await page.eval(`return !!document.querySelector('.chat-part-of-item.is-flow > .role-avatar')`), "the row leads with QA's squircle");
    const banner = await page.text('.chat-run-failed');
    check(banner.includes('This verification failed and did not move the task.'), `the banner leads with what happened (${banner})`);
    check(banner.includes('cut off by a restart (restarts: 2 of 2)'), 'with the raw text under it');
    check(banner.includes('Retried:') && banner.includes('passed'), 'and what the retry did');
    const open = await page.eval(`return [...document.querySelectorAll('.chat-run-failed-acts a')].map((a) => a.getAttribute('href'))`);
    check(open.includes(`/chats/${PASSED}`) && open.includes(`/tasks/${item.key}`), `the retry's chat and the item are one press away (${JSON.stringify(open)})`);
    check(await page.eval(`return !document.querySelector('.chat-run-failed-retry')`), 'a run retried once offers no second retry');

    // ---- on a phone: the chat's button is 44 px and full width; the row above already opens the item ----
    await page.viewport(390, 844);
    await page.goto(`/chats/${FAILED}`, 1500);
    await page.waitFor(`return !!document.querySelector('.chat-run-failed')`, { label: 'the banner on a phone', timeout: 30_000 });
    const button = await page.eval(`const b = document.querySelector('.chat-run-failed-acts a[href^="/chats/"]').getBoundingClientRect(); return [b.width, b.height]`);
    check(button[1] >= 44 && button[0] > 250, `the retry's chat is a 44 px, full-width target (${button})`);
    check(await page.eval(`return getComputedStyle(document.querySelector('.chat-run-failed-quiet')).display === 'none'`), 'the item is opened from the row');

    await page.goto(`/tasks/${item.key}`, 1500);
    await page.click('.workitem-layout.is-phone [role=radio]', 'Activity', 600);
    await page.waitFor(`return !!document.querySelector('.workitem-activity .comment-run-chat')`, { label: 'the activity on a phone' });
    const target = await page.eval(`return document.querySelector('.workitem-activity .comment-run-chat').getBoundingClientRect().height`);
    check(target >= 44, `"See the chat" is a 44 px target on a phone (${target})`);
  } finally {
    await page.viewport(1440, 900);
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
