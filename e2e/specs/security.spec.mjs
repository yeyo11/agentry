// Security tab: the token is shown once, read-only refuses writes, the access mode guards the API
// and a 401 is a sign-in screen. The suite shares one wrapper, so whatever this turns on it turns
// back off, even when an assertion fails half way.
const TOKEN_KEY = 'agentry.token';

export default async ({ page, api, check }) => {
  const authed = (token) => async (method, path, body) => {
    const res = await fetch(`${api.baseUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const panelText = () => page.text('[role=tabpanel]');
  const buttonDisabled = (label) =>
    page.eval(`const b=[...document.querySelectorAll('[role=tabpanel] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});return b?b.disabled:null`);

  await page.goto('/settings', 800);
  await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`);
  await page.goto('/settings?tab=security', 1500);
  const initial = await panelText();
  for (const heading of ['Read-only mode', 'Access', 'Token', 'Audit log']) check(initial.toLowerCase().includes(heading.toLowerCase()), `the security tab has a "${heading}" card`);
  check(initial.toLowerCase().includes('open'), 'the unguarded mode is said in words, not only shown');

  // A mode that would lock everyone out is named before the click, not after it
  await page.click('[role=radio]', 'Token');
  check((await panelText()).includes('Set a token below before turning token authentication on'), 'token mode explains it needs a token first');
  check((await buttonDisabled('Save access')) === true, 'token mode cannot be saved without a token');

  // The token is generated, shown once, and never comes back from the API
  await page.click('button', 'Generate token', 800);
  await page.waitFor(`return !!document.querySelector('[data-testid=new-token]')`, { label: 'the generated token' });
  const token = await page.eval(`return document.querySelector('[data-testid=new-token]').textContent.trim()`);
  check(token.length >= 32, 'a generated token is long enough to be a secret');
  check((await panelText()).includes('Copy this token now'), 'the panel says the token is shown only once');
  const config = await api.get('/security/auth');
  check(config.body.tokenSet === true, 'the API reports that a token is set');
  check(!JSON.stringify(config.body).includes(token), 'the configuration never carries the token');
  await page.click('button', 'I have copied it', 500);
  check(!(await page.eval(`return !!document.querySelector('[data-testid=new-token]')`)), 'the token is gone once it is acknowledged');
  await page.goto('/settings?tab=security', 1500);
  check(!(await page.text('body')).includes(token), 'after a reload the token is nowhere on the page');

  // Read-only: the switch flips it, a write is refused with 405, the switch flips it back
  await page.click('[role=tabpanel] [role=switch]', undefined, 900);
  try {
    check((await api.get('/security/auth')).body.readOnly === true, 'the switch turned read-only on');
    check((await panelText()).toLowerCase().includes('read-only'), 'read-only is said in words');
    const refused = await api.post('/projects', { name: 'e2e-read-only' });
    check(refused.status === 405, `a write is refused in read-only mode (got ${refused.status})`);
    await page.click('[role=tabpanel] [role=switch]', undefined, 900);
    check((await api.get('/security/auth')).body.readOnly === false, 'the same switch turned it off again');
  } finally {
    // The switch itself is exempt from read-only, so this always gets through
    await api.put('/security/auth', { readOnly: false });
  }
  const allowed = await api.post('/projects', { name: 'e2e-read-only' });
  check(allowed.status < 300, `writes work again once it is off (got ${allowed.status})`);
  if (allowed.body?.id) await api.del(`/projects/${encodeURIComponent(allowed.body.id)}`);

  try {
    // Token mode: asks before it locks the door, and this browser keeps working because it holds the token
    await page.goto('/settings?tab=security', 1500);
    await page.click('[role=radio]', 'Token');
    await page.click('button', 'Save access', 600);
    await page.waitFor(`return !!document.querySelector('[role=dialog],[role=alertdialog]')`, { label: 'the lock-out confirmation' });
    await page.click('[role=dialog] button, [role=alertdialog] button', 'Turn it on', 1500);
    check((await api.get('/overview')).status === 401, 'a request without the credential is refused');
    check((await authed(token)('GET', '/overview')).status === 200, 'the token is accepted');
    await page.goto('/settings?tab=security', 1800);
    check((await panelText()).includes('Audit log'), 'this browser is still signed in after turning the guard on');

    // The audit log lists the writes, filterable by path, and records who made them
    await page.fill('input[type=search]', '/security');
    await page.waitFor(`const t=document.querySelector('[role=tabpanel] table');return !!t&&t.textContent.includes('/api/security/auth')`, { label: 'the audit rows for /security' });
    const rows = await page.text('[role=tabpanel] table');
    check(rows.includes('PUT') && rows.includes('token:'), 'the audit log names the method and the token that made the write');
    check(/done/.test(rows), 'a result is said in words as well as a status code');
    await page.fill('input[type=search]', 'zz-no-such-path');
    await page.waitFor(`return document.querySelector('[role=tabpanel]').textContent.includes('No entry for that path')`, { label: 'an empty filter result' });

    // A 401 is a screen that says what to do; a wrong token fails in the form, the right one returns the app
    await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`);
    await page.goto('/', 1500);
    await page.waitFor(`return !!document.querySelector('.signin')`, { label: 'the sign-in screen' });
    check((await page.text('.signin')).includes('This wrapper asks for a credential'), 'a 401 shows the sign-in screen, not a blank page');
    await page.fill('.signin input[type=password]', 'not-the-token-not-the-token');
    await page.click('.signin button[type=submit]', undefined, 1200);
    check((await page.text('.signin')).includes('That credential was not accepted'), 'a wrong token is refused in the form');
    await page.fill('.signin input[type=password]', token);
    await page.click('.signin button[type=submit]', undefined, 1500);
    await page.waitFor(`return !document.querySelector('.signin')`, { label: 'the app after signing in' });
  } finally {
    // The rest of the suite runs against this wrapper with no credential
    const guarded = authed(token);
    await guarded('PUT', '/security/auth', { mode: 'none', readOnly: false });
    await guarded('DELETE', '/security/token');
    await page.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); return true`).catch(() => {});
  }
  const restored = await api.get('/security/auth');
  check(restored.status === 200 && restored.body.mode === 'none' && !restored.body.tokenSet, 'the wrapper is left open and without a token');
};
