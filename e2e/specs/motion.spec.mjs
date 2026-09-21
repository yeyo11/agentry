// Motion is a preference, and the whole point of it is that it is in force before anything has had
// a chance to move: the level is stamped on <html> at import time, the way the theme is. The
// control that changes it lives in Settings → Appearance; what is checked here is the mechanism
// under it, and that the stylesheet — not each component — is what stops the loops.

export default async ({ page, check }) => {
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'everything moves by default');
  check((await page.eval(`return document.documentElement.dataset.hidden`)) === 'false', 'a tab being looked at is marked as such');

  // What is stored is in force from the first paint, not after a flash of movement
  await page.eval(`localStorage.setItem('agentry-motion', 'subtle');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'subtle', 'the stored level is in force');

  // At `subtle` nothing repeats, and it holds for anything the page adds later
  const looping = await page.eval(`
    const el = document.createElement('div');
    el.className = 'live-rail';
    document.body.append(el);
    const before = getComputedStyle(el, '::before');
    const value = { name: before.animationName, count: before.animationIterationCount };
    el.remove();
    return value;
  `);
  check(looping.name === 'none' || looping.count === '1', `a live rail does not loop at subtle (${looping.name}, ${looping.count})`);

  await page.eval(`localStorage.setItem('agentry-motion', 'off');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'off', 'nothing moves at off');

  // A value nobody wrote is not obeyed
  await page.eval(`localStorage.setItem('agentry-motion', 'sparkly');`);
  await page.goto('/', 1200);
  check((await page.eval(`return document.documentElement.dataset.motion`)) === 'full', 'a stored level that is not one falls back to full');
};
