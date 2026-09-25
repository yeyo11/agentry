// Typing `/` as the first character of a message offers the slash commands the CLI reported for the
// chat's directory; the arrow keys move through them, Tab or Enter picks one, Escape lets it be.
export const fakeCli = true;

const MENU = '.slash-menu [role=option]';
const options = `return [...document.querySelectorAll(${JSON.stringify(MENU)})].map((o) => o.innerText.trim().split('\\n')[0])`;
const highlighted = `return document.querySelector(${JSON.stringify(`${MENU}[data-highlighted]`)})?.innerText.trim().split('\\n')[0] ?? null`;

export default async ({ page, api, dirs, check }) => {
  const created = await api.post('/chats', { prompt: 'hello', cwd: dirs.workspaceDir });
  check(created.status === 201, `the chat was created (${created.status})`);
  const id = created.body.id;
  try {
    for (let i = 0; i < 40; i++) {
      if ((await api.get(`/chats/${id}`)).body.chat?.environment?.slashCommands?.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.goto(`/chats/${id}`, 1200);
    await page.focus('main textarea');
    await page.type('/co');
    await page.waitFor(`return document.querySelectorAll(${JSON.stringify(MENU)}).length > 0`, { label: 'the command list' });
    check(JSON.stringify(await page.eval(options)) === JSON.stringify(['/compact', '/context', '/cost']), `the list holds what matches /co (${await page.eval(options)})`);
    check((await page.eval(highlighted)) === '/compact', 'the first match is highlighted');
    await page.key('ArrowDown');
    check((await page.eval(highlighted)) === '/context', 'ArrowDown moves the highlight');
    await page.key('Tab');
    check((await page.eval(`return document.querySelector('main textarea').value`)) === '/context ', 'Tab puts the command in the box');
    check((await page.eval(`return document.querySelectorAll(${JSON.stringify(MENU)}).length`)) === 0, 'the list closes once a command is picked');

    await page.fill('main textarea', '');
    await page.type('/re');
    await page.waitFor(`return document.querySelectorAll(${JSON.stringify(MENU)}).length === 1`, { label: 'the one match for /re' });
    await page.key('Escape');
    check((await page.eval(`return document.querySelectorAll(${JSON.stringify(MENU)}).length`)) === 0, 'Escape closes the list');
    check((await page.eval(`return document.querySelector('main textarea').value`)) === '/re', 'Escape leaves the text as it was');

    // A new chat offers what the last chat in its directory was given
    await page.goto(`/chats/new?cwd=${encodeURIComponent(dirs.workspaceDir)}`, 1200);
    await page.focus('main textarea');
    await page.type('/');
    await page.waitFor(`return document.querySelectorAll(${JSON.stringify(MENU)}).length === 4`, { label: 'every command on New chat' });
    await page.shot('slash-menu');
  } finally {
    await api.post(`/chats/${id}/stop`);
    for (let i = 0; i < 40; i++) {
      if ((await api.del(`/chats/${id}`)).status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};
