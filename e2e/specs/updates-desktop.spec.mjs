// The Updates card inside the desktop window: download with progress, restart, the question when
// work is live, and the explanation when the app cannot update itself. Electron is not in the
// harness, so a script that runs before the app stands in for the preload's
// `window.agentryDesktop.updates`, answering the way apps/desktop/src/updater.ts does; the card,
// its parsers and its dialog are the real ones.

const CARD = '[data-testid=updates-card]';
const DESKTOP = '[data-testid=update-desktop]';
const NEXT = '999.0.0';

/** A fake updater whose first state is `initial`; what the card asks is recorded on window.__updates */
const fakeShell = (initial) => `(() => {
  const listeners = new Set();
  const updates = { state: ${JSON.stringify(initial)}, calls: [] };
  const emit = (state) => {
    updates.state = state;
    for (const listener of listeners) listener(state);
  };
  window.__updates = updates;
  window.agentryDesktop = {
    platform: 'linux',
    version: '0.0.0',
    updates: {
      state: async () => updates.state,
      onState: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      download: async () => {
        updates.calls.push({ download: true });
        emit({ status: 'downloading', version: ${JSON.stringify(NEXT)}, percent: 40 });
        // Long enough for the spec to see the progress bar
        setTimeout(() => emit({ status: 'ready', version: ${JSON.stringify(NEXT)} }), 1500);
      },
      install: async (options = {}) => {
        updates.calls.push({ install: options });
        if (options.whenIdle) return { status: 'scheduled', version: ${JSON.stringify(NEXT)} };
        if (options.force) return { status: 'restarting', version: ${JSON.stringify(NEXT)} };
        return { status: 'busy', version: ${JSON.stringify(NEXT)}, live: { working: 2, waiting: 0, running: 1 } };
      },
    },
  };
})();`;

const cardSays = (text) => `return (document.querySelector(${JSON.stringify(CARD)})?.innerText ?? '').includes(${JSON.stringify(text)})`;

export default async ({ page, api, check, releases }) => {
  const { current } = (await api.get('/system/release')).body;
  releases.set(`v${NEXT}`);
  const found = await api.post('/system/release/check');
  check(found.body?.updateAvailable === true, `the server knows of ${NEXT}: ${JSON.stringify(found.body)}`);

  try {
    // ---- An app that can update itself ----
    let remove = await page.onNewDocument(fakeShell({ status: 'available', version: NEXT }));
    try {
      await page.goto('/settings?tab=account', 1500);
      await page.waitFor(`return !!document.querySelector(${JSON.stringify(DESKTOP)})`, { label: 'the desktop branch of the card' });
      const steps = await page.eval(`return !!document.querySelector('[data-testid^=update-steps]')`);
      check(!steps, 'the desktop window gets its own button, not the commands for other installs');

      await page.click(`${DESKTOP} button`, `Download Agentry ${NEXT}`);
      const bar = await page.waitFor(
        `const bar = document.querySelector(${JSON.stringify(`${DESKTOP} [role=progressbar]`)}); return bar && { name: bar.getAttribute('aria-label'), now: bar.getAttribute('aria-valuenow') }`,
        { label: 'the download progress bar' },
      );
      check(bar.name === `Downloading Agentry ${NEXT}` && bar.now === '40', `the progress bar has a name and a value: ${JSON.stringify(bar)}`);
      const violations = await page.axe({ include: CARD });
      check(violations.length === 0, `the card passes axe while downloading: ${JSON.stringify(violations, null, 2)}`);

      // Live work: a restart asks first, and "Update when I quit" leaves it for later
      await page.waitFor(cardSays(`Restart to update to ${NEXT}`), { label: 'the restart button' });
      await page.click(`${DESKTOP} button`, `Restart to update to ${NEXT}`);
      const question = await page.waitFor(`return document.querySelector('[role=dialog]')?.innerText ?? ''`, { label: 'the live-work question' });
      check(question.includes('2 chats are working, 1 orchestration is running'), `the question says what a restart would stop: ${question}`);
      await page.click('[role=dialog] button', 'Update when I quit');
      await page.waitFor(cardSays(`Agentry ${NEXT} will be installed the next time you quit.`), { label: 'the scheduled install' });
      const gone = await page.eval(`return !document.querySelector('[role=dialog]')`);
      check(gone, 'the question closes once answered');

      const calls = await page.eval(`return window.__updates.calls`);
      check(
        JSON.stringify(calls) === JSON.stringify([{ download: true }, { install: {} }, { install: { whenIdle: true } }]),
        `the card asked the shell for a download, a restart and then an install on quit: ${JSON.stringify(calls)}`,
      );
    } finally {
      await remove();
    }

    // ---- "Restart now" goes through even with work live ----
    remove = await page.onNewDocument(fakeShell({ status: 'ready', version: NEXT }));
    try {
      await page.goto('/settings?tab=account', 1500);
      await page.click(`${DESKTOP} button`, `Restart to update to ${NEXT}`);
      await page.waitFor(`return !!document.querySelector('[role=dialog]')`, { label: 'the live-work question' });
      await page.click('[role=dialog] button', 'Restart now');
      const calls = await page.waitFor(`return window.__updates.calls.length === 2 && window.__updates.calls`, { label: 'the forced install' });
      check(JSON.stringify(calls[1]) === JSON.stringify({ install: { force: true } }), `Restart now forces the install: ${JSON.stringify(calls)}`);
    } finally {
      await remove();
    }

    // ---- An app that cannot update itself says why and links the release ----
    const message = 'This copy of Agentry was not installed from an AppImage or a .deb, so it cannot update itself.';
    remove = await page.onNewDocument(fakeShell({ status: 'unsupported', reason: 'unknown-package', message }));
    try {
      await page.goto('/settings?tab=account', 1500);
      await page.waitFor(cardSays(message), { label: "the shell's own explanation" });
      const links = await page.eval(`return [...document.querySelectorAll(${JSON.stringify(`${DESKTOP} a`)})].map((a) => a.href)`);
      check(links.includes(releases.url), `the release page is linked: ${links.join(', ')}`);
      const download = await page.eval(`return !!document.querySelector(${JSON.stringify(`${DESKTOP} button`)})`);
      check(!download, 'no Download button where the app cannot install it');
    } finally {
      await remove();
    }
  } finally {
    // Back to the version in use, so the specs after this one see no dot
    releases.set(`v${current}`);
    await api.post('/system/release/check');
  }
};
