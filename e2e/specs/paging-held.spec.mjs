// What the pages read back survive, and what they cost. Leaving the chat keeps them, cut to the cap
// on the way out; and a chat that grew past them while nobody was looking joins them again,
// instead of leaving a button that does nothing.
import { growTranscript, mark, seedTranscript } from './transcript-seed.mjs';

/** The cap on what is held back (MAX_HELD in lib/chats.ts) and the page the API serves. */
const MAX_HELD = 4000;
const PAGE = 200;
// 400 past the cap once the newest page is taken off: enough to see the cap cut, and no more to read
const TOTAL = MAX_HELD + PAGE + 400;
/** What the chat writes while nobody is looking: more than a tail read, so the newest page is read whole again. */
const GROWTH = 300;
const SESSION = 'e2e-held-0000-0000-000000000000';
const PROJECT = '-work-held';

const aboveCount = `const b=[...document.querySelectorAll('.transcript-earlier button')][0];const m=b?.textContent.match(/\\((\\d+) above\\)/);return m?Number(m[1]):0;`;
const earlierButton = `return [...document.querySelectorAll('.transcript-earlier button')].find(b=>b.textContent.includes('above'))`;
const atEnd = `const main=document.querySelector('.run-scroll');return main.scrollHeight-main.scrollTop-main.clientHeight<4`;
const shows = (m) => `return document.querySelector('.transcript')?.innerText.includes('${m}')`;
const settle = (page) => page.eval(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))));return true`);
const reads = (page, since) =>
  page.eval(`return performance.getEntriesByType('resource').filter(e=>e.startTime>${since}&&e.name.split('?')[0].endsWith('/chats/${SESSION}')).map(e=>e.name.split('?')[1]||'')`);
/** Out through the list of chats and back in, after the page has gone stale, so coming back reads its end again. */
async function leaveAndReturn(page) {
  await page.waitFor(`const a=document.querySelector('a[href="/chats"]');if(!a)return false;a.click();return true`, { label: 'the chats list' });
  await page.waitFor(`return !document.querySelector('.transcript')`, { label: 'the chat left' });
  await page.eval(`await new Promise(r=>setTimeout(r,1300));history.back();return true`);
  await page.waitFor(`return !!document.querySelector('.transcript > [data-index]')`, { label: 'the chat again' });
  await settle(page);
}

export default async ({ page, api, check, dirs }) => {
  const file = seedTranscript(dirs.configDir, PROJECT, SESSION, TOTAL);
  try {
    await page.goto(`/chats/${SESSION}`, 300);
    await page.waitFor(shows(mark(TOTAL - 1)), { label: 'the newest message is rendered' });
    // Letting go of the end takes the reader's own input: a wheel up, as a person would
    await page.eval(`document.querySelector('.run-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));return true`);
    await page.waitFor(`const main=document.querySelector('.run-scroll');main.scrollTop=0;return !document.querySelector('.transcript-earlier')`, {
      timeout: 120000,
      label: 'everything read back to the first message',
    });
    await page.waitFor(shows(mark(0)), { label: 'the first message' });

    // ---- Leaving keeps what is held, cut to the cap; coming back reads the end alone ----
    let since = await page.eval('return performance.now()');
    await leaveAndReturn(page);
    check((await page.eval(aboveCount)) === TOTAL - PAGE - MAX_HELD, `what was held comes back, the oldest pages beyond the cap let go (${await page.eval(aboveCount)} above)`);
    let read = await reads(page, since);
    check(read.length === 1 && read[0].includes('limit=50'), `coming back reads the end alone (${read.join(', ') || 'nothing'})`);
    check(await page.eval(atEnd), 'the transcript is at its end, at once');
    check(await page.eval(shows(mark(TOTAL - 1))), 'and shows the newest message');
    check((await page.eval(`return document.getElementsByTagName('*').length`)) < 3000, 'with a small DOM');

    // ---- The chat grew past what is held while nobody looked: the next pages are not thrown away ----
    growTranscript(file, SESSION, TOTAL, TOTAL + GROWTH);
    check((await api.get(`/chats/${SESSION}?limit=1`)).body.total === TOTAL + GROWTH, 'the API sees the chat grow');
    since = await page.eval('return performance.now()');
    await leaveAndReturn(page);
    await page.waitFor(atEnd, { label: 'the transcript at its end after the growth' });
    check(await page.eval(shows(mark(TOTAL + GROWTH - 1))), 'the newest message after the growth is on screen');
    // A tail read cannot meet a page 300 entries behind it: the newest page is read whole, and what
    // was held no longer reaches it, so only the newest page shows
    const grown = TOTAL + GROWTH;
    check((await page.eval(aboveCount)) === grown - PAGE, `the newest page stands alone after the chat outgrew what was held (${await page.eval(aboveCount)} above)`);
    read = await reads(page, since);
    check(read.some((q) => q.includes('limit=50')) && read.some((q) => !q.includes('limit=50') && !q.includes('before=')), `read the end, then the whole newest page (${read.join(', ')})`);
    await page.eval(`document.querySelector('.run-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));return true`);
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier, into the gap' });
    // The page lands 100 entries short of what was held: too far to join it, so it takes its place
    await page.waitFor(`return (()=>{${aboveCount}})()===${grown - 2 * PAGE}`, { label: 'the page in the gap shows, in place of what no longer joins' });
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier, again' });
    await page.waitFor(`return (()=>{${aboveCount}})()===${grown - 3 * PAGE}`, { label: 'and the next page joins onto it' });

    // ---- Grown by less than a page past what is held: one read bridges the gap and all of it is back ----
    const BRIDGE = 150;
    growTranscript(file, SESSION, grown, grown + BRIDGE);
    await leaveAndReturn(page);
    await page.waitFor(atEnd, { label: 'the transcript at its end after the second growth' });
    check((await page.eval(aboveCount)) === grown + BRIDGE - PAGE, 'the newest page stands alone again');
    await page.eval(`document.querySelector('.run-scroll').dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true}));return true`);
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier, over the gap' });
    await page.waitFor(`return (()=>{${aboveCount}})()===${grown - 3 * PAGE}`, { label: 'the page reaching into what was held brings all of it back' });
    await page.waitFor(`const main=document.querySelector('.run-scroll');main.scrollTop=0;return true`, { label: 'to the top of what is held' });
    await page.waitFor(shows(mark(grown - 3 * PAGE)), { label: 'the oldest entry held is on the page' });
    console.log(`  paging-held: ${TOTAL} seeded, ${MAX_HELD} kept across a visit, ${GROWTH} then ${BRIDGE} written behind the reader's back`);
  } finally {
    await api.del(`/chats/${SESSION}`);
  }
};
