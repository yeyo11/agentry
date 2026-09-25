// Long transcripts: paged by the API and windowed in the UI. A synthetic 2000-entry session is
// seeded into the isolated config dir; every entry carries a marker (m0000…m1999) in its visible
// text, so the spec can tell which row of the whole transcript is on screen.
import { mark, seedTranscript } from './transcript-seed.mjs';

const TOTAL = 2000;
const SESSION = 'e2e-paging-0000-0000-000000000000';
const PROJECT = '-work-paging';

/**
 * The marker of the first row whose top is inside the viewport, and where that top sits. A step
 * folds its tool calls away, and with them the marker they carry: the first row that says which
 * one it is is the one this can follow.
 */
const READING = `const main=document.querySelector('.run-scroll');const top=main.getBoundingClientRect().top;
  const rows=[...document.querySelectorAll('.transcript > [data-index]')].filter(r=>r.getBoundingClientRect().top>=top);
  const row=rows.find(r=>/\\bm(\\d{4})\\b/.test(r.innerText));
  const m=row?.innerText.match(/\\bm(\\d{4})\\b/);
  return m?{mark:m[0],offset:row.getBoundingClientRect().top-top}:null;`;
const offsetOf = (m) =>
  `const main=document.querySelector('.run-scroll');const row=[...document.querySelectorAll('.transcript > [data-index]')].find(r=>new RegExp('\\\\b${m}\\\\b').test(r.innerText));` +
  `return row?row.getBoundingClientRect().top-main.getBoundingClientRect().top:null;`;
const earlierButton = `return [...document.querySelectorAll('.transcript-earlier button')].find(b=>b.textContent.includes('above'))`;
const aboveCount = `const b=[...document.querySelectorAll('.transcript-earlier button')][0];const m=b?.textContent.match(/\\((\\d+) above\\)/);return m?Number(m[1]):0;`;
const nodes = `return document.getElementsByTagName('*').length`;
// Waits for layout and the virtualizer's measurements to land before reading positions
const settle = (page) => page.eval(`await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))));return true`);

export default async ({ page, api, check, dirs }) => {
  seedTranscript(dirs.configDir, PROJECT, SESSION, TOTAL);

  try {
    // ---- API: pages carry their place in the whole transcript and join without gaps ----
    const newest = (await api.get(`/chats/${SESSION}`)).body;
    check(newest.total === TOTAL, `total is ${TOTAL} (got ${newest.total})`);
    check(newest.entries.length === 200 && newest.from === TOTAL - 200, `the default page is the newest 200 (from ${newest.from}, ${newest.entries.length})`);
    check(newest.entries.at(-1).uuid === `${SESSION}-${mark(TOTAL - 1)}`, 'the newest page ends on the last entry');

    const limited = (await api.get(`/chats/${SESSION}?limit=50`)).body;
    check(limited.entries.length === 50 && limited.from === TOTAL - 50, 'limit sizes the newest page');
    const capped = (await api.get(`/chats/${SESSION}?limit=100000`)).body;
    check(capped.entries.length === 1000 && capped.from === TOTAL - 1000, 'a huge limit is capped at the page maximum');

    // Walk the whole transcript back with an odd page size, so the last page is a partial one
    const uuids = [];
    let page_ = (await api.get(`/chats/${SESSION}?limit=333`)).body;
    uuids.unshift(...page_.entries.map((e) => e.uuid));
    while (page_.from > 0) {
      const before = page_.from;
      page_ = (await api.get(`/chats/${SESSION}?limit=333&before=${before}`)).body;
      check(page_.total === TOTAL, 'every page reports the same total');
      check(page_.from + page_.entries.length === before, `the page before ${before} ends right at it (from ${page_.from}, ${page_.entries.length})`);
      uuids.unshift(...page_.entries.map((e) => e.uuid));
    }
    check(uuids.length === TOTAL && uuids.every((u, i) => u === `${SESSION}-${mark(i)}`), 'the pages join into the whole transcript, in order');
    check((await api.get(`/chats/${SESSION}?before=0`)).body.entries.length === 0, 'nothing comes before the first entry');

    // ---- UI: lands on the newest message with a small DOM ----
    await page.goto(`/chats/${SESSION}`, 300);
    await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('${mark(TOTAL - 1)}')`, { label: 'the newest message is rendered' });
    await page.waitFor(
      `const main=document.querySelector('.run-scroll');return main.scrollHeight-main.scrollTop-main.clientHeight<4`,
      { label: 'the transcript sits at its bottom' },
    );
    const landed = await page.eval(
      `const main=document.querySelector('.run-scroll');const row=[...document.querySelectorAll('.transcript > [data-index]')].find(r=>r.innerText.includes('${mark(TOTAL - 1)}'));` +
        `const r=row.getBoundingClientRect(),v=main.getBoundingClientRect();return r.bottom>v.top&&r.top<v.bottom`,
    );
    check(landed, 'the newest message is inside the viewport');
    const landedNodes = await page.eval(nodes);
    check(landedNodes < 3000, `the windowed chat page stays small (${landedNodes} nodes)`);
    const aboveOnLanding = await page.eval(aboveCount);
    check(aboveOnLanding === TOTAL - 200, `the earlier-messages button counts what is above (${aboveOnLanding})`);

    // Following the bottom stops as soon as the reader scrolls away from it
    // A wheel going up is what lets go of the end: a scrollTop written on its own is not the reader
    await page.eval(`const main=document.querySelector('.run-scroll');main.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));main.scrollTop=main.scrollHeight-main.clientHeight-1500;return true`);
    await settle(page);

    // ---- Load earlier: the page grows above, and the row being read does not move ----
    const reading = await page.waitFor(READING, { label: 'a row in the viewport' });
    // Clicked in place: the driver's click would scroll the button into view first
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier' });
    await page.waitFor(`return (()=>{${aboveCount}})()===${TOTAL - 400}`, { label: 'the previous page is loaded' });
    await settle(page);
    const after = await page.eval(offsetOf(reading.mark));
    check(after !== null && Math.abs(after - reading.offset) <= 4, `${reading.mark} stays put across Load earlier (${reading.offset.toFixed(1)} → ${after?.toFixed(1)})`);

    // ---- Reaching the top loads the page before it, again without moving what is read ----
    // The load starts the moment the top is reached, so the page it asks for is held back until
    // the row being read has been located; otherwise it could land before the first reading.
    await page.eval(
      `window.__held=new Promise(r=>window.__release=r);const f=window.fetch;window.__fetch=f;` +
        `window.fetch=async(...a)=>{if(String(a[0] instanceof Request?a[0].url:a[0]).includes('before='))await window.__held;return f(...a)};return true`,
    );
    await page.eval(`const main=document.querySelector('.run-scroll');main.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));main.scrollTop=0;return true`);
    await settle(page);
    const top = await page.waitFor(READING, { label: 'a row at the top' });
    check(top.mark === mark(TOTAL - 400), `the first row held is at the top before the page arrives (${top.mark})`);
    await page.eval(`window.__release();window.fetch=window.__fetch;return true`);
    await page.waitFor(`return (()=>{${aboveCount}})()===${TOTAL - 600}`, { label: 'reaching the top loads the previous page' });
    await settle(page);
    const topAfter = await page.eval(offsetOf(top.mark));
    check(topAfter !== null && Math.abs(topAfter - top.offset) <= 4, `${top.mark} stays put when the top loads more (${top.offset.toFixed(1)} → ${topAfter?.toFixed(1)})`);

    // ---- A page that does not come says so where it would have gone, and can be asked for again ----
    await page.eval(
      `const f=window.fetch;window.__fetch=f;window.__fail=true;` +
        `window.fetch=async(...a)=>{const u=String(a[0] instanceof Request?a[0].url:a[0]);` +
        `if(window.__fail&&u.includes('before='))return new Response(JSON.stringify({error:'the disk is gone'}),{status:500,headers:{'content-type':'application/json'}});` +
        `return f(...a)};return true`,
    );
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier, refused' });
    await page.waitFor(`return document.querySelector('.transcript-earlier [role=alert]')?.textContent.includes('the disk is gone')`, { label: 'the refusal shows above the transcript' });
    check((await page.eval(aboveCount)) === TOTAL - 600, 'what was held stays held through a refusal');
    await page.eval(`window.__fail=false;return true`);
    await page.waitFor(`const b=(()=>{${earlierButton}})();if(!b)return false;b.click();return true`, { label: 'Load earlier, again' });
    await page.waitFor(`return (()=>{${aboveCount}})()===${TOTAL - 800}&&!document.querySelector('.transcript-earlier [role=alert]')`, { label: 'the next ask brings the page and takes the refusal down' });
    await page.eval(`window.fetch=window.__fetch;return true`);

    // ---- Keep going up: the first message eventually shows, and the DOM stays small ----
    await page.waitFor(
      `const main=document.querySelector('.run-scroll');main.scrollTop=0;return document.querySelector('.transcript').innerText.includes('${mark(0)}')`,
      { timeout: 60000, label: 'the first message after scrolling to the very top' },
    );
    check(!(await page.eval(`return !!(()=>{${earlierButton}})()`)), 'nothing is left to load above the first message');
    const fullNodes = await page.eval(nodes);
    check(fullNodes < 3000, `the DOM stays small with the whole transcript held (${fullNodes} nodes)`);

    // ---- Leaving and coming back keeps what was read back; only the end is read again ----
    const left = await page.eval('return performance.now()');
    await page.waitFor(`const a=document.querySelector('a[href="/chats"]');if(!a)return false;a.click();return true`, { label: 'the chats list' });
    await page.waitFor(`return !document.querySelector('.transcript')`, { label: 'the chat left' });
    await page.eval('history.back();return true');
    await page.waitFor(`return document.querySelector('.transcript')?.innerText.includes('${mark(TOTAL - 1)}')`, { label: 'the chat again' });
    await settle(page);
    check(!(await page.eval(`return !!(()=>{${earlierButton}})()`)), 'everything read back is still held after coming back');
    const reads = await page.eval(
      `return performance.getEntriesByType('resource').filter(e=>e.startTime>${left}&&e.name.split('?')[0].endsWith('/chats/${SESSION}')).map(e=>e.name.split('?')[1]||'')`,
    );
    check(reads.length === 1 && reads[0].includes('limit=50'), `coming back reads the end alone (${reads.join(', ') || 'nothing'})`);
    check((await page.eval(nodes)) < 3000, 'and the DOM is still small');

    // ---- Typing into the message box stays responsive with the whole transcript held ----
    // Nothing holds the seeded chat, so it is resumable and the box is there from the start
    await page.eval(`const main=document.querySelector('.run-scroll');main.scrollTop=main.scrollHeight;return true`);
    await settle(page);
    await page.focus('textarea[placeholder^="Send a message"]');
    // Without support the observer would see nothing and the check below would pass vacuously
    check(await page.eval(`return PerformanceObserver.supportedEntryTypes.includes('longtask')`), 'the browser reports long tasks');
    await page.eval(
      `window.__longTasks=[];new PerformanceObserver(l=>window.__longTasks.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask'});return true`,
    );
    for (const ch of 'Keep going with the parser fix') await page.type(ch);
    await settle(page);
    const typed = await page.eval(`return document.querySelector('textarea[placeholder^="Send a message"]').value`);
    check(typed === 'Keep going with the parser fix', `the textarea took every keystroke (${JSON.stringify(typed)})`);
    const longTasks = await page.eval(`return window.__longTasks.filter(d=>d>50)`);
    check(longTasks.length === 0, `no long tasks while typing (${longTasks.map((d) => `${Math.round(d)}ms`).join(', ')})`);
    console.log(
      `  paging: ${landedNodes} nodes on landing, ${fullNodes} with all ${TOTAL} held; ` +
        `${reading.mark} ${reading.offset.toFixed(1)}→${after.toFixed(1)}px, ${top.mark} ${top.offset.toFixed(1)}→${topAfter.toFixed(1)}px`,
    );
    await page.shot('paging-session');
  } finally {
    // Later specs count the seeded chats
    await api.del(`/chats/${SESSION}`);
  }
};
