// Browser walk-through of the practical, plus an automated accessibility scan.
// Run with: npm run test:e2e   (set CHROME_PATH to use an installed Chrome)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");

const APP = "file://" + path.resolve(__dirname, "..", "index.html");
const AXE = require.resolve("axe-core/axe.min.js");
const SHOTS = process.env.SHOTS_DIR;

test("the practical, end to end, in local mode", async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, n + ".png"), fullPage: true });
  const flash = () => page.locator("[data-flash]").innerText();
  await page.goto(APP);

  // 3:45 pm — Kabir collects the kit.
  await page.click('nav [data-val="requests"]');
  await page.click('[data-action="open-request"][data-val="RQ-214"]');
  await page.selectOption("#kit-form select[name=who]", "Kabir Sen");
  await shot("e2e-01-kit");
  await page.click("#kit-form button[type=submit]");
  await shot("e2e-02-confirm");
  await page.check("dialog input[name=ok]");
  await page.click("dialog button[type=submit]");
  assert.match(await flash(), /Issued 3 items to Kabir Sen/);
  assert.equal(await page.locator("dialog[open]").count(), 0);

  // 7:30 pm — projector and speaker back (speaker without its cable), adapter still out.
  await page.click('[data-action="advance"]');
  await page.click('[data-action="return"][data-val="402,403,404"]');
  await page.uncheck("dialog input[name=include-404]");
  await page.fill("dialog input[name=verify-402]", "PR-04");
  await page.fill("dialog input[name=verify-403]", "SP-05");
  await page.uncheck('dialog input[name=acc-403][value="Power cable"]');
  await page.check("dialog input[name=ok]");
  await page.click("dialog button[type=submit]");
  assert.match(await page.locator("[data-dlg-error]").innerText(), /ID check failed/);
  await page.fill("dialog input[name=verify-403]", "SP-02");
  await shot("e2e-03-return");
  await page.click("dialog button[type=submit]");
  assert.match(await flash(), /PR-04 back on shelf A2; SP-02 held for inspection/);
  await page.click('form[data-loan="404"] >> xpath=ancestor::details/summary');
  await page.selectOption('form[data-loan="404"] select[name=who]', "Leela Das");
  await page.fill('form[data-loan="404"] input[name=when]', "2026-11-21T09:00");
  await page.click('form[data-loan="404"] button[type=submit]');
  assert.match(await flash(), /handover tasks/);
  await shot("e2e-04-partial");

  // 9:00 am — Meera takes over, acknowledges, closes the right slip.
  await page.click('[data-action="advance"]');
  assert.match(await flash(), /Meera Iyer has taken over/);
  await page.click('nav [data-val="dashboard"]');
  await shot("e2e-05-morning-dashboard");
  await page.click('[data-action="go"][data-val="deskbook"] >> text=Read and acknowledge');
  await page.click('[data-action="ack"]');
  assert.match(await flash(), /acknowledged/i);
  await page.click('nav [data-val="returns"]');
  await page.fill("form[data-form=return-lookup] input[name=id]", "ad-12");
  await page.press("form[data-form=return-lookup] input[name=id]", "Enter");
  assert.equal(await page.locator("dialog select[name=returnedBy]").inputValue(), "Leela Das");
  await page.fill("dialog input[name=verify-404]", "AD-12");
  await page.check("dialog input[name=ok]");
  await page.click("dialog button[type=submit]");
  assert.match(await flash(), /AD-12 back on shelf C4/);

  // Undo through an audited reversal, then redo.
  await page.click('[data-flash] [data-action="reverse"]');
  await page.fill("dialog textarea[name=reason]", "Testing reversal");
  await page.click("dialog button[type=submit]");
  assert.match(await flash(), /reversed/);
  await page.click('nav [data-val="activity"]');
  assert.ok(await page.locator("text=Reversed by").count());

  // A store manager clears the speaker after inspection.
  await page.selectOption("[data-switch-user]", "priya");
  await page.click('nav [data-val="maintenance"]');
  page.once("dialog", (d) => d.accept());
  await page.click('[data-action="ticket-release"]');
  assert.match(await flash(), /SP-02 cleared/);
  await page.click('nav [data-val="inventory"]');
  await shot("e2e-06-inventory");

  // The app itself must not have logged errors (axe's own file:// fetches below are ignored).
  assert.deepEqual(errors, []);

  // Accessibility: no serious or critical axe violations on any page.
  await page.selectOption("[data-switch-user]", "admin");
  const report = {};
  for (const key of ["dashboard", "requests", "returns", "loans", "deskbook", "inventory", "maintenance", "reports", "activity", "settings"]) {
    await page.click('nav [data-val="' + key + '"]');
    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => (await window.axe.run(document.getElementById("campus-stores"), { resultTypes: ["violations"] })).violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => v.id + ": " + v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")));
    if (res.length) report[key] = res;
  }
  assert.deepEqual(report, {});

  // Phone-sized layout renders without horizontal overflow on the main column.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('nav [data-val="dashboard"]');
  await shot("e2e-07-mobile");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false);
  await browser.close();
});

test("server mode: sign in, live sync between two desks, strict CSP", async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campus-e2e-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: "0", DATA_DIR: dir, CAMPUS_INITIAL_PASSWORD: "demo-password-1" }, stdio: ["ignore", "pipe", "inherit"] });
  const base = await new Promise((r) => srv.stdout.on("data", (d) => { const m = /(http:\/\/[\d.]+:\d+)/.exec(String(d)); if (m) r(m[1]); }));
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  const desk = async (user) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(m.text()));
    await page.goto(base);
    await page.fill("input[name=username]", user);
    await page.fill("input[name=password]", "demo-password-1");
    await page.click("form[data-form=login] button[type=submit]");
    await page.waitForSelector('nav [data-val="dashboard"]');
    return page;
  };
  try {
    const arjun = await desk("arjun");
    const meera = await desk("meera");
    await meera.click('nav [data-val="loans"]');
    assert.equal(await meera.locator("tbody tr").count(), 1);
    await arjun.click('nav [data-val="requests"]');
    await arjun.click('[data-action="open-request"][data-val="RQ-214"]');
    await arjun.selectOption("#kit-form select[name=who]", "Kabir Sen");
    await arjun.click("#kit-form button[type=submit]");
    await arjun.check("dialog input[name=ok]");
    await arjun.click("dialog button[type=submit]");
    await arjun.waitForSelector("[data-flash]:not([hidden])");
    assert.match(await arjun.locator("[data-flash]").innerText(), /Issued 3 items/);
    await meera.waitForFunction(() => document.querySelectorAll("tbody tr").length === 4, null, { timeout: 5000 });
    // Operators can't see manager-only pages or actions.
    assert.equal(await meera.locator('nav [data-val="reports"]').count(), 0);
    if (SHOTS) await meera.screenshot({ path: path.join(SHOTS, "e2e-08-server-live.png"), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => { srv.once("exit", r); srv.kill("SIGTERM"); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("guided demo runs every step, highlights each target, and Back replays", async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  try {
  await page.goto(APP);
  await page.click("[data-demo-start]");
  const total = Number((await page.locator(".cs-tour-top span").innerText()).match(/of (\d+)/)[1]);
  const seen = [];
  for (let i = 1; i <= total; i++) {
    await page.waitForFunction((n) => { const s = document.querySelector(".cs-tour-top span"); return !!s && s.textContent.startsWith("Step " + n + " of") && !document.querySelector(".cs-tour.busy"); }, i);
    await page.waitForTimeout(400);
    const title = await page.locator(".cs-tour-title").innerText();
    assert.equal(await page.locator(".cs-tour-error").count(), 0, "step " + i + " (" + title + ") errored");
    const ringShown = await page.evaluate(() => !document.querySelector(".cs-tour-ring").hidden);
    seen.push([i, title, ringShown]);
    if (SHOTS && [7, 11, 17].includes(i)) await page.screenshot({ path: path.join(SHOTS, "tour-" + String(i).padStart(2, "0") + ".png") });
    if (i === 12) {
      // Back from "Condition and accessories" replays to "Caught: wrong unit".
      await page.click("[data-tour=back]");
      await page.waitForFunction(() => { const h = document.querySelector(".cs-tour-title"); return !!h && h.textContent.startsWith("Caught") && !document.querySelector(".cs-tour.busy"); });
      assert.equal(await page.locator("[data-dlg-error]").isVisible(), true);
      await page.click("[data-tour=next]");
      await page.waitForFunction(() => { const h = document.querySelector(".cs-tour-title"); return !!h && h.textContent.startsWith("Condition") && !document.querySelector(".cs-tour.busy"); });
    }
    await page.click("[data-tour=next]");
  }
  assert.equal(await page.locator(".cs-tour").count(), 0, "tour closes at the end");
  // Every step except the intro and the closing card points at something on screen.
  const unlit = seen.filter(([i, , lit]) => i !== 1 && i !== total && !lit);
  assert.deepEqual(unlit, []);
  // The tour left the app where the story ends: the Film Society request closed.
  const closed = await page.evaluate(() => JSON.parse(localStorage.getItem("campus-stores.v3")).loans.filter((l) => l.req === "RQ-214" && l.status === "returned").length);
  assert.equal(closed, 3);
  assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
