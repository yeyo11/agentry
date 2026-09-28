// "Create with AI" shows the file while the chat writes it (gap 12 of orchestration 6), against the
// fake CLI: its `stream:` step hands the structured result over as StructuredOutput deltas, as the CLI
// does, and `hold:` keeps it half-written until the spec lets it finish. Nothing is saved meanwhile,
// and "Open in the editor" waits for the whole file.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const fakeCli = true;
export const timeout = 120_000;

const KEY = 'GLOSSARY-STREAM';

export default async ({ page, api, check, dirs, fakeCli: fake }) => {
  let projectId = null;
  const release = join(dirs.workspaceDir, 'e2e-stream-release');
  try {
    const dir = join(dirs.workspaceDir, 'e2e-stream');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# e2e-stream\n');
    projectId = (await api.post('/projects/import', { path: dir, name: 'e2e-stream', template: 'software' })).body.id;
    const content = `---\nname: glossary-reviewer\ndescription: Reads each new Spanish sentence against the glossary\n---\n\n# Glossary reviewer\n\n${'- One more rule of the glossary.\n'.repeat(12)}`;
    const answer = { summary: 'One agent.', read: [{ kind: 'file', path: 'README.md' }], resources: [{ kind: 'agents', name: 'glossary-reviewer', description: 'Reviews the glossary', content, reason: 'Translations are checked by hand' }] };
    writeFileSync(fake.scripts, JSON.stringify({ [KEY]: `stream: ${JSON.stringify(answer)}\nhold: ${release}` }));

    await page.viewport(1440, 900);
    await page.goto(`/?project=${projectId}&view=resources&ai=1`, 1500);
    await page.waitFor(`return !!document.querySelector('.create-ai-description')`, { label: 'the Create with AI dialog' });
    await page.fill('.create-ai-description', `An agent that reads each new sentence against the glossary ${KEY}`);
    await page.click('.create-ai-start', undefined, 800);

    // Half the file shows while the run goes on, read-only, under the file's name
    await page.waitFor(`return document.querySelector('.create-ai-live .cm-content')?.textContent.includes('name: glossary-reviewer')`, { label: 'the file as it is written', timeout: 30_000 });
    check((await page.text('.create-ai-live .create-ai-file')) === 'glossary-reviewer.md', 'it says which file it writes');
    check(await page.eval(`return document.querySelector('.create-ai-live .cm-content')?.getAttribute('contenteditable') === 'false'`), 'the file is read-only while it is written');
    const rules = await page.eval(`return (document.querySelector('.create-ai-live .cm-content')?.textContent.match(/One more rule/g) ?? []).length`);
    check(rules < 12, `only part of it so far (${rules} of 12 rules)`);
    check(await page.eval(`return document.querySelector('.create-ai-open')?.disabled === true`), '"Open in the editor" waits for the whole file');
    check(!existsSync(join(dir, '.claude', 'agents', 'glossary-reviewer.md')), 'nothing is saved while it streams');

    // Let it finish: the proposal takes the draft's place and opens in the editor
    writeFileSync(release, '');
    await page.waitFor(`return document.querySelector('.create-ai-open')?.disabled === false`, { label: 'the whole file', timeout: 30_000 });
    check(!(await page.eval(`return !!document.querySelector('.create-ai-live')`)), 'the live section ends with the run');
  } finally {
    writeFileSync(release, '');
    writeFileSync(fake.scripts, '{}');
    if (projectId) await api.del(`/projects/${projectId}`).catch(() => {});
  }
};
