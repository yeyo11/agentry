// The decision engine's screen (Settings → Decisions): the old `?tab=supervisor` link opens it, a
// point leaves `off` only through the consent dialog with the state it would send, and the row a
// shadow call leaves shows up in History. The point asked is `notification.urgency`: a chat that
// ends raises a notification, and with a push subscription registered the engine asks the fake CLI
// (through the `cli` provider: no model, no network) whether it should interrupt. `palette.intent`
// cannot be used, it needs a low-latency provider and stays off on the CLI. Scanned with axe on a
// desktop and on a phone, in both themes, the consent dialog and the phone's consent sheet included.
import { writeFileSync } from "node:fs";

export const fakeCli = true;
export const timeout = 180_000;

const POINT = "notification.urgency";
// The endpoint is on the reserved `.invalid` domain: nothing can be delivered, as in push.spec.mjs
const SUBSCRIPTION = {
  endpoint: "https://push.invalid/e2e/decisions",
  keys: {
    p256dh: "BE2eDecisionsPublicKeyForTheSuite",
    auth: "e2eDecisionsAuth",
  },
  kinds: ["run"],
  label: "e2e decisions",
};

const theme = (page, name) =>
  page.eval(
    `localStorage.setItem('agentry-theme', ${JSON.stringify(name)}); return true`,
  );
const onPoint = (rest) => `[data-point="${POINT}"] ${rest}`;
// The point groups start folded (a person opens the ones they work on): unfold them all before a
// check reaches into a point's row
const expandGroups = async (page) => {
  const folded = await page.eval(
    `return document.querySelector('.dp-toggle-all')?.textContent?.trim() === 'Expand all'`,
  );
  if (folded) await page.click(".dp-toggle-all", "Expand all", 400);
  await page.waitFor(
    `return !!document.querySelector('[data-point="${POINT}"]')`,
    { label: "the point rows unfolded" },
  );
};
const settingsOf = async (api) => (await api.get("/decisions/settings")).body;
const modeOf = async (api) =>
  (await settingsOf(api)).points?.[POINT]?.mode ?? "off";
/** The document `PUT /decisions/settings` takes: what was read, without the key's status */
const updateOf = ({ jev, ...rest }) => rest;

/** Puts the point back to `off` without consent, through the API */
async function reset(api, mode = "off") {
  const info = (await api.get("/decisions/points")).body.find(
    (p) => p.id === POINT,
  );
  await api.put(`/decisions/points/${POINT}/consent`, {
    granted: false,
    stateVersion: info.stateVersion,
    providers: [],
  });
  const now = await settingsOf(api);
  await api.put("/decisions/settings", {
    ...updateOf(now),
    points: {
      ...now.points,
      [POINT]: { mode, threshold: info.defaultThreshold, consent: null },
    },
  });
}

export default async ({ page, api, check, fakeCli, dirs }) => {
  let chatId = null;
  const before = await settingsOf(api);
  check(
    before.provider === "cli",
    `the sandbox starts on the cli provider (${before.provider})`,
  );
  try {
    await reset(api);
    // The CLI answers the palette's one question the way `--json-schema` would
    writeFileSync(
      fakeCli.scripts,
      JSON.stringify({
        "Should this notification interrupt the person now": `json: ${JSON.stringify({ urgency: "normal" })}`,
      }),
    );
    await page.viewport(1440, 1000);
    // localStorage needs the app's origin
    await page.goto("/", 500);
    await theme(page, "dark");

    // ---- the old Supervisor link opens the Decisions tab ----
    await page.goto("/settings?tab=supervisor", 1500);
    await page.waitFor(
      `return !!document.getElementById('decisions-points-title') && !!document.getElementById('decisions-history')`,
      { label: "the Decisions tab" },
    );
    await expandGroups(page);
    const body = await page.text();
    for (const text of [
      "Decisions",
      "Engine",
      "Decision points",
      "History",
      "Propose hints for workers that look stuck",
    ]) {
      check(body.includes(text), `the Decisions tab has "${text}"`);
    }

    // ---- a point moves to shadow through the consent dialog ----
    check((await modeOf(api)) === "off", `${POINT} starts off`);
    await page.click(onPoint("[role=radio]"), "Shadow", 600);
    await page.waitFor(
      `return !!document.querySelector('[role=dialog] .dp-preview')`,
      { label: "the consent dialog with its state preview" },
    );
    const dialog = await page.text("[role=dialog]");
    check(
      dialog.includes("Before moving to shadow"),
      "the dialog asks before moving to shadow",
    );
    check(
      dialog.includes("Nothing leaves your machine"),
      "on the cli provider the dialog says nothing leaves the machine",
    );
    check(
      /state version/i.test(dialog) && /v\d+/.test(dialog),
      "the dialog says which state version is consented to",
    );
    const preview = await page.text("[role=dialog] .dp-preview");
    check(
      preview.includes("kind") &&
        preview.includes("title") &&
        preview.includes("body"),
      `the preview shows the fields the point sends (${preview.slice(0, 80)})`,
    );
    check(
      (await modeOf(api)) === "off" &&
        !(await settingsOf(api)).points?.[POINT]?.consent,
      "nothing is stored before the person agrees",
    );
    const dialogViolations = await page.axe({ include: "[role=dialog]" });
    check(
      dialogViolations.length === 0,
      `the consent dialog has accessibility violations: ${JSON.stringify(dialogViolations)}`,
    );

    await page.click("[role=dialog] button", "Consent and move to shadow", 600);
    await page.waitFor(
      `return !document.querySelector('[role=dialog] .dp-preview')`,
      { label: "the dialog closes" },
    );
    const granted = (await settingsOf(api)).points?.[POINT]?.consent;
    check(
      granted && granted.providers.includes("cli"),
      `the consent is stored for the cli (${JSON.stringify(granted)})`,
    );
    check(
      (await page.text(onPoint(".dp-consent"))).includes("Consented"),
      "the row says Consented",
    );
    check(
      (await page.eval(
        `return document.querySelector('[data-point="${POINT}"] [role=radio][aria-checked=true]')?.textContent`,
      )) === "Shadow",
      "the row shows Shadow",
    );
    await page.click(".dp-foot button.btn-primary", "Save", 800);
    await page.waitFor(
      `return document.body.innerText.includes('Decision settings saved')`,
      { label: "the settings are saved" },
    );
    check((await modeOf(api)) === "shadow", "the mode is stored as shadow");

    // ---- History lists the row the faked CLI produced ----
    check(
      (await api.post("/push/subscriptions", SUBSCRIPTION)).status === 201,
      "a push install is registered, so a notification is worth deciding on",
    );
    const started = await api.post("/chats", {
      prompt: "hello",
      cwd: dirs.workspaceDir,
    });
    check(started.status === 201, `a chat is started (${started.status})`);
    chatId = started.body.id;
    const deadline = Date.now() + 30_000;
    while (
      Date.now() < deadline &&
      !(await api.get(`/decisions?point=${POINT}`)).body?.items?.length
    )
      await new Promise((r) => setTimeout(r, 250));
    const listed = await api.get(`/decisions?point=${POINT}`);
    const row = listed.body?.items?.[0];
    check(
      row?.provider === "cli" &&
        row.mode === "shadow" &&
        row.status === "answered" &&
        row.acted === false,
      `the row is recorded (${JSON.stringify(row && { provider: row.provider, mode: row.mode, status: row.status, unavailable: row.unavailable })})`,
    );

    await page.goto("/settings?tab=decisions", 1200);
    await page.waitFor(
      `return !!document.querySelector('.dp-hist-row[data-decision]')`,
      { label: "a History row" },
    );
    await expandGroups(page);
    const historyRow = await page.text(".dp-hist-row[data-decision]");
    check(
      historyRow.includes(POINT),
      `History lists ${POINT} (${historyRow.replace(/\s+/g, " ").slice(0, 100)})`,
    );
    check(historyRow.includes("Shadow"), "the row is marked as shadow");
    await page.click(".dp-hist-row .dp-toggle", undefined, 500);
    check(
      (await page.text(".dp-answer")).includes(
        "Should this notification interrupt the person now?",
      ),
      "the row opens on the question it asked",
    );

    // An act point has no calibrated confidence on the CLI, so it cannot be active there
    const active = await page.eval(
      `return document.querySelector('[data-point="${POINT}"] [role=radio]:nth-of-type(3)')?.getAttribute('aria-disabled')`,
    );
    check(
      active === "true",
      "Active is unavailable for an act point on the cli",
    );

    // ---- axe on the desktop, both themes ----
    for (const name of ["dark", "light"]) {
      await theme(page, name);
      await page.goto("/settings?tab=decisions", 1200);
      await page.waitFor(
        `return !!document.querySelector('.dp-hist-row[data-decision]')`,
        { label: `History in ${name}` },
      );
      await expandGroups(page);
      const violations = await page.axe({ include: "[role=tabpanel]" });
      check(
        violations.length === 0,
        `[${name}] the Decisions tab has accessibility violations: ${JSON.stringify(violations)}`,
      );
    }

    // ---- the phone: no sideways scroll, axe, touch targets and the consent as a sheet, both themes ----
    await reset(api);
    await page.viewport(420, 900);
    for (const name of ["dark", "light"]) {
      await theme(page, name);
      await page.goto("/settings?tab=supervisor", 1500);
      await page.waitFor(
        `return !!document.querySelector('.dp-hist-row[data-decision]')`,
        { label: `the tab on a phone in ${name}` },
      );
      await expandGroups(page);
      const overflow = await page.eval(
        "return document.documentElement.scrollWidth - window.innerWidth",
      );
      check(
        overflow <= 1,
        `[${name}] the tab does not scroll sideways on a phone (${overflow}px)`,
      );
      const violations = await page.axe();
      check(
        violations.length === 0,
        `[${name}] the Decisions tab on a phone has accessibility violations: ${JSON.stringify(violations)}`,
      );
      const heights = await page.eval(
        `return [...document.querySelectorAll('[data-point="${POINT}"] [role=radio]')].map((b) => Math.round(b.getBoundingClientRect().height))`,
      );
      check(
        heights.length === 3 && heights.every((h) => h >= 44),
        `[${name}] the mode buttons are touch targets (${heights})`,
      );

      await page.click(onPoint("[role=radio]"), "Shadow", 600);
      await page.waitFor(
        `return !!document.querySelector('[role=dialog] .dp-preview')`,
        { label: `the consent sheet in ${name}` },
      );
      const sheet = await page.axe({ include: "[role=dialog]" });
      check(
        sheet.length === 0,
        `[${name}] the consent sheet has accessibility violations: ${JSON.stringify(sheet)}`,
      );
      await page.click("[role=dialog] button", "Cancel", 600);
      await page.waitFor(
        `return !document.querySelector('[role=dialog] .dp-preview')`,
        { label: "the sheet closes" },
      );
      check((await modeOf(api)) === "off", "cancelling leaves the point off");
    }
  } finally {
    // Leave the sandbox as it was: other specs count what it holds
    await page
      .eval(`localStorage.removeItem('agentry-theme'); return true`)
      .catch(() => {});
    await page.viewport(1440, 1000).catch(() => {});
    await api
      .request("DELETE", "/push/subscriptions", {
        endpoint: SUBSCRIPTION.endpoint,
      })
      .catch(() => {});
    if (chatId) await api.del(`/chats/${chatId}`).catch(() => {});
    await api.del("/decisions").catch(() => {});
    await reset(api, before.points?.[POINT]?.mode ?? "off").catch(() => {});
  }
};
