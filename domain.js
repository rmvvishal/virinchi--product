/*
 * Campus Stores domain model.
 *
 * Pure functions only: no DOM, no storage, no network. The same file runs in
 * the browser (as window.CampusDomain) and in Node (require("./domain.js")),
 * so the desk and the server apply exactly the same rules.
 *
 * Every change goes through apply(state, op, ctx). It validates the operation,
 * checks the user's role, returns a new state and writes an audit record.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CampusDomain = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA = 3;

  // ---------------------------------------------------------------- vocab
  const ROLES = {
    operator: "Desk operator",
    manager: "Store manager",
    admin: "Admin",
  };
  const RANK = { operator: 1, manager: 2, admin: 3 };
  // Minimum role for each operation.
  const NEEDS = {
    issue: 1,
    return: 1,
    expect: 1,
    note: 1,
    "task.add": 1,
    "task.done": 1,
    "handover.ack": 1,
    "asset.report": 1,
    "txn.reverse": 1,
    "story.advance": 1,
    "story.restart": 1,
    "request.create": 2,
    "request.approve": 2,
    "request.reject": 2,
    "request.cancel": 2,
    "request.modify": 2,
    "asset.setStatus": 2,
    "reservation.release": 2,
    "maintenance.update": 2,
    "maintenance.release": 2,
    "maintenance.retire": 2,
    "settings.update": 3,
    "user.setRole": 3,
  };
  const STATUSES = {
    available: "Available",
    "on-loan": "On loan",
    reserved: "Reserved",
    damaged: "Damaged",
    maintenance: "Under maintenance",
    missing: "Missing",
    retired: "Retired",
  };
  const CONDITIONS = {
    good: "Good condition",
    minor: "Minor damage",
    major: "Major damage",
    accessories: "Missing accessories",
  };
  const PRIORITIES = { high: "High", normal: "Normal", low: "Low" };
  const TICKET_STATUSES = {
    open: "Reported",
    in_progress: "In repair",
    repaired: "Repaired · awaiting release",
    closed: "Closed",
    cancelled: "Cancelled",
  };
  const REVERSIBLE = new Set(["issue", "return", "asset"]);

  class DomainError extends Error {}
  const fail = (msg) => {
    throw new DomainError(msg);
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isIso = (x) => typeof x === "string" && !Number.isNaN(Date.parse(x));
  const ms = (iso) => Date.parse(iso);
  const text = (x, max = 400) =>
    typeof x === "string" ? x.trim().slice(0, max) : "";

  // ---------------------------------------------------------- time zones
  function tzParts(ts, tz) {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = {};
    for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
    return p;
  }
  function tzOffset(ts, tz) {
    const p = tzParts(ts, tz);
    const asUtc = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour % 24,
      +p.minute,
      +p.second,
    );
    return asUtc - (ts - (((ts % 1000) + 1000) % 1000));
  }
  /** "2026-11-20T20:00" in the desk's zone → ISO instant (UTC). */
  function zonedToUtc(local, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || "");
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let ts = guess - tzOffset(guess, tz);
    ts = guess - tzOffset(ts, tz);
    return new Date(ts).toISOString();
  }
  /** ISO instant → "2026-11-20T20:00" in the desk's zone (for <input type=datetime-local>). */
  function utcToZoned(iso, tz) {
    const p = tzParts(ms(iso), tz);
    return (
      p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute
    );
  }
  function validZone(tz) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------- the story
  // The practical's three moments, at the IIT Madras desk (UTC+05:30).
  const ist = (mo, d, h, mi = 0, y = 2026) =>
    new Date(Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000).toISOString();
  const PHASES = [
    { at: ist(11, 20, 15, 45), staff: "arjun" },
    { at: ist(11, 20, 19, 30), staff: "arjun" },
    { at: ist(11, 21, 9, 0), staff: "meera" },
  ];
  const STORY_MESSAGES = {
    1: [
      {
        at: ist(11, 20, 19, 30),
        author: "Kabir Sen · Film Society",
        req: "RQ-214",
        text: "I brought the projector and speaker. Leela Das has our adapter. She’ll be at the counter at 9 am tomorrow.",
      },
    ],
  };

  function nowFor(state, realNow = Date.now()) {
    return state.settings.clock === "live"
      ? new Date(realNow).toISOString()
      : PHASES[state.story.phase].at;
  }

  // ---------------------------------------------------------------- seed
  function seed(settings) {
    const s = {
      schema: SCHEMA,
      rev: 1,
      settings: settings
        ? clone(settings)
        : { tz: "Asia/Kolkata", locale: "", clock: "story" },
      story: { phase: 0 },
      users: [
        { id: "arjun", name: "Arjun Nair", role: "operator" },
        { id: "meera", name: "Meera Iyer", role: "operator" },
        { id: "priya", name: "Priya Menon", role: "manager" },
        { id: "admin", name: "Desk Admin", role: "admin" },
      ],
      people: [
        { name: "Isha Rao", club: "Film Society" },
        { name: "Kabir Sen", club: "Film Society" },
        { name: "Leela Das", club: "Film Society" },
        { name: "Tara Shah", club: "Debate Union" },
        { name: "Dev Menon", club: "Photo Circle" },
        { name: "Ananya Pillai", club: "Dance Club" },
        { name: "Rohan Iyer", club: "Quiz Club" },
      ],
      assets: [
        a("PR-04", "HDMI projector", "BenQ MH550", "A2", ["Power cable", "Remote", "HDMI cable"]),
        a("PR-06", "HDMI projector", "Epson EB-X49", "A3", ["Power cable", "Remote", "HDMI cable"], {
          status: "maintenance",
          reason: "Lamp failure · with AV workshop",
          expected: ist(11, 23, 17),
          condition: "major",
        }),
        a("SP-01", "Portable speaker", "JBL Eon One", "—", ["Power cable"], {
          status: "retired",
          reason: "Driver blown beyond repair · written off Aug 2026",
        }),
        a("SP-02", "Portable speaker", "JBL Eon One", "B1", ["Power cable"]),
        a("SP-05", "Portable speaker", "Bose S1", "B2", ["Charger"]),
        a("AD-09", "USB-C → HDMI adapter", "Belkin AVC002", "C4", [], {
          status: "missing",
          reason: "Not found at the 2 Nov stock check",
        }),
        a("AD-12", "USB-C → HDMI adapter", "Belkin AVC002", "C4", []),
        a("AD-15", "USB-C → HDMI adapter", "Anker A8312", "C4", []),
        a("MI-09", "Wireless microphone", "Shure BLX", "B3", ["Receiver", "Spare AA batteries"]),
        a("CA-03", "Digital camera", "Sony A6400", "D2", ["Battery", "Charger", "Strap", "Lens cap"], {
          status: "reserved",
          reservedFor: "RQ-217",
          reason: "Held for Photo Circle (RQ-217)",
        }),
      ],
      requests: [],
      loans: [],
      tickets: [],
      tasks: [],
      notes: [],
      log: [],
      seenOps: [],
      seq: { tx: 1000, loan: 389, ticket: 28, task: 0, req: 221, note: 0 },
    };

    // History: closed requests and loans from the term so far, so reports
    // and the audit log have something real to show.
    const past = [
      ["RQ-180", "Film Society", "Orientation screening", "Isha Rao", [9, 12, 17], [9, 12, 23], [["PR-04", "Kabir Sen", [9, 12, 22, 40], "good"]]],
      ["RQ-183", "Debate Union", "Inter-hostel debate", "Tara Shah", [9, 19, 16], [9, 20, 10], [["SP-02", "Tara Shah", [9, 19, 22], "good"], ["MI-09", "Tara Shah", [9, 20, 14], "good"]]],
      ["RQ-190", "Photo Circle", "Heritage walk", "Dev Menon", [10, 3, 7], [10, 4, 12], [["CA-03", "Dev Menon", [10, 4, 11], "good"]]],
      ["RQ-195", "Dance Club", "Freshers’ showcase", "Ananya Pillai", [10, 10, 15], [10, 10, 22], [["SP-05", "Ananya Pillai", [10, 10, 22, 30], "minor", "Grille dented"]]],
      ["RQ-198", "Quiz Club", "Quiz night", "Rohan Iyer", [10, 17, 17], [10, 17, 23], [["PR-04", "Rohan Iyer", [10, 17, 22, 50], "good"], ["AD-12", "Rohan Iyer", [10, 17, 22, 50], "good"]]],
      ["RQ-204", "Film Society", "Documentary night", "Isha Rao", [11, 6, 17], [11, 6, 23], [["PR-06", "Kabir Sen", [11, 6, 22, 45], "major", "Lamp failed mid-screening"]]],
      ["RQ-207", "Photo Circle", "Night photography", "Dev Menon", [11, 13, 17], [11, 14, 10], [["SP-02", "Dev Menon", [11, 14, 9, 30], "good"], ["CA-03", "Dev Menon", [11, 14, 9, 30], "good"]]],
    ];
    const events = [];
    for (const [id, club, event, owner, p, d, units] of past) {
      const pickup = ist(...p);
      s.requests.push({
        id,
        club,
        event,
        owner,
        pickup,
        due: ist(...d),
        items: units.map(([u]) => s.assets.find((x) => x.id === u).type),
        note: "",
        status: "approved",
        createdAt: ist(p[0], p[1] - 3, 11),
        history: [
          { at: ist(p[0], p[1] - 3, 11), by: "Student Activities Office", action: "Submitted" },
          { at: ist(p[0], p[1] - 2, 12), by: "priya", action: "Approved" },
        ],
      });
      const loans = [];
      for (const [assetId, who, back, condition, remarks] of units) {
        const num = ++s.seq.loan;
        loans.push(num);
        s.loans.push({
          num,
          req: id,
          asset: assetId,
          borrower: who,
          due: ist(...d),
          issuedAt: pickup,
          issuedBy: "arjun",
          status: "returned",
          returnedAt: ist(...back),
          returnedBy: who,
          receivedBy: back[2] < 12 ? "meera" : "arjun",
          condition,
          missing: [],
          remarks: remarks || "",
        });
        events.push({ at: ist(...back), kind: "return", by: back[2] < 12 ? "meera" : "arjun", loans: [num], summary: "Returned " + assetId + " from " + who + " (" + CONDITIONS[condition].toLowerCase() + ")", req: id });
      }
      events.push({ at: pickup, kind: "issue", by: "arjun", loans, summary: "Issued " + units.map((u) => u[0]).join(", ") + " to " + units[0][1] + " for " + id, req: id });
    }
    s.requests.push({
      id: "RQ-205",
      club: "Quiz Club",
      event: "Quiz finals",
      owner: "Rohan Iyer",
      pickup: ist(11, 8, 16),
      due: ist(11, 8, 22),
      items: ["HDMI projector"],
      note: "",
      status: "rejected",
      createdAt: ist(11, 5, 10),
      history: [
        { at: ist(11, 5, 10), by: "Student Activities Office", action: "Submitted" },
        { at: ist(11, 5, 15), by: "priya", action: "Rejected", note: "PR-04 already booked, PR-06 in repair." },
      ],
    });
    // Tickets from past damage.
    s.tickets.push(
      {
        id: "MT-29",
        asset: "SP-05",
        issue: "Grille dented",
        status: "closed",
        technician: "Ravi K · AV workshop",
        eta: null,
        loan: 394,
        openedAt: ist(10, 10, 22, 30),
        openedBy: "arjun",
        history: [
          { at: ist(10, 10, 22, 30), by: "arjun", text: "Reported on return: minor damage" },
          { at: ist(10, 14, 12), by: "priya", text: "Repaired and released" },
        ],
      },
      {
        id: "MT-31",
        asset: "PR-06",
        issue: "Lamp failed mid-screening",
        status: "in_progress",
        technician: "Ravi K · AV workshop",
        eta: ist(11, 23, 17),
        loan: 397,
        openedAt: ist(11, 6, 22, 45),
        openedBy: "arjun",
        history: [
          { at: ist(11, 6, 22, 45), by: "arjun", text: "Reported on return: major damage" },
          { at: ist(11, 9, 11), by: "priya", text: "Sent to AV workshop · replacement lamp ordered" },
        ],
      },
    );
    s.seq.ticket = 31;

    // The practical's live records.
    s.requests.push(
      {
        id: "RQ-209",
        club: "Debate Union",
        event: "Finals rehearsal",
        owner: "Tara Shah",
        pickup: ist(11, 20, 15),
        due: ist(11, 21, 10),
        items: ["Wireless microphone"],
        note: "Rehearsal runs into the evening.",
        status: "approved",
        createdAt: ist(11, 17, 10),
        history: [
          { at: ist(11, 17, 10), by: "Student Activities Office", action: "Submitted" },
          { at: ist(11, 18, 12), by: "priya", action: "Approved" },
        ],
      },
      {
        id: "RQ-214",
        club: "Film Society",
        event: "Courtyard screening",
        owner: "Isha Rao",
        pickup: ist(11, 20, 16),
        due: ist(11, 20, 20),
        items: ["HDMI projector", "Portable speaker", "USB-C → HDMI adapter"],
        note: "Playback is from a USB-C-only laptop. The host will collect at 4 pm.",
        status: "approved",
        createdAt: ist(11, 17, 14),
        history: [
          { at: ist(11, 17, 14), by: "Student Activities Office", action: "Submitted" },
          { at: ist(11, 18, 16), by: "priya", action: "Approved" },
        ],
      },
      {
        id: "RQ-217",
        club: "Photo Circle",
        event: "Street portrait walk",
        owner: "Dev Menon",
        pickup: ist(11, 21, 9, 30),
        due: ist(11, 21, 12),
        items: ["Digital camera"],
        note: "Collection on Saturday morning.",
        status: "approved",
        createdAt: ist(11, 18, 9),
        history: [
          { at: ist(11, 18, 9), by: "Student Activities Office", action: "Submitted" },
          { at: ist(11, 19, 10), by: "priya", action: "Approved", note: "CA-03 reserved." },
        ],
      },
      {
        id: "RQ-221",
        club: "Dance Club",
        event: "Showcase rehearsal",
        owner: "Ananya Pillai",
        pickup: ist(11, 21, 14),
        due: ist(11, 21, 18),
        items: ["Portable speaker", "Wireless microphone"],
        note: "Outdoor rehearsal at the OAT.",
        status: "pending",
        createdAt: ist(11, 20, 11),
        history: [{ at: ist(11, 20, 11), by: "Student Activities Office", action: "Submitted" }],
      },
    );
    s.loans.push({
      num: 401,
      req: "RQ-209",
      asset: "MI-09",
      borrower: "Tara Shah",
      due: ist(11, 21, 10),
      issuedAt: ist(11, 20, 15),
      issuedBy: "arjun",
      status: "open",
    });
    s.seq.loan = 401;
    events.push({ at: ist(11, 20, 15), kind: "issue", by: "arjun", loans: [401], summary: "Issued MI-09 to Tara Shah for RQ-209", req: "RQ-209" });
    events.push({ at: ist(11, 9, 11), kind: "maintenance", by: "priya", summary: "MT-31 PR-06 sent to AV workshop", ticket: "MT-31" });
    events.push({ at: ist(11, 2, 18), kind: "asset", by: "priya", summary: "AD-09 marked missing after stock check" });
    events.sort((x, y) => ms(x.at) - ms(y.at));
    for (const e of events)
      s.log.push({
        id: "TX-" + ++s.seq.tx,
        at: e.at,
        by: e.by,
        kind: e.kind,
        summary: e.summary,
        refs: { loans: e.loans || [], req: e.req || null, ticket: e.ticket || null },
        undo: null,
        reversedBy: null,
      });
    for (const l of s.loans) {
      const issueTx = s.log.find((t) => t.kind === "issue" && t.refs.loans.includes(l.num));
      const retTx = s.log.find((t) => t.kind === "return" && t.refs.loans.includes(l.num));
      l.issueTx = issueTx && issueTx.id;
      if (retTx) l.returnTx = retTx.id;
    }

    s.notes.push(
      note(s, ist(11, 20, 15, 20), "message", "Isha Rao · Film Society", "RQ-214", "Kabir Sen is picking up our whole screening kit. Please issue it in his name. I’m setting up in the courtyard."),
      note(s, ist(11, 20, 15, 30), "message", "Tara Shah · Debate Union", "RQ-209", "Our microphone stays with me overnight. I’ll return it by 10 am Saturday."),
    );
    s.tasks.push({
      id: "T-" + ++s.seq.task,
      title: "Confirm PR-06 repair date with the AV workshop",
      responsible: "Priya Menon",
      priority: "low",
      status: "pending",
      due: ist(11, 23, 12),
      createdAt: ist(11, 19, 17),
      createdBy: "priya",
      ackBy: "arjun",
      ackAt: ist(11, 20, 14),
    });
    return s;

    function a(id, type, model, bin, accessories, extra = {}) {
      return {
        id,
        type,
        model,
        bin,
        accessories,
        status: "available",
        reason: "",
        expected: null,
        reservedFor: null,
        condition: "good",
        ...extra,
      };
    }
  }
  function note(s, at, kind, author, req, body, by = null) {
    return {
      id: "N-" + ++s.seq.note,
      at,
      kind,
      author,
      req: req || null,
      text: body,
      by,
      ackBy: null,
      ackAt: null,
    };
  }

  // ----------------------------------------------------------- selectors
  const getAsset = (s, id) => s.assets.find((x) => x.id === id);
  const getReq = (s, id) => s.requests.find((x) => x.id === id);
  const getLoan = (s, num) => s.loans.find((l) => l.num === Number(num));
  const getUser = (s, id) => s.users.find((u) => u.id === id);
  const userName = (s, id) => (getUser(s, id) || {}).name || id || "—";
  const openLoan = (s, assetId) =>
    s.loans.find((l) => l.asset === assetId && l.status === "open");
  const isOverdue = (l, now) => l.status === "open" && ms(now) > ms(l.due);
  const types = (s) => [...new Set(s.assets.map((x) => x.type))];

  /** What a desk worker needs to know about one physical unit right now. */
  function assetView(s, asset) {
    const loan = openLoan(s, asset.id);
    if (loan)
      return {
        state: "on-loan",
        label: STATUSES["on-loan"],
        reason:
          "With " + loan.borrower + " · slip L-" + loan.num + " · " + loan.req,
        expected: loan.expect ? loan.expect.when : loan.due,
        loan,
      };
    let expected = asset.expected;
    if (asset.status === "reserved") {
      const r = getReq(s, asset.reservedFor);
      expected = r ? r.due : null;
    }
    return {
      state: asset.status,
      label: STATUSES[asset.status],
      reason: asset.reason,
      expected:
        asset.status === "available" || asset.status === "retired"
          ? null
          : expected,
      loan: null,
    };
  }
  /** Can this unit leave the desk on this request? Returns "" or a reason. */
  function issueBlocker(s, asset, reqId) {
    if (openLoan(s, asset.id)) return asset.id + " is already on loan.";
    if (asset.status === "reserved" && asset.reservedFor !== reqId)
      return asset.id + " is reserved for " + asset.reservedFor + ".";
    if (!["available", "reserved"].includes(asset.status))
      return (
        asset.id +
        " is " +
        STATUSES[asset.status].toLowerCase() +
        (asset.reason ? " (" + asset.reason + ")" : "") +
        "."
      );
    return "";
  }

  /** Approved lines on a request and the loan (if any) filling each one. */
  function kitLines(s, r) {
    const used = new Set();
    return r.items.map((type) => {
      const mine = s.loans.filter(
        (l) =>
          l.req === r.id &&
          l.status !== "void" &&
          !used.has(l.num) &&
          getAsset(s, l.asset).type === type,
      );
      const loan = mine.find((l) => l.status === "open") || mine[mine.length - 1];
      if (loan) used.add(loan.num);
      return { type, loan: loan || null };
    });
  }
  /** Lifecycle stage shown on a request. */
  function requestStage(s, r) {
    if (r.status !== "approved")
      return { key: r.status, label: cap(r.status) };
    const lines = kitLines(s, r);
    const out = lines.filter((x) => x.loan && x.loan.status === "open").length;
    const back = lines.filter((x) => x.loan && x.loan.status === "returned").length;
    const todo = lines.length - out - back;
    if (!out && !back) return { key: "approved", label: "Approved · not issued" };
    if (todo) return { key: "partial", label: "Partly fulfilled · " + todo + " to issue" };
    if (out) return { key: "fulfilled", label: back ? out + " of " + lines.length + " still out" : "Fulfilled · all out" };
    return { key: "closed", label: "Closed · all returned" };
  }
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

  /** Availability check for approving or modifying a request. */
  function availability(s, r) {
    const need = {};
    for (const t of r.items) need[t] = (need[t] || 0) + 1;
    return Object.entries(need).map(([type, n]) => {
      const units = s.assets.filter((x) => x.type === type);
      const free = [];
      const notes = [];
      for (const u of units) {
        const l = openLoan(s, u.id);
        if (l && l.req === r.id) {
          free.push(u.id);
          continue;
        }
        if (["retired", "missing", "damaged"].includes(u.status)) continue;
        if (u.status === "maintenance") {
          if (u.expected && ms(u.expected) <= ms(r.pickup)) {
            free.push(u.id);
            notes.push(u.id + " due out of repair before pickup");
          }
          continue;
        }
        if (u.status === "reserved" && u.reservedFor !== r.id) {
          const other = getReq(s, u.reservedFor);
          if (other && ms(other.due) <= ms(r.pickup)) {
            free.push(u.id);
            notes.push(u.id + " back from " + other.id + " before pickup");
          }
          continue;
        }
        if (l) {
          const back = l.expect ? l.expect.when : l.due;
          if (ms(back) <= ms(r.pickup)) {
            free.push(u.id);
            notes.push(u.id + " on loan, due back before pickup");
          }
          continue;
        }
        free.push(u.id);
      }
      return { type, need: n, free, ok: free.length >= n, notes };
    });
  }

  function handoverItems(s, now) {
    return [
      ...s.tasks.filter((t) => ms(t.createdAt) <= ms(now)),
      ...s.notes.filter((n) => n.kind === "handover" && ms(n.at) <= ms(now)),
    ];
  }
  /** Handover items another person left that this user has not acknowledged. */
  function toAcknowledge(s, user, now) {
    return handoverItems(s, now).filter(
      (x) =>
        !x.ackBy &&
        (x.createdBy || x.by) !== user.id &&
        (x.status === undefined || x.status === "pending"),
    );
  }

  function metrics(s, now) {
    const m = { total: 0, available: 0, onLoan: 0, reserved: 0, repair: 0, missing: 0, retired: 0 };
    for (const x of s.assets) {
      m.total++;
      const v = assetView(s, x).state;
      if (v === "available") m.available++;
      else if (v === "on-loan") m.onLoan++;
      else if (v === "reserved") m.reserved++;
      else if (v === "damaged" || v === "maintenance") m.repair++;
      else if (v === "missing") m.missing++;
      else if (v === "retired") m.retired++;
    }
    m.overdue = s.loans.filter((l) => isOverdue(l, now)).length;
    m.pending = s.requests.filter((r) => r.status === "pending").length;
    m.toIssue = s.requests.filter(
      (r) => r.status === "approved" && ["approved", "partial"].includes(requestStage(s, r).key),
    ).length;
    return m;
  }

  /** In-app notifications for one user. Ids are stable so they can be dismissed. */
  function notifications(s, user, now) {
    const list = [];
    const t = ms(now);
    for (const l of s.loans.filter((x) => x.status === "open")) {
      const a = getAsset(s, l.asset);
      if (t > ms(l.due))
        list.push({ id: "overdue:" + l.num, level: "danger", text: "Overdue: " + a.id + " " + a.type + " from " + l.borrower + (l.expect ? " · " + l.expect.who + " is bringing it back" : ""), page: "loans", ref: String(l.num) });
      else if (ms(l.due) - t <= 3 * 3600e3)
        list.push({ id: "due:" + l.num, level: "warn", text: "Due soon: " + a.id + " " + a.type + " from " + l.borrower, page: "loans", ref: String(l.num) });
    }
    for (const a of s.assets.filter((x) => x.status === "damaged"))
      list.push({ id: "damaged:" + a.id + ":" + a.reason, level: "warn", text: a.id + " reported damaged · " + a.reason, page: "maintenance", ref: a.id });
    for (const k of s.tickets.filter((x) => x.status === "repaired"))
      list.push({ id: "release:" + k.id, level: "info", text: k.id + " " + k.asset + " repaired · awaiting release", page: "maintenance", ref: k.id, managers: true });
    for (const r of s.requests) {
      if (r.status === "pending")
        list.push({ id: "pending:" + r.id, level: "info", text: "Awaiting approval: " + r.id + " " + r.club + " · " + r.event, page: "request", ref: r.id, managers: true });
      const st = requestStage(s, r).key;
      if (r.status === "approved" && (st === "approved" || st === "partial") && ms(r.pickup) - t < 24 * 3600e3 && ms(r.due) > t)
        list.push({ id: "pickup:" + r.id + ":" + st, level: "info", text: "Pickup " + (ms(r.pickup) < t ? "now" : "coming up") + ": " + r.id + " " + r.club + " · " + r.event, page: "request", ref: r.id });
    }
    const ack = toAcknowledge(s, user, now);
    if (ack.length)
      list.push({ id: "ack:" + ack.map((x) => x.id).join(","), level: "warn", text: ack.length + " handover item" + (ack.length > 1 ? "s" : "") + " to acknowledge", page: "deskbook", ref: "" });
    for (const k of s.tasks.filter((x) => x.status === "pending" && x.due && ms(x.due) < t))
      list.push({ id: "task:" + k.id, level: "warn", text: "Task overdue: " + k.title, page: "deskbook", ref: k.id });
    return list.filter((n) => !n.managers || RANK[user.role] >= 2);
  }

  /** Report figures over the term so far (or since `from`). */
  function reports(s, now, from) {
    const end = ms(now);
    const start = from ? ms(from) : Math.min(...s.loans.map((l) => ms(l.issuedAt)));
    const loans = s.loans.filter((l) => l.status !== "void" && ms(l.issuedAt) >= start && ms(l.issuedAt) <= end);
    const hours = (l) => (Math.min(end, ms(l.returnedAt || now)) - ms(l.issuedAt)) / 3600e3;
    const windowH = Math.max(1, (end - start) / 3600e3);
    const byType = types(s).map((type) => {
      const units = s.assets.filter((x) => x.type === type && x.status !== "retired").length;
      const mine = loans.filter((l) => getAsset(s, l.asset).type === type);
      const returned = mine.filter((l) => l.status === "returned");
      const damaged = returned.filter((l) => l.condition && l.condition !== "good");
      const h = mine.reduce((sum, l) => sum + hours(l), 0);
      return {
        type,
        units,
        loans: mine.length,
        hours: h,
        utilisation: units ? h / (units * windowH) : 0,
        damageRate: returned.length ? damaged.length / returned.length : 0,
        damaged: damaged.length,
      };
    });
    const unitCounts = {};
    for (const l of loans) unitCounts[l.asset] = (unitCounts[l.asset] || 0) + 1;
    const topUnits = Object.entries(unitCounts)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, 5)
      .map(([id, n]) => ({ id, n, type: getAsset(s, id).type }));
    const late = loans.filter((l) =>
      l.status === "returned" ? ms(l.returnedAt) > ms(l.due) : isOverdue(l, now),
    );
    const months = {};
    for (const t of s.log) {
      if (ms(t.at) > end || ms(t.at) < start) continue;
      const k = t.at.slice(0, 7);
      months[k] = (months[k] || 0) + 1;
    }
    return {
      from: new Date(start).toISOString(),
      to: now,
      loans: loans.length,
      byType,
      topUnits,
      overdueRate: loans.length ? late.length / loans.length : 0,
      late: late.length,
      damaged: byType.reduce((n, x) => n + x.damaged, 0),
      months: Object.entries(months).sort(),
    };
  }

  // ------------------------------------------------------------- apply()
  const can = (user, type) =>
    !!user && !!NEEDS[type] && RANK[user.role] >= NEEDS[type];

  function apply(state, op, ctx) {
    if (!op || typeof op.type !== "string" || !NEEDS[op.type])
      fail("Unknown action.");
    const user = ctx && ctx.user;
    if (!user || !RANK[user.role]) fail("Sign in first.");
    if (!can(user, op.type))
      fail("Your role (" + ROLES[user.role] + ") can’t do this. Ask a store manager.");
    if (op.id && state.seenOps.includes(op.id))
      return { state, duplicate: true, notice: "Already recorded — nothing changed." };
    if (op.type === "story.restart") {
      const fresh = seed(state.settings);
      fresh.rev = state.rev + 1;
      return { state: fresh, notice: "Sample shift restarted." };
    }
    const s = clone(state);
    const now = ctx.now || nowFor(s);
    const out = HANDLERS[op.type](s, op.payload || {}, { now, user }) || {};
    if (op.id) {
      s.seenOps.push(op.id);
      if (s.seenOps.length > 500) s.seenOps.splice(0, s.seenOps.length - 500);
    }
    s.rev++;
    return { state: s, notice: out.notice || "", tx: out.tx || null, receipt: out.receipt || null };
  }

  function addTx(s, ctx, kind, summary, refs = {}, undo = null) {
    const id = "TX-" + ++s.seq.tx;
    s.log.push({
      id,
      at: ctx.now,
      by: ctx.user.id,
      kind,
      summary,
      refs: { loans: [], req: null, ticket: null, asset: null, ...refs },
      undo,
      reversedBy: null,
    });
    return id;
  }
  const assetSnap = (x) => ({
    status: x.status,
    reason: x.reason,
    expected: x.expected,
    reservedFor: x.reservedFor,
    condition: x.condition,
  });
  const person = (s, name, label) => {
    if (!s.people.some((p) => p.name === name)) fail("Choose " + label + " from the list.");
    return name;
  };
  const future = (iso, now, label) => {
    if (!isIso(iso)) fail("Enter a valid " + label + ".");
    if (ms(iso) <= ms(now)) fail(cap(label) + " must be after the current desk time.");
    return new Date(iso).toISOString();
  };

  function openTicket(s, ctx, asset, issue, loan) {
    const t = {
      id: "MT-" + ++s.seq.ticket,
      asset: asset.id,
      issue,
      status: "open",
      technician: "",
      eta: null,
      loan: loan || null,
      openedAt: ctx.now,
      openedBy: ctx.user.id,
      history: [{ at: ctx.now, by: ctx.user.id, text: "Reported: " + issue }],
    };
    s.tickets.push(t);
    return t;
  }

  const HANDLERS = {
    issue(s, p, ctx) {
      const r = getReq(s, p.req) || fail("Choose an approved request.");
      if (r.status !== "approved") fail(r.id + " is " + r.status + ", not approved.");
      const units = Array.isArray(p.units) ? [...new Set(p.units)] : [];
      if (!units.length) fail("Pick at least one unit to issue.");
      const borrower = person(s, p.borrower, "who is collecting");
      const due = future(p.due, ctx.now, "return time");
      const left = {};
      for (const t of r.items) left[t] = (left[t] || 0) + 1;
      for (const l of s.loans)
        if (l.req === r.id && l.status === "open") left[getAsset(s, l.asset).type]--;
      const prev = {};
      for (const id of units) {
        const a = getAsset(s, id) || fail("Unknown unit " + id + ".");
        if (!(a.type in left)) fail(a.type + " isn’t on " + r.id + ". Choose an approved unit.");
        if (left[a.type] <= 0) fail("The approved quantity of " + a.type + " is already out on " + r.id + ".");
        const block = issueBlocker(s, a, r.id);
        if (block) fail(block);
        left[a.type]--;
        prev[id] = assetSnap(a);
      }
      const nums = [];
      const txId = "TX-" + (s.seq.tx + 1);
      for (const id of units) {
        const a = getAsset(s, id);
        if (a.status === "reserved") {
          a.status = "available";
          a.reservedFor = null;
          a.reason = "";
        }
        const num = ++s.seq.loan;
        nums.push(num);
        s.loans.push({ num, req: r.id, asset: id, borrower, due, issuedAt: ctx.now, issuedBy: ctx.user.id, issueTx: txId, status: "open" });
      }
      addTx(s, ctx, "issue", "Issued " + units.join(", ") + " to " + borrower + " for " + r.id, { loans: nums, req: r.id }, { prev });
      r.history.push({ at: ctx.now, by: ctx.user.id, action: "Issued " + units.join(", ") + " to " + borrower });
      return {
        tx: txId,
        notice: "Issued " + units.length + " item" + (units.length > 1 ? "s" : "") + " to " + borrower + " · " + txId + " · slips " + nums.map((n) => "L-" + n).join(", ") + ".",
        receipt: { kind: "pickup", tx: txId },
      };
    },

    return(s, p, ctx) {
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) fail("Choose at least one unit to return.");
      const returnedBy = person(s, p.returnedBy, "who brought it back");
      const seen = new Set();
      for (const it of items) {
        const l = getLoan(s, it.loan) || fail("Unknown slip.");
        if (seen.has(l.num)) fail("Slip L-" + l.num + " is listed twice.");
        seen.add(l.num);
        if (l.status !== "open") fail("Slip L-" + l.num + " is already closed.");
        const a = getAsset(s, l.asset);
        const said = text(it.verify, 20).toUpperCase().replace(/\s+/g, "");
        if (said !== a.id)
          fail(said ? "ID check failed: the label reads " + said + " but slip L-" + l.num + " is for " + a.id + ". Check you have the right unit." : "Enter or scan the ID on the label of " + a.type + " (slip L-" + l.num + ").");
        if (!CONDITIONS[it.condition]) fail("Choose the condition of " + a.id + ".");
        const missing = Array.isArray(it.missing) ? it.missing : [];
        if (missing.some((m) => !a.accessories.includes(m))) fail("Unknown accessory for " + a.id + ".");
        if ((it.condition === "minor" || it.condition === "major") && !text(it.remarks))
          fail("Describe the damage on " + a.id + " in the remarks.");
      }
      const txId = "TX-" + (s.seq.tx + 1);
      const undo = { items: [] };
      const notices = [];
      for (const it of items) {
        const l = getLoan(s, it.loan);
        const a = getAsset(s, l.asset);
        const missing = (it.missing || []).slice();
        let condition = it.condition;
        if (condition === "good" && missing.length) condition = "accessories";
        const remarks = text(it.remarks);
        const rec = { loan: l.num, prev: assetSnap(a), ticket: null, tasks: [] };
        Object.assign(l, { status: "returned", returnedAt: ctx.now, returnedBy, receivedBy: ctx.user.id, condition, missing, remarks, returnTx: txId });
        if (condition === "good") {
          a.status = "available";
          a.reason = "";
          a.expected = null;
          a.condition = "good";
          notices.push(a.id + " back on shelf " + a.bin);
        } else {
          const issue =
            (condition === "accessories" ? "Missing accessories: " + missing.join(", ") : CONDITIONS[condition] + (missing.length ? " · missing " + missing.join(", ") : "")) +
            (remarks ? " — " + remarks : "");
          a.status = "damaged";
          a.reason = issue;
          a.expected = null;
          a.condition = condition === "accessories" ? a.condition : condition;
          const t = openTicket(s, ctx, a, issue, l.num);
          rec.ticket = t.id;
          notices.push(a.id + " held for inspection (" + t.id + ")");
        }
        for (const k of s.tasks.filter((k) => k.loan === l.num && k.status === "pending")) {
          k.status = "done";
          k.doneAt = ctx.now;
          k.doneBy = ctx.user.id;
          k.doneNote = "Closed by return " + txId;
          rec.tasks.push(k.id);
        }
        undo.items.push(rec);
      }
      const nums = items.map((x) => Number(x.loan));
      const reqId = getLoan(s, nums[0]).req;
      addTx(s, ctx, "return", "Returned " + nums.map((n) => getLoan(s, n).asset).join(", ") + " from " + returnedBy, { loans: nums, req: reqId }, undo);
      return { tx: txId, notice: "Return recorded · " + txId + ". " + notices.join("; ") + ".", receipt: { kind: "return", tx: txId } };
    },

    expect(s, p, ctx) {
      const l = getLoan(s, p.loan) || fail("Unknown slip.");
      if (l.status !== "open") fail("Slip L-" + l.num + " is closed.");
      const who = person(s, p.who, "who is bringing it back");
      if (!isIso(p.when)) fail("Enter when it’s expected back.");
      l.expect = { who, when: new Date(p.when).toISOString(), at: ctx.now, by: ctx.user.id };
      const a = getAsset(s, l.asset);
      let t = s.tasks.find((k) => k.loan === l.num && k.status === "pending");
      if (!t) {
        t = { id: "T-" + ++s.seq.task, loan: l.num, status: "pending", createdAt: ctx.now, createdBy: ctx.user.id, ackBy: null, ackAt: null, auto: true };
        s.tasks.push(t);
      }
      Object.assign(t, {
        title: "Collect " + a.id + " " + a.type + " (slip L-" + l.num + ", " + l.req + ")",
        responsible: who,
        priority: isOverdue(l, l.expect.when) ? "high" : "normal",
        due: l.expect.when,
      });
      addTx(s, ctx, "handover", "L-" + l.num + " " + a.id + ": " + who + " is bringing it back", { loans: [l.num], req: l.req });
      return { notice: "Saved on slip L-" + l.num + " and added to the handover tasks." };
    },

    note(s, p, ctx) {
      const body = text(p.text, 600);
      if (!body) fail("Write a note first.");
      s.notes.push(note(s, ctx.now, "handover", "Counter handover · " + ctx.user.name, null, body, ctx.user.id));
      addTx(s, ctx, "handover", "Handover note added");
      return { notice: "Handover note saved." };
    },

    "task.add"(s, p, ctx) {
      const title = text(p.title, 160) || fail("Give the task a title.");
      const responsible = text(p.responsible, 80) || fail("Say who is responsible.");
      const priority = PRIORITIES[p.priority] ? p.priority : "normal";
      const t = { id: "T-" + ++s.seq.task, title, responsible, priority, status: "pending", due: isIso(p.due) ? new Date(p.due).toISOString() : null, createdAt: ctx.now, createdBy: ctx.user.id, ackBy: null, ackAt: null };
      s.tasks.push(t);
      addTx(s, ctx, "handover", "Task " + t.id + " added: " + title);
      return { notice: "Task " + t.id + " added." };
    },

    "task.done"(s, p, ctx) {
      const t = s.tasks.find((k) => k.id === p.id) || fail("Unknown task.");
      if (t.status !== "pending") fail("That task is already done.");
      t.status = "done";
      t.doneAt = ctx.now;
      t.doneBy = ctx.user.id;
      addTx(s, ctx, "handover", "Task " + t.id + " completed");
      return { notice: "Task " + t.id + " marked done." };
    },

    "handover.ack"(s, p, ctx) {
      const items = toAcknowledge(s, ctx.user, ctx.now);
      if (!items.length) fail("Nothing to acknowledge.");
      for (const x of items) {
        x.ackBy = ctx.user.id;
        x.ackAt = ctx.now;
      }
      addTx(s, ctx, "handover", ctx.user.name + " acknowledged " + items.length + " handover item" + (items.length > 1 ? "s" : ""));
      return { notice: "Handover acknowledged (" + items.length + ")." };
    },

    "asset.report"(s, p, ctx) {
      const a = getAsset(s, p.id) || fail("Unknown unit.");
      if (openLoan(s, a.id)) fail(a.id + " is on loan. Record the return first.");
      if (!["damaged", "missing"].includes(p.status)) fail("Choose damaged or missing.");
      const reason = text(p.reason) || fail("Say what’s wrong.");
      const prev = assetSnap(a);
      a.status = p.status;
      a.reason = reason;
      a.expected = null;
      a.reservedFor = null;
      let ticket = null;
      if (p.status === "damaged") ticket = openTicket(s, ctx, a, reason).id;
      addTx(s, ctx, "asset", a.id + " reported " + p.status + ": " + reason, { asset: a.id, ticket }, { asset: a.id, prev, set: p.status, ticket });
      return { notice: a.id + " marked " + p.status + (ticket ? " · " + ticket + " opened" : "") + "." };
    },

    "asset.setStatus"(s, p, ctx) {
      const a = getAsset(s, p.id) || fail("Unknown unit.");
      if (openLoan(s, a.id)) fail(a.id + " is on loan. Record the return first.");
      if (!STATUSES[p.status] || p.status === "on-loan") fail("Choose a status.");
      const reason = text(p.reason);
      if (p.status !== "available" && !reason) fail("Give a reason so the desk knows why it’s unavailable.");
      let reservedFor = null;
      if (p.status === "reserved") {
        const r = getReq(s, p.reservedFor) || fail("Choose the request to reserve it for.");
        if (!r.items.includes(a.type)) fail(r.id + " doesn’t include a " + a.type + ".");
        reservedFor = r.id;
      }
      const prev = assetSnap(a);
      a.status = p.status;
      a.reason = p.status === "available" ? "" : reason;
      a.expected = isIso(p.expected) ? new Date(p.expected).toISOString() : null;
      a.reservedFor = reservedFor;
      if (p.status === "available") a.condition = "good";
      addTx(s, ctx, "asset", a.id + " → " + STATUSES[p.status] + (reason ? ": " + reason : ""), { asset: a.id, req: reservedFor }, { asset: a.id, prev, set: p.status });
      return { notice: a.id + " is now " + STATUSES[p.status].toLowerCase() + "." };
    },

    "reservation.release"(s, p, ctx) {
      return HANDLERS["asset.setStatus"](s, { id: p.id, status: "available" }, ctx);
    },

    "request.create"(s, p, ctx) {
      const club = text(p.club, 80) || fail("Enter the club.");
      const event = text(p.event, 120) || fail("Enter the event.");
      const owner = person(s, p.owner, "who filed it");
      const pickup = future(p.pickup, ctx.now, "pickup time");
      const due = future(p.due, ctx.now, "return time");
      if (ms(due) <= ms(pickup)) fail("Return time must be after pickup.");
      const items = (Array.isArray(p.items) ? p.items : []).filter((t) => types(s).includes(t));
      if (!items.length) fail("Add at least one item.");
      const id = "RQ-" + ++s.seq.req;
      s.requests.push({ id, club, event, owner, pickup, due, items, note: text(p.note), status: "pending", createdAt: ctx.now, history: [{ at: ctx.now, by: ctx.user.id, action: "Submitted" }] });
      addTx(s, ctx, "request", id + " created for " + club, { req: id });
      return { notice: id + " created and waiting for approval." };
    },

    "request.approve"(s, p, ctx) {
      const r = getReq(s, p.id) || fail("Unknown request.");
      if (r.status !== "pending") fail(r.id + " is " + r.status + ".");
      const short = availability(s, r).filter((x) => !x.ok);
      r.status = "approved";
      r.history.push({ at: ctx.now, by: ctx.user.id, action: "Approved", note: text(p.note) + (short.length ? (p.note ? " · " : "") + "Short: " + short.map((x) => x.type).join(", ") : "") });
      addTx(s, ctx, "request", r.id + " approved", { req: r.id });
      return { notice: r.id + " approved" + (short.length ? " — not everything is available, so expect a partial pickup." : ".") };
    },

    "request.reject"(s, p, ctx) {
      const r = getReq(s, p.id) || fail("Unknown request.");
      if (!["pending", "approved"].includes(r.status)) fail(r.id + " is " + r.status + ".");
      if (s.loans.some((l) => l.req === r.id && l.status === "open")) fail("Items are out on " + r.id + ". Record their return first.");
      const reason = text(p.reason) || fail("Give a reason for the club.");
      r.status = "rejected";
      r.history.push({ at: ctx.now, by: ctx.user.id, action: "Rejected", note: reason });
      releaseHolds(s, r);
      addTx(s, ctx, "request", r.id + " rejected: " + reason, { req: r.id });
      return { notice: r.id + " rejected." };
    },

    "request.cancel"(s, p, ctx) {
      const r = getReq(s, p.id) || fail("Unknown request.");
      if (!["pending", "approved"].includes(r.status)) fail(r.id + " is " + r.status + ".");
      if (s.loans.some((l) => l.req === r.id && l.status === "open")) fail("Items are out on " + r.id + ". Record their return first.");
      const reason = text(p.reason) || fail("Give a reason.");
      r.status = "cancelled";
      r.history.push({ at: ctx.now, by: ctx.user.id, action: "Cancelled", note: reason });
      releaseHolds(s, r);
      addTx(s, ctx, "request", r.id + " cancelled: " + reason, { req: r.id });
      return { notice: r.id + " cancelled." };
    },

    "request.modify"(s, p, ctx) {
      const r = getReq(s, p.id) || fail("Unknown request.");
      if (!["pending", "approved"].includes(r.status)) fail("Only pending or approved requests can change.");
      const changes = [];
      if (Array.isArray(p.items)) {
        const items = p.items.filter((t) => types(s).includes(t));
        if (!items.length) fail("Keep at least one item.");
        const outNow = {};
        for (const l of s.loans.filter((l) => l.req === r.id && l.status === "open")) {
          const t = getAsset(s, l.asset).type;
          outNow[t] = (outNow[t] || 0) + 1;
        }
        for (const [t, n] of Object.entries(outNow))
          if (items.filter((x) => x === t).length < n) fail("Can’t drop " + t + ": it’s already out.");
        if (items.join("|") !== r.items.join("|")) {
          changes.push("Items: " + r.items.join(", ") + " → " + items.join(", "));
          r.items = items;
        }
      }
      for (const k of ["pickup", "due"])
        if (p[k] && p[k] !== r[k]) {
          if (!isIso(p[k])) fail("Enter a valid " + k + " time.");
          changes.push(k === "due" ? "Return time changed" : "Pickup time changed");
          r[k] = new Date(p[k]).toISOString();
        }
      if (ms(r.due) <= ms(r.pickup)) fail("Return time must be after pickup.");
      if (typeof p.note === "string" && text(p.note) !== r.note) {
        r.note = text(p.note);
        changes.push("Note updated");
      }
      if (!changes.length) fail("Nothing changed.");
      r.history.push({ at: ctx.now, by: ctx.user.id, action: "Modified", note: changes.join("; ") });
      addTx(s, ctx, "request", r.id + " modified · " + changes.join("; "), { req: r.id });
      return { notice: r.id + " updated." };
    },

    "maintenance.update"(s, p, ctx) {
      const t = s.tickets.find((k) => k.id === p.id) || fail("Unknown ticket.");
      if (["closed", "cancelled"].includes(t.status)) fail(t.id + " is closed.");
      if (!["open", "in_progress", "repaired"].includes(p.status)) fail("Choose a status.");
      const a = getAsset(s, t.asset);
      const parts = [];
      if (p.status !== t.status) parts.push(TICKET_STATUSES[p.status]);
      if (typeof p.technician === "string" && text(p.technician, 80) !== t.technician) {
        t.technician = text(p.technician, 80);
        parts.push("Technician: " + (t.technician || "none"));
      }
      if (p.eta !== undefined) {
        const eta = isIso(p.eta) ? new Date(p.eta).toISOString() : null;
        if (eta !== t.eta) {
          t.eta = eta;
          parts.push(eta ? "Expected back updated" : "Expected date cleared");
        }
      }
      if (text(p.note)) parts.push(text(p.note));
      if (!parts.length) fail("Nothing changed.");
      t.status = p.status;
      t.history.push({ at: ctx.now, by: ctx.user.id, text: parts.join(" · ") });
      if (p.status === "in_progress" || p.status === "repaired") {
        a.status = "maintenance";
        a.reason = p.status === "repaired" ? "Repaired · awaiting manager release (" + t.id + ")" : "In repair: " + t.issue + (t.technician ? " · " + t.technician : "");
      }
      a.expected = t.eta;
      addTx(s, ctx, "maintenance", t.id + " " + a.id + ": " + parts.join(" · "), { asset: a.id, ticket: t.id });
      return { notice: t.id + " updated." };
    },

    "maintenance.release"(s, p, ctx) {
      const t = s.tickets.find((k) => k.id === p.id) || fail("Unknown ticket.");
      if (["closed", "cancelled"].includes(t.status)) fail(t.id + " is closed.");
      const a = getAsset(s, t.asset);
      t.status = "closed";
      t.history.push({ at: ctx.now, by: ctx.user.id, text: "Cleared and released to the shelf" + (text(p.note) ? " · " + text(p.note) : "") });
      Object.assign(a, { status: "available", reason: "", expected: null, reservedFor: null, condition: "good" });
      addTx(s, ctx, "maintenance", t.id + " closed · " + a.id + " released", { asset: a.id, ticket: t.id });
      return { notice: a.id + " cleared and back on shelf " + a.bin + "." };
    },

    "maintenance.retire"(s, p, ctx) {
      const t = s.tickets.find((k) => k.id === p.id) || fail("Unknown ticket.");
      if (["closed", "cancelled"].includes(t.status)) fail(t.id + " is closed.");
      const reason = text(p.note) || fail("Say why it’s being retired.");
      const a = getAsset(s, t.asset);
      t.status = "closed";
      t.history.push({ at: ctx.now, by: ctx.user.id, text: "Retired · " + reason });
      Object.assign(a, { status: "retired", reason, expected: null, reservedFor: null });
      addTx(s, ctx, "maintenance", t.id + " closed · " + a.id + " retired", { asset: a.id, ticket: t.id });
      return { notice: a.id + " retired." };
    },

    "txn.reverse"(s, p, ctx) {
      const t = s.log.find((x) => x.id === p.tx) || fail("Unknown transaction.");
      const reason = text(p.reason);
      if (reason.length < 3) fail("Give a reason for the reversal — it goes in the audit log.");
      const why = reverseBlocker(s, t, ctx.user);
      if (why) fail(why);
      const u = t.undo;
      if (t.kind === "issue") {
        for (const num of t.refs.loans) {
          const l = getLoan(s, num);
          l.status = "void";
          l.voidedAt = ctx.now;
          Object.assign(getAsset(s, l.asset), u.prev[l.asset]);
        }
      } else if (t.kind === "return") {
        for (const it of u.items) {
          const l = getLoan(s, it.loan);
          l.status = "open";
          for (const k of ["returnedAt", "returnedBy", "receivedBy", "condition", "missing", "remarks", "returnTx"]) delete l[k];
          Object.assign(getAsset(s, l.asset), it.prev);
          if (it.ticket) {
            const k = s.tickets.find((x) => x.id === it.ticket);
            k.status = "cancelled";
            k.history.push({ at: ctx.now, by: ctx.user.id, text: "Cancelled by reversal of " + t.id });
          }
          for (const id of it.tasks) {
            const k = s.tasks.find((x) => x.id === id);
            k.status = "pending";
            delete k.doneAt;
            delete k.doneBy;
            delete k.doneNote;
          }
        }
      } else if (t.kind === "asset") {
        Object.assign(getAsset(s, u.asset), u.prev);
        if (u.ticket) {
          const k = s.tickets.find((x) => x.id === u.ticket);
          k.status = "cancelled";
          k.history.push({ at: ctx.now, by: ctx.user.id, text: "Cancelled by reversal of " + t.id });
        }
      }
      const id = addTx(s, ctx, "reversal", "Reversed " + t.id + " (" + t.summary + ") · " + reason, { ...t.refs, reverses: t.id });
      s.log[s.log.length - 1].reverses = t.id;
      s.log[s.log.length - 1].reason = reason;
      t.reversedBy = id;
      return { tx: id, notice: t.id + " reversed · recorded as " + id + "." };
    },

    "settings.update"(s, p, ctx) {
      const next = { ...s.settings };
      if (p.tz !== undefined) {
        if (!validZone(p.tz)) fail("Unknown time zone.");
        next.tz = p.tz;
      }
      if (p.locale !== undefined) {
        if (p.locale) {
          try {
            next.locale = Intl.getCanonicalLocales(p.locale)[0];
          } catch {
            fail("Unknown language/region code.");
          }
        } else next.locale = "";
      }
      if (p.clock !== undefined) {
        if (!["story", "live"].includes(p.clock)) fail("Unknown clock mode.");
        next.clock = p.clock;
      }
      s.settings = next;
      addTx(s, ctx, "settings", "Settings updated");
      return { notice: "Settings saved." };
    },

    "user.setRole"(s, p, ctx) {
      const u = getUser(s, p.id) || fail("Unknown user.");
      if (!ROLES[p.role]) fail("Unknown role.");
      if (u.role === "admin" && p.role !== "admin" && s.users.filter((x) => x.role === "admin").length === 1)
        fail("Keep at least one admin.");
      const from = u.role;
      u.role = p.role;
      addTx(s, ctx, "settings", u.name + ": " + ROLES[from] + " → " + ROLES[p.role]);
      return { notice: u.name + " is now " + ROLES[p.role] + "." };
    },

    "story.advance"(s, p, ctx) {
      if (s.story.phase >= PHASES.length - 1) fail("This is the last moment of the sample shift.");
      s.story.phase++;
      for (const m of STORY_MESSAGES[s.story.phase] || [])
        s.notes.push(note(s, m.at, "message", m.author, m.req, m.text));
      return { notice: "Desk time moved on." };
    },
  };

  function releaseHolds(s, r) {
    for (const a of s.assets)
      if (a.status === "reserved" && a.reservedFor === r.id)
        Object.assign(a, { status: "available", reservedFor: null, reason: "" });
  }

  /** "" if this user may reverse this transaction now, else why not. */
  function reverseBlocker(s, t, user) {
    if (!REVERSIBLE.has(t.kind) || !t.undo) return "This kind of record can’t be reversed. Make a new correcting entry instead.";
    if (t.reversedBy) return t.id + " was already reversed by " + t.reversedBy + ".";
    if (RANK[user.role] < 2) {
      const mine = s.log.filter((x) => x.by === user.id && REVERSIBLE.has(x.kind) && !x.reversedBy && x.undo);
      if (t.by !== user.id || mine[mine.length - 1] !== t)
        return "Desk operators can only reverse their own latest record. Ask a store manager.";
    }
    if (t.kind === "issue") {
      for (const num of t.refs.loans) {
        const l = getLoan(s, num);
        if (l.status !== "open") return "L-" + num + " has been returned since. Reverse that return first.";
      }
    }
    if (t.kind === "return") {
      for (const it of t.undo.items) {
        const l = getLoan(s, it.loan);
        if (l.status !== "returned" || l.returnTx !== t.id) return "L-" + it.loan + " has changed since.";
        if (s.loans.some((x) => x.asset === l.asset && x.num !== l.num && x.status !== "void" && x.issuedAt >= l.returnedAt))
          return l.asset + " has been issued again since.";
        if (it.ticket) {
          const k = s.tickets.find((x) => x.id === it.ticket);
          if (k.status !== "open" || k.history.length > 1) return k.id + " has been worked on since. Update the ticket instead.";
        }
      }
    }
    if (t.kind === "asset") {
      const a = getAsset(s, t.undo.asset);
      if (a.status !== t.undo.set || openLoan(s, a.id)) return a.id + " has changed since.";
      if (t.undo.ticket) {
        const k = s.tickets.find((x) => x.id === t.undo.ticket);
        if (k.status !== "open" || k.history.length > 1) return k.id + " has been worked on since.";
      }
    }
    return "";
  }

  /** Light structural check before trusting stored or received data. */
  function validState(d) {
    return (
      !!d &&
      d.schema === SCHEMA &&
      Number.isInteger(d.rev) &&
      d.settings &&
      d.story &&
      PHASES[d.story.phase] !== undefined &&
      ["users", "people", "assets", "requests", "loans", "tickets", "tasks", "notes", "log", "seenOps"].every((k) => Array.isArray(d[k])) &&
      d.loans.every((l) => d.requests.some((r) => r.id === l.req) && d.assets.some((a) => a.id === l.asset) && isIso(l.due))
    );
  }

  return {
    SCHEMA,
    ROLES,
    RANK,
    NEEDS,
    STATUSES,
    CONDITIONS,
    PRIORITIES,
    TICKET_STATUSES,
    PHASES,
    DomainError,
    seed,
    apply,
    can,
    validState,
    nowFor,
    zonedToUtc,
    utcToZoned,
    validZone,
    getAsset,
    getReq,
    getLoan,
    getUser,
    userName,
    openLoan,
    isOverdue,
    types,
    assetView,
    issueBlocker,
    kitLines,
    requestStage,
    availability,
    handoverItems,
    toAcknowledge,
    metrics,
    notifications,
    reports,
    reverseBlocker,
  };
});
