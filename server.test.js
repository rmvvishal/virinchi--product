// Starts the real server on a free port with a throwaway data folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PW = "test-password-123";
let proc, base, dir;

function start(port = 0) {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir, CAMPUS_INITIAL_PASSWORD: PW },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d) => {
      const m = /http:\/\/([\d.]+):(\d+)/.exec(String(d));
      if (m) resolve("http://" + m[1] + ":" + m[2]);
    });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (c) => c && reject(new Error("server exited " + c)));
  });
}
const stop = () => new Promise((r) => { proc.once("exit", r); proc.kill("SIGTERM"); });

async function login(user) {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Campus-Stores": "1" }, body: JSON.stringify({ username: user, password: PW }) });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const op = (cookie, type, payload, id) =>
  fetch(base + "/api/ops", { method: "POST", headers: { "Content-Type": "application/json", "X-Campus-Stores": "1", cookie }, body: JSON.stringify({ type, payload, id }) });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "campus-"));
  base = await start();
});
test.after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("health, static files and security headers", async () => {
  const h = await (await fetch(base + "/api/health")).json();
  assert.equal(h.app, "campus-stores");
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + "/server.js")).status, 404);
  assert.equal((await fetch(base + "/data/users.json")).status, 404);
  const users = JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
  assert.ok(users.every((u) => u.hash && u.salt && !("password" in u)));
});

test("sign-in, CSRF guard, roles enforced on the server", async () => {
  assert.equal((await fetch(base + "/api/session")).status, 401);
  const bad = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Campus-Stores": "1" }, body: JSON.stringify({ username: "arjun", password: "nope" }) });
  assert.equal(bad.status, 401);
  const arjun = await login("arjun");
  const noHeader = await fetch(base + "/api/ops", { method: "POST", headers: { "Content-Type": "application/json", cookie: arjun }, body: JSON.stringify({ type: "note", payload: { text: "x" } }) });
  assert.equal(noHeader.status, 403);
  const approve = await op(arjun, "request.approve", { id: "RQ-221" });
  assert.equal(approve.status, 403);
  const priya = await login("priya");
  assert.equal((await op(priya, "request.approve", { id: "RQ-221" })).status, 200);
});

test("two desks racing for the same unit: exactly one wins; duplicates are ignored", async () => {
  const a = await login("arjun");
  const b = await login("meera");
  const s = (await (await fetch(base + "/api/session", { headers: { cookie: a } })).json()).state;
  const due = s.requests.find((r) => r.id === "RQ-214").due;
  const [r1, r2] = await Promise.all([
    op(a, "issue", { req: "RQ-214", units: ["PR-04"], borrower: "Kabir Sen", due }, "a-1"),
    op(b, "issue", { req: "RQ-214", units: ["PR-04"], borrower: "Kabir Sen", due }, "b-1"),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const again = await (await op(a, "issue", { req: "RQ-214", units: ["PR-04"], borrower: "Kabir Sen", due }, "a-1")).json();
  assert.equal(again.duplicate, true);
  const fin = (await (await fetch(base + "/api/session", { headers: { cookie: a } })).json()).state;
  assert.equal(fin.loans.filter((l) => l.asset === "PR-04" && l.status === "open").length, 1);
});

test("live updates reach other screens; data survives a restart", async () => {
  const a = await login("arjun");
  const ctl = new AbortController();
  const ev = await fetch(base + "/api/events", { headers: { cookie: a }, signal: ctl.signal });
  const reader = ev.body.getReader();
  await reader.read(); // initial state
  await op(a, "note", { text: "Projector lens cap is loose" });
  let got = "";
  while (!got.includes("lens cap")) got += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  await stop();
  base = await start(Number(new URL(base).port));
  const again = await login("arjun");
  const s = (await (await fetch(base + "/api/session", { headers: { cookie: again } })).json()).state;
  assert.ok(s.notes.some((n) => n.text === "Projector lens cap is loose"));
  assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 1);
});
