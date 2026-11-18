// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../domain.js");

const users = {
  arjun: { id: "arjun", name: "Arjun Nair", role: "operator" },
  meera: { id: "meera", name: "Meera Iyer", role: "operator" },
  priya: { id: "priya", name: "Priya Menon", role: "manager" },
  admin: { id: "admin", name: "Desk Admin", role: "admin" },
};
const run = (s, type, payload, who = "arjun", id) =>
  D.apply(s, { type, payload, id }, { user: users[who], now: D.nowFor(s) }).state;
const throwsMsg = (fn, re) => assert.throws(fn, (e) => e instanceof D.DomainError && re.test(e.message));

test("seed is valid and consistent", () => {
  const s = D.seed();
  assert.ok(D.validState(s));
  assert.equal(D.metrics(s, D.nowFor(s)).onLoan, 1);
  assert.equal(D.assetView(s, D.getAsset(s, "PR-06")).state, "maintenance");
  assert.equal(D.assetView(s, D.getAsset(s, "CA-03")).state, "reserved");
});

test("time zones round-trip, including a DST zone", () => {
  const iso = D.zonedToUtc("2026-11-20T20:00", "Asia/Kolkata");
  assert.equal(iso, "2026-11-20T14:30:00.000Z");
  assert.equal(D.utcToZoned(iso, "Asia/Kolkata"), "2026-11-20T20:00");
  assert.equal(D.zonedToUtc("2026-07-01T09:00", "America/New_York"), "2026-07-01T13:00:00.000Z");
  assert.equal(D.zonedToUtc("2026-12-01T09:00", "America/New_York"), "2026-12-01T14:00:00.000Z");
});

test("issue: whole kit, blocked units, approved quantity, duplicates", () => {
  let s = D.seed();
  const r = D.getReq(s, "RQ-214");
  throwsMsg(() => run(s, "issue", { req: "RQ-214", units: ["PR-06"], borrower: "Kabir Sen", due: r.due }), /under maintenance/);
  throwsMsg(() => run(s, "issue", { req: "RQ-214", units: ["MI-09"], borrower: "Kabir Sen", due: r.due }), /isn’t on RQ-214/);
  throwsMsg(() => run(s, "issue", { req: "RQ-214", units: ["SP-02", "SP-05"], borrower: "Kabir Sen", due: r.due }), /approved quantity/);
  throwsMsg(() => run(s, "issue", { req: "RQ-214", units: ["PR-04"], borrower: "Nobody", due: r.due }), /Choose who/);
  throwsMsg(() => run(s, "issue", { req: "RQ-221", units: ["SP-02"], borrower: "Ananya Pillai", due: r.due }), /pending/);
  s = run(s, "issue", { req: "RQ-214", units: ["PR-04", "SP-02", "AD-12"], borrower: "Kabir Sen", due: r.due }, "arjun", "op-1");
  assert.deepEqual(s.loans.filter((l) => l.status === "open").map((l) => l.num), [401, 402, 403, 404]);
  const again = D.apply(s, { type: "issue", id: "op-1", payload: { req: "RQ-214", units: ["AD-15"], borrower: "Kabir Sen", due: r.due } }, { user: users.arjun, now: D.nowFor(s) });
  assert.equal(again.duplicate, true);
  assert.equal(again.state, s);
  throwsMsg(() => run(s, "issue", { req: "RQ-214", units: ["PR-04"], borrower: "Kabir Sen", due: r.due }), /approved quantity|already on loan/);
  assert.equal(D.requestStage(s, D.getReq(s, "RQ-214")).key, "fulfilled");
});

test("reserved units only go to their request", () => {
  let s = D.seed();
  s = run(s, "request.approve", { id: "RQ-221" }, "priya");
  const cam = D.getAsset(s, "CA-03");
  assert.equal(D.issueBlocker(s, cam, "RQ-217"), "");
  assert.match(D.issueBlocker(s, cam, "RQ-214"), /reserved for RQ-217/);
  s = run(s, "issue", { req: "RQ-217", units: ["CA-03"], borrower: "Dev Menon", due: D.getReq(s, "RQ-217").due });
  assert.equal(D.getAsset(s, "CA-03").status, "available");
  assert.equal(D.assetView(s, D.getAsset(s, "CA-03")).state, "on-loan");
});

test("the practical: pickup, partial return, handover, morning close", () => {
  let s = D.seed();
  const due = D.getReq(s, "RQ-214").due;
  s = run(s, "issue", { req: "RQ-214", units: ["PR-04", "SP-02", "AD-12"], borrower: "Kabir Sen", due });
  s = run(s, "story.advance", {});
  throwsMsg(() => run(s, "return", { returnedBy: "Kabir Sen", items: [{ loan: 402, verify: "PR-06", condition: "good" }] }), /ID check failed/);
  s = run(s, "return", { returnedBy: "Kabir Sen", items: [
    { loan: 402, verify: "pr-04", condition: "good" },
    { loan: 403, verify: "SP-02", condition: "good" },
  ] });
  assert.equal(D.requestStage(s, D.getReq(s, "RQ-214")).label, "1 of 3 still out");
  s = run(s, "expect", { loan: 404, who: "Leela Das", when: D.PHASES[2].at });
  assert.equal(s.tasks.filter((t) => t.loan === 404 && t.status === "pending").length, 1);
  s = run(s, "story.advance", {});
  const now = D.nowFor(s);
  assert.ok(D.isOverdue(D.getLoan(s, 404), now));
  assert.equal(D.toAcknowledge(s, users.meera, now).length, 1);
  assert.ok(D.notifications(s, users.meera, now).some((n) => n.id === "overdue:404"));
  s = run(s, "handover.ack", {}, "meera");
  assert.equal(D.toAcknowledge(s, users.meera, now).length, 0);
  s = run(s, "return", { returnedBy: "Leela Das", items: [{ loan: 404, verify: "AD-12", condition: "good" }] }, "meera");
  assert.equal(D.getLoan(s, 404).returnedBy, "Leela Das");
  assert.equal(s.tasks.find((t) => t.loan === 404).status, "done");
  assert.equal(D.requestStage(s, D.getReq(s, "RQ-214")).key, "closed");
});

test("damaged returns hold the unit and open a ticket until released", () => {
  let s = D.seed();
  s = run(s, "issue", { req: "RQ-214", units: ["PR-04", "SP-02", "AD-12"], borrower: "Kabir Sen", due: D.getReq(s, "RQ-214").due });
  throwsMsg(() => run(s, "return", { returnedBy: "Kabir Sen", items: [{ loan: 402, verify: "PR-04", condition: "minor" }] }), /Describe the damage/);
  s = run(s, "return", { returnedBy: "Kabir Sen", items: [{ loan: 402, verify: "PR-04", condition: "good", missing: ["Remote"] }] });
  assert.equal(D.getLoan(s, 402).condition, "accessories");
  const pr = D.getAsset(s, "PR-04");
  assert.equal(pr.status, "damaged");
  assert.match(D.issueBlocker(s, pr, "RQ-214"), /damaged/);
  const ticket = s.tickets[s.tickets.length - 1];
  assert.equal(ticket.asset, "PR-04");
  throwsMsg(() => run(s, "maintenance.release", { id: ticket.id }), /role/);
  s = run(s, "maintenance.update", { id: ticket.id, status: "in_progress", technician: "Ravi", eta: D.PHASES[2].at }, "priya");
  assert.equal(D.getAsset(s, "PR-04").status, "maintenance");
  s = run(s, "maintenance.release", { id: ticket.id }, "priya");
  assert.equal(D.getAsset(s, "PR-04").status, "available");
});

test("reversals: audited, scoped by role, blocked when history moved on", () => {
  let s = D.seed();
  s = run(s, "issue", { req: "RQ-214", units: ["PR-04", "SP-02", "AD-12"], borrower: "Kabir Sen", due: D.getReq(s, "RQ-214").due });
  const issueTx = s.log[s.log.length - 1].id;
  s = run(s, "return", { returnedBy: "Kabir Sen", items: [{ loan: 403, verify: "SP-02", condition: "major", remarks: "Cracked" }] });
  const retTx = s.log[s.log.length - 1].id;
  throwsMsg(() => run(s, "txn.reverse", { tx: issueTx, reason: "wrong" }), /own latest/);
  throwsMsg(() => run(s, "txn.reverse", { tx: retTx, reason: "" }), /reason/);
  throwsMsg(() => run(s, "txn.reverse", { tx: retTx, reason: "Wrong unit" }, "meera"), /own latest/);
  s = run(s, "txn.reverse", { tx: retTx, reason: "Wrong unit" });
  assert.equal(D.getLoan(s, 403).status, "open");
  assert.equal(D.getAsset(s, "SP-02").status, "available");
  assert.equal(s.tickets[s.tickets.length - 1].status, "cancelled");
  throwsMsg(() => run(s, "txn.reverse", { tx: retTx, reason: "again" }, "priya"), /already reversed/);
  s = run(s, "txn.reverse", { tx: issueTx, reason: "Issued to the wrong club" }, "priya");
  assert.equal(s.loans.filter((l) => l.status === "void").length, 3);
  assert.equal(D.requestStage(s, D.getReq(s, "RQ-214")).key, "approved");
  const rev = s.log[s.log.length - 1];
  assert.equal(rev.kind, "reversal");
  assert.equal(rev.reverses, issueTx);
});

test("request lifecycle, availability, permissions", () => {
  let s = D.seed();
  const r = D.getReq(s, "RQ-221");
  const av = D.availability(s, r);
  assert.ok(av.every((x) => x.ok));
  assert.ok(av.find((x) => x.type === "Wireless microphone").notes[0].includes("MI-09"));
  throwsMsg(() => run(s, "request.approve", { id: "RQ-221" }, "arjun"), /role/);
  s = run(s, "request.modify", { id: "RQ-221", items: ["Portable speaker"] }, "priya");
  assert.deepEqual(D.getReq(s, "RQ-221").items, ["Portable speaker"]);
  s = run(s, "request.reject", { id: "RQ-221", reason: "Venue unavailable" }, "priya");
  assert.equal(D.getReq(s, "RQ-221").status, "rejected");
  s = run(s, "request.cancel", { id: "RQ-217", reason: "Walk postponed" }, "priya");
  assert.equal(D.getAsset(s, "CA-03").status, "available");
  throwsMsg(() => run(s, "settings.update", { tz: "Mars/Olympus" }, "admin"), /time zone/);
  s = run(s, "settings.update", { tz: "Europe/Berlin", locale: "de-DE" }, "admin");
  assert.equal(s.settings.locale, "de-DE");
  throwsMsg(() => run(s, "user.setRole", { id: "admin", role: "operator" }, "admin"), /at least one admin/);
});

test("reports cover the term", () => {
  const s = D.seed();
  const r = D.reports(s, D.nowFor(s));
  assert.ok(r.loans >= 10);
  assert.equal(r.byType.find((x) => x.type === "Portable speaker").damaged, 1);
  assert.ok(r.late >= 1);
  assert.ok(r.months.length >= 3);
});
