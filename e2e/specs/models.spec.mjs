// The models a person may pick. Agentry keeps no list of its own: it reads the options the CLI
// caches in its own state file, which the CLI has already filtered by what the account's
// subscription allows, so a model added to a plan shows up without a release here.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

export default async ({ page, api, check, dirs }) => {
  writeFileSync(
    join(dirs.configDir, '.claude.json'),
    JSON.stringify({
      additionalModelOptionsCache: [
        { value: 'claude-e2e-5[1m]', label: 'E2E', description: 'The one this account may run' },
        { value: 'cc-update-required-1', label: 'Later (disabled)', description: 'Update the CLI to use it', disabled: true },
      ],
    }),
  );

  // The overview is served from a reading kept for a while, so the file lands on the one after it
  let models = [];
  for (let i = 0; i < 20 && !models.some((m) => m.value === 'claude-e2e-5[1m]'); i++) {
    await page.sleep(500);
    models = (await api.get('/overview')).body?.system?.models ?? [];
  }
  check(
    ALIASES.every((alias) => models.some((m) => m.value === alias)),
    'the aliases the CLI always takes are offered',
  );
  const added = models.find((m) => m.value === 'claude-e2e-5[1m]');
  check(added?.label === 'E2E' && added?.description === 'The one this account may run', "what the account adds comes with the CLI's own name and line for it");
  check(models.find((m) => m.value === 'cc-update-required-1')?.disabled === true, 'one the CLI cannot run is reported as disabled');

  await page.goto('/chats/new', 1500);
  await page.click('.composer-status', undefined, 500);
  await page.eval(`const i=[...document.querySelectorAll('input')].find(i=>/model/i.test(i.getAttribute('aria-label')||''));if(!i)return false;i.focus();i.click();return true;`);
  await page.sleep(400);
  const shown = await page.eval(`return [...document.querySelectorAll('[role=option]')].map(o=>o.innerText.replace(/\\s+/g,' ').trim())`);
  check(
    shown.some((option) => option.includes('E2E')),
    'the picker offers what the CLI offers',
  );
  check(!shown.some((option) => option.includes('Later')), 'a model nobody can pick is not offered');
};
