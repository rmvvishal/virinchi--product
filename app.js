/*
 * Campus Stores desk UI.
 *
 * Rules live in domain.js (shared with the server). This file renders the
 * desk, collects input, and sends operations to the store:
 *   - local mode (open index.html): browser storage, synced across tabs;
 *   - server mode (node server.js): shared database, logins, live updates.
 */
(() => {
  "use strict";
  const D = window.CampusDomain;
  const root = document.getElementById("campus-stores");
  const $ = (sel, el = root) => el.querySelector(sel);
  const $$ = (sel, el = root) => [...el.querySelectorAll(sel)];
  const dialog = $("[data-dialog]");
  const KEY = "campus-stores.v3";

  // ------------------------------------------------------------ helpers
  const esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const attr = (o) =>
    Object.entries(o)
      .filter(([, v]) => v !== false && v !== null && v !== undefined)
      .map(([k, v]) => (v === true ? " " + k : " " + k + '="' + esc(v) + '"'))
      .join("");
  const icon = (n) =>
    '<svg aria-hidden="true" class="store-icon"><use href="#icon-' + n + '"></use></svg>';
  const btn = (label, act, val = "", cls = "", extra = {}) =>
    "<button" + attr({ type: "button", "data-action": act, "data-val": val, class: cls, ...extra }) + ">" + esc(label) + "</button>";
  const badge = (t, tone = "") => '<span class="tag ' + tone + '">' + esc(t) + "</span>";
  const opts = (list, chosen = "") =>
    list
      .map(([v, t, off]) => "<option" + attr({ value: v, selected: String(v) === String(chosen), disabled: !!off }) + ">" + esc(t) + "</option>")
      .join("");
  const field = (label, control, cls = "") =>
    '<label class="' + cls + '"><span>' + esc(label) + "</span>" + control + "</label>";
  const sel = (name, list, chosen = "", extra = {}) =>
    "<select" + attr({ name, ...extra }) + ">" + opts(list, chosen) + "</select>";
  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const ms = (iso) => Date.parse(iso);
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

  // ------------------------------------------------------- formatting
  const locale = () => (S && S.settings.locale) || navigator.language || "en";
  const tz = () => (S ? S.settings.tz : "UTC");
  const fmt = (iso, o) => (iso ? new Intl.DateTimeFormat(locale(), { timeZone: tz(), ...o }).format(new Date(iso)) : "—");
  const dt = (iso) => fmt(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const dateOnly = (iso) => fmt(iso, { day: "numeric", month: "short", year: "numeric" });
  const clockText = (iso) => fmt(iso, { weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const num = (n) => new Intl.NumberFormat(locale()).format(n);
  const pctU = (n) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(n);
  const pct = (n) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(n);
  function rel(iso) {
    const diff = (ms(iso) - ms(now())) / 60000;
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
    const a = Math.abs(diff);
    if (a < 60) return rtf.format(Math.round(diff), "minute");
    if (a < 48 * 60) return rtf.format(Math.round(diff / 60), "hour");
    return rtf.format(Math.round(diff / 1440), "day");
  }
  const toInput = (iso) => (iso ? D.utcToZoned(iso, tz()) : "");
  const fromInput = (v) => (v ? D.zonedToUtc(v, tz()) : null);

  // ---------------------------------------------------------- the store
  let S = null; // domain state
  let me = null; // signed-in staff member {id, name, role}
  let mode = "local";
  let busy = false;
  const ui = loadUi();

  function loadUi() {
    const base = { page: "dashboard", request: null, f: {}, dismissed: {} };
    try {
      return { ...base, ...JSON.parse(localStorage.getItem(KEY + ".ui") || "{}") };
    } catch {
      return base;
    }
  }
  function saveUi() {
    try {
      localStorage.setItem(KEY + ".ui", JSON.stringify({ page: ui.page, request: ui.request, f: ui.f, dismissed: ui.dismissed }));
    } catch {
      /* per-viewer conveniences only */
    }
  }
  const now = () => D.nowFor(S);

  const Local = {
    storageOk: true,
    channel: "BroadcastChannel" in window ? new BroadcastChannel(KEY) : null,
    read() {
      try {
        const d = JSON.parse(localStorage.getItem(KEY) || "null");
        return D.validState(d) ? d : null;
      } catch {
        return null;
      }
    },
    write(state) {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
        this.storageOk = true;
      } catch {
        this.storageOk = false;
      }
    },
    init() {
      S = this.read() || D.seed();
      this.write(S);
      let id = "";
      try {
        id = localStorage.getItem(KEY + ".user") || "";
      } catch {
        /* ignore */
      }
      me = D.getUser(S, id) || D.getUser(S, D.PHASES[S.story.phase].staff);
      const refresh = () => {
        const d = this.read();
        if (d && d.rev !== S.rev) {
          S = d;
          me = D.getUser(S, me.id) || me;
          paint();
        }
      };
      if (this.channel) this.channel.onmessage = refresh;
      window.addEventListener("storage", (e) => e.key === KEY && refresh());
    },
    async send(op) {
      // Re-read first: another tab may have issued the same unit a moment ago.
      const latest = this.read();
      if (latest && latest.rev > S.rev) S = latest;
      const res = D.apply(S, op, { user: me, now: D.nowFor(S) });
      S = res.state;
      this.write(S);
      if (this.channel) this.channel.postMessage({ rev: S.rev });
      return res;
    },
    setUser(id) {
      me = D.getUser(S, id) || me;
      try {
        localStorage.setItem(KEY + ".user", me.id);
      } catch {
        /* ignore */
      }
    },
  };

  const Remote = {
    events: null,
    async init() {
      const r = await fetch("api/session", { credentials: "same-origin" });
      if (r.status === 401) return false;
      const d = await r.json();
      me = d.user;
      S = d.state;
      this.listen();
      return true;
    },
    listen() {
      if (this.events) this.events.close();
      this.events = new EventSource("api/events");
      this.events.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.state && (!S || d.state.rev > S.rev)) {
          S = d.state;
          if (d.users) me = d.users.find((u) => u.id === me.id) || me;
          paint();
        }
      };
      this.events.onerror = () => setMode("Reconnecting to the server…", true);
      this.events.onopen = () => setMode();
    },
    async send(op) {
      const r = await fetch("api/ops", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Campus-Stores": "1" },
        body: JSON.stringify(op),
      });
      const d = await r.json().catch(() => ({ error: "The server sent an unreadable reply." }));
      if (r.status === 401) {
        location.reload();
        throw new D.DomainError("Your session ended. Sign in again.");
      }
      if (d.state) S = d.state;
      if (!r.ok) throw new D.DomainError(d.error || "The server refused that change.");
      return d;
    },
  };
  const store = () => (mode === "remote" ? Remote : Local);

  /** Send one operation. Guards against double clicks and shows the outcome. */
  async function dispatch(type, payload, opts = {}) {
    if (busy) return null;
    busy = true;
    $$("button[type=submit], [data-action]").forEach((b) => b.setAttribute("aria-disabled", "true"));
    try {
      const res = await store().send({ type, payload, id: opts.opId || uid() });
      const actions = [];
      if (res.receipt) actions.push(["Print receipt", "print-receipt", res.receipt.tx]);
      if (res.tx && !D.reverseBlocker(S, S.log.find((t) => t.id === res.tx) || {}, me)) actions.push(["Reverse", "reverse", res.tx]);
      flash(res.notice || "Saved.", res.duplicate ? "warn" : "ok", actions);
      if (opts.close) closeDialog();
      paint();
      return res;
    } catch (e) {
      const msg = e instanceof D.DomainError ? e.message : "Something went wrong: " + (e && e.message);
      if (opts.inDialog && dialog.open) {
        const box = $("[data-dlg-error]", dialog);
        if (box) {
          box.textContent = msg;
          box.hidden = false;
          box.focus();
        }
      } else {
        flash(msg, "error");
        paint();
        $("[data-flash]").focus();
      }
      if (!(e instanceof D.DomainError)) console.error(e);
      return null;
    } finally {
      busy = false;
      $$("[aria-disabled=true]").forEach((b) => b.removeAttribute("aria-disabled"));
    }
  }

  let flashMsg = null;
  function flash(text, kind = "ok", actions = []) {
    flashMsg = { text, kind, actions };
  }
  function setMode(text, warn) {
    const m = $("[data-mode]");
    m.textContent =
      text ||
      (mode === "remote"
        ? "Connected to the desk server · changes appear on every screen live."
        : Local.storageOk
          ? "Sample shift · All records are fictional · Saved in this browser and synced across its tabs."
          : "Browser storage is unavailable. Progress lasts for this visit.");
    m.classList.toggle("warn-text", !!warn);
  }

  // -------------------------------------------------------------- pages
  const PAGES = [
    { key: "dashboard", label: "Dashboard", icon: "gauge", group: "Desk" },
    { key: "requests", label: "Requests", icon: "clipboard-list", group: "Desk" },
    { key: "returns", label: "Returns", icon: "undo", group: "Desk" },
    { key: "loans", label: "Loan register", icon: "book-open", group: "Desk" },
    { key: "deskbook", label: "Desk book", icon: "messages-square", group: "Desk" },
    { key: "inventory", label: "Inventory", icon: "package", group: "Stock" },
    { key: "maintenance", label: "Maintenance", icon: "wrench", group: "Stock" },
    { key: "reports", label: "Reports", icon: "chart", group: "Admin", role: 2 },
    { key: "activity", label: "Activity log", icon: "history", group: "Admin" },
    { key: "settings", label: "Settings", icon: "settings", group: "Admin", role: 3 },
  ];
  const canSee = (p) => !p.role || D.RANK[me.role] >= p.role;
  const can = (type) => D.can(me, type);
  const F = (page) => (ui.f[page] = ui.f[page] || {});

  const head = (title, sub = "", control = "") =>
    '<div class="sectionhead"><div><h2 tabindex="-1" data-pagehead>' + esc(title) + "</h2>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>" + (control ? '<div class="headtools">' + control + "</div>" : "") + "</div>";
  const empty = (msg, clear) =>
    '<p class="empty">' + esc(msg) + (clear ? " " + btn("Clear filters", "clear-filters", clear, "linkish") : "") + "</p>";
  const tone = (state) =>
    ({ available: "good", "on-loan": "info", reserved: "info", damaged: "bad", maintenance: "warn", missing: "bad", retired: "" })[state] || "";
  const stageTone = (k) =>
    ({ pending: "warn", approved: "info", partial: "warn", fulfilled: "info", closed: "good", rejected: "", cancelled: "" })[k] || "";
  const assetLabel = (a) => a.id + " · " + a.type;
  const unitLink = (id) => btn(id, "asset", id, "linkish mono");
  const reqLink = (id) => btn(id, "open-request", id, "linkish mono");
  const loanStatus = (l) =>
    l.status === "void"
      ? badge("Reversed")
      : l.status === "returned"
        ? badge(l.condition && l.condition !== "good" ? D.CONDITIONS[l.condition] : "Returned", l.condition && l.condition !== "good" ? "bad" : "good")
        : D.isOverdue(l, now())
          ? badge("Overdue " + rel(l.due).replace(/^in /, ""), "bad")
          : badge("Out · due " + rel(l.due), "info");

  // ---- Dashboard
  function dashboard() {
    const m = D.metrics(S, now());
    const hour = Number(fmt(now(), { hour: "numeric", hourCycle: "h23" }));
    const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    let h = head(greet + ", " + me.name.split(" ")[0], D.ROLES[me.role] + " · " + clockText(now()));
    const ack = D.toAcknowledge(S, me, now());
    if (ack.length)
      h += '<div class="callout warn"><div><b>Handover waiting for you.</b> ' + esc(ack.length + " item" + (ack.length > 1 ? "s" : "") + " from the previous shift.") + "</div>" + btn("Read and acknowledge", "go", "deskbook", "primary") + "</div>";
    const tile = (label, n, page, filter, toneCls = "") =>
      "<button" + attr({ type: "button", class: "tile " + toneCls, "data-action": "tile", "data-val": page + "|" + (filter || "") }) + "><b>" + esc(num(n)) + "</b><span>" + esc(label) + "</span></button>";
    h +=
      '<div class="tiles">' +
      tile("Total equipment", m.total, "inventory", "") +
      tile("Available", m.available, "inventory", "available") +
      tile("On loan", m.onLoan, "loans", "open") +
      tile("Reserved", m.reserved, "inventory", "reserved") +
      tile("Damaged or in repair", m.repair, "maintenance", "") +
      tile("Overdue returns", m.overdue, "loans", "overdue", m.overdue ? "alert" : "") +
      tile("Pending requests", m.pending, "requests", "pending") +
      tile("Approved, to issue", m.toIssue, "requests", "toissue") +
      "</div>";
    h +=
      '<div class="quick" role="group" aria-label="Quick actions">' +
      btn("Process pickup", "tile", "requests|toissue", "primary") +
      btn("Record return", "go", "returns") +
      btn("Check inventory", "go", "inventory") +
      btn("View overdue", "tile", "loans|overdue") +
      "<button" + attr({ type: "button", "data-action": "scan-lookup" }) + ">" + icon("scan") + " Scan a label</button>" +
      "</div>";
    const notes = D.notifications(S, me, now()).filter((n) => !dismissed(n.id));
    h += '<div class="cols"><section class="panel"><h3>Needs attention</h3>' + (notes.length ? '<ul class="plain">' + notes.slice(0, 6).map(noteItem).join("") + "</ul>" : empty("Nothing needs attention right now.")) + "</section>";
    const pick = S.requests
      .filter((r) => r.status === "approved" && ["approved", "partial"].includes(D.requestStage(S, r).key) && ms(r.due) > ms(now()))
      .sort((a, b) => ms(a.pickup) - ms(b.pickup));
    h +=
      '<section class="panel"><h3>Pickups to issue</h3>' +
      (pick.length
        ? '<ul class="plain">' + pick.map((r) => "<li>" + btn(r.id + " · " + r.club + " · " + r.event, "open-request", r.id, "linkish") + "<small>Pickup " + esc(dt(r.pickup)) + " · " + esc(D.requestStage(S, r).label) + "</small></li>").join("") + "</ul>"
        : empty("No pickups waiting.")) +
      "</section>";
    const out = S.loans.filter((l) => l.status === "open").sort((a, b) => ms(a.due) - ms(b.due));
    h +=
      '<section class="panel"><h3>Out now</h3>' +
      (out.length
        ? '<ul class="plain">' + out.map((l) => { const a = D.getAsset(S, l.asset); return "<li><span>" + unitLink(a.id) + " " + esc(a.type) + " · " + esc(l.borrower) + "</span>" + loanStatus(l) + "</li>"; }).join("") + "</ul>"
        : empty("Nothing is out.")) +
      "</section>";
    const recent = S.log.filter((t) => ms(t.at) <= ms(now())).slice(-6).reverse();
    h += '<section class="panel"><h3>Recent activity</h3><ul class="plain">' + recent.map((t) => "<li><span><b class=mono>" + esc(t.id) + "</b> " + esc(t.summary) + "</span><small>" + esc(dt(t.at) + " · " + D.userName(S, t.by)) + "</small></li>").join("") + "</ul>" + btn("Open activity log", "go", "activity", "linkish") + "</section></div>";
    return h;
  }
  const dismissed = (id) => (ui.dismissed[me.id] || []).includes(id);
  const noteItem = (n) =>
    '<li class="note ' + n.level + '"><span class="dot" aria-hidden="true"></span>' + btn(n.text, "notif", n.page + "|" + n.ref, "linkish") + "</li>";

  // ---- Requests
  const REQ_FILTERS = [
    ["open", "Open"],
    ["pending", "Pending"],
    ["toissue", "To issue"],
    ["out", "Out now"],
    ["closed", "Closed"],
    ["rejected", "Rejected or cancelled"],
    ["all", "All"],
  ];
  function requests() {
    if (ui.request && D.getReq(S, ui.request)) return requestDetail(D.getReq(S, ui.request));
    const f = F("requests");
    const status = f.status || "open";
    const q = (f.q || "").toLowerCase().trim();
    const list = S.requests
      .filter((r) => {
        const st = D.requestStage(S, r).key;
        const m = {
          open: r.status === "pending" || ["approved", "partial", "fulfilled"].includes(st),
          pending: st === "pending",
          toissue: st === "approved" || st === "partial",
          out: st === "fulfilled" || st === "partial",
          closed: st === "closed",
          rejected: st === "rejected" || st === "cancelled",
          all: true,
        }[status];
        return m && (!q || [r.id, r.club, r.event, r.owner, ...r.items].join(" ").toLowerCase().includes(q));
      })
      .sort((a, b) => ms(b.pickup) - ms(a.pickup));
    let h = head("Requests", "Student Activities Office · approval to return", can("request.create") ? btn("New request", "new-request", "", "primary") : "");
    h +=
      '<div class="filters">' +
      '<div class="seg" role="group" aria-label="Request status">' + REQ_FILTERS.map(([k, t]) => btn(t, "filter", "requests|status|" + k, "", { "aria-pressed": String(status === k) })).join("") + "</div>" +
      '<label class="search"><span class="sr">Search requests</span><input type="search" data-filter="requests|q" value="' + esc(f.q || "") + '" placeholder="Club, event, person, item"></label></div>';
    if (!list.length) return h + empty("No requests match.", "requests");
    h += '<div class="tablewrap"><table><caption class="sr">Requests</caption><thead><tr><th scope="col">Request</th><th scope="col">Club · event</th><th scope="col">Pickup</th><th scope="col">Return by</th><th scope="col">Items</th><th scope="col">Stage</th></tr></thead><tbody>';
    for (const r of list) {
      const st = D.requestStage(S, r);
      h += "<tr><td>" + reqLink(r.id) + "</td><td><b>" + esc(r.club) + "</b><small>" + esc(r.event) + "</small></td><td>" + esc(dt(r.pickup)) + "</td><td>" + esc(dt(r.due)) + "</td><td>" + esc(r.items.length) + "</td><td>" + badge(st.label, stageTone(st.key)) + "</td></tr>";
    }
    return h + "</tbody></table></div>";
  }

  function requestDetail(r) {
    const st = D.requestStage(S, r);
    const lines = D.kitLines(S, r);
    let h = btn("← All requests", "close-request", "", "linkish back");
    const actions = [];
    if (r.status === "pending" && can("request.approve")) actions.push(btn("Approve", "approve", r.id, "primary"), btn("Reject", "reject", r.id));
    if (["pending", "approved"].includes(r.status) && can("request.modify")) actions.push(btn("Modify", "modify-request", r.id));
    if (["pending", "approved"].includes(r.status) && can("request.cancel") && !S.loans.some((l) => l.req === r.id && l.status === "open")) actions.push(btn("Cancel request", "cancel-request", r.id));
    h +=
      '<div class="sectionhead kithead"><div><small>' + esc(r.id + " · " + r.club) + '</small><h2 tabindex="-1" data-pagehead>' + esc(r.event) + "</h2><small>Filed by " + esc(r.owner) + " · Pickup " + esc(dt(r.pickup)) + " · Return by <b>" + esc(dt(r.due)) + "</b></small></div>" +
      '<div class="headtools">' + badge(st.label, stageTone(st.key)) + actions.join("") + "</div></div>";
    if (r.note) h += '<p class="reqnote">' + esc(r.note) + "</p>";
    const msgs = S.notes.filter((n) => n.req === r.id && ms(n.at) <= ms(now()));
    const handovers = S.tasks.filter((t) => t.loan && S.loans.some((l) => l.num === t.loan && l.req === r.id));
    if (msgs.length || handovers.length)
      h += '<div class="related"><b>Desk book</b>' + msgs.map((m) => "<p><small>" + esc(dt(m.at) + " · " + m.author) + "</small>" + esc(m.text) + "</p>").join("") + handovers.map((t) => "<p><small>" + esc(dt(t.createdAt) + " · Handover task " + t.id + " · " + (t.status === "done" ? "done" : "pending")) + "</small>" + esc(t.title + " — " + t.responsible) + "</p>").join("") + "</div>";

    if (r.status === "pending") {
      const av = D.availability(S, r);
      h += '<h3 class="kittitle">Availability check</h3><div class="tablewrap"><table><thead><tr><th scope="col">Item</th><th scope="col">Needed</th><th scope="col">Usable at pickup</th><th scope="col">Notes</th></tr></thead><tbody>' +
        av.map((x) => "<tr><td>" + esc(x.type) + "</td><td>" + x.need + "</td><td>" + badge(x.free.length + (x.ok ? " · OK" : " · short"), x.ok ? "good" : "bad") + " <small>" + esc(x.free.join(", ")) + "</small></td><td><small>" + esc(x.notes.join("; ") || "—") + "</small></td></tr>").join("") +
        "</tbody></table></div>";
      if (av.some((x) => !x.ok)) h += '<p class="hint">Not everything is available. You can still approve for a partial pickup, or modify the request.</p>';
    } else if (r.status === "approved") {
      h += '<h3 class="kittitle">Approved equipment</h3><div class="kit">';
      for (const { type, loan } of lines) h += kitLine(r, type, loan);
      h += "</div>";
      const open = lines.filter((x) => x.loan && x.loan.status === "open");
      if (open.length > 1) h += '<p class="rowactions">' + btn("Return several items…", "return", open.map((x) => x.loan.num).join(","), "") + "</p>";
      const todo = lines.filter((x) => !x.loan);
      if (todo.length && ms(r.due) > ms(now())) {
        const pickup = msgs.find((m) => /picking up/i.test(m.text));
        h +=
          '<form data-form="kit" id="kit-form" data-req="' + esc(r.id) + '" class="issuebar"><div class="form">' +
          field("Collected by", sel("who", [["", "Select…"], ...S.people.map((p) => [p.name, p.name + " · " + p.club])], "", { required: true })) +
          field("Return by", "<input" + attr({ type: "datetime-local", name: "due", required: true, value: toInput(r.due), min: toInput(now()) }) + ">") +
          "</div>" +
          (pickup ? '<p class="hint">Check ID at the counter. ' + esc(pickup.author.split(" · ")[0]) + " asked: “" + esc(pickup.text) + "”</p>" : "") +
          '<button type="submit" class="primary">Review and issue ' + (todo.length === lines.length ? "kit" : "remaining items") + "</button></form>";
      } else if (todo.length) h += '<p class="hint">This request’s return time has passed, so nothing more can be issued on it.</p>';
    } else {
      h += '<h3 class="kittitle">Requested equipment</h3><ul>' + r.items.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>";
    }
    h += '<details class="history"><summary>Request history (' + r.history.length + ")</summary><ol>" + r.history.map((x) => "<li><small>" + esc(dt(x.at) + " · " + D.userName(S, x.by)) + "</small>" + esc(x.action + (x.note ? " — " + x.note : "")) + "</li>").join("") + "</ol></details>";
    return h;
  }

  function kitLine(r, type, loan) {
    if (!loan || loan.status === "void") {
      const units = S.assets.filter((a) => a.type === type);
      const free = units.filter((a) => !D.issueBlocker(S, a, r.id));
      const choices = [["", "Not issuing now"], ...units.map((a) => {
        const v = D.assetView(S, a);
        return [a.id, a.id + " · " + a.model + " · " + (D.issueBlocker(S, a, r.id) ? v.label.toLowerCase() : "shelf " + a.bin + (a.status === "reserved" ? " · held for this request" : "")), !!D.issueBlocker(S, a, r.id)];
      })];
      return '<div class="kitline todo"><div><strong>' + esc(type) + "</strong><small>" + (free.length ? esc(free.length + " ready to issue") : '<span class="badtext">None available — partial pickup</span>') + '</small></div><label class="unitpick"><span class="sr">Unit for ' + esc(type) + "</span>" + sel("unit", choices, free.length ? free[0].id : "", { form: "kit-form" }) + "</label></div>";
    }
    const a = D.getAsset(S, loan.asset);
    let right = "";
    let extra = "";
    if (loan.status === "returned") {
      right = loanStatus(loan) + btn("Receipt", "print-receipt", loan.returnTx, "small");
      extra = "<small>Returned " + esc(dt(loan.returnedAt) + " by " + loan.returnedBy + " · received by " + D.userName(S, loan.receivedBy)) + (loan.missing && loan.missing.length ? " · missing " + esc(loan.missing.join(", ")) : "") + "</small>";
    } else {
      right = loanStatus(loan) + btn("Record return", "return", String(loan.num), "", { "aria-label": "Record return of " + a.id + " " + a.type });
      if (loan.expect) extra += '<small class="expected">' + esc(loan.expect.who + " is bringing it back " + dt(loan.expect.when)) + "</small>";
      extra += expectForm(loan);
    }
    return '<div class="kitline ' + (loan.status === "returned" ? "done" : "out") + '"><div><strong>' + esc(type) + "</strong><small>" + unitLink(a.id) + " " + esc(a.model + " · slip L-" + loan.num + " · " + loan.borrower + " · due " + dt(loan.due)) + "</small>" + extra + '</div><div class="rowend">' + right + "</div></div>";
  }
  function expectForm(l) {
    return (
      '<details class="expect"><summary>' + (l.expect ? "Change who’s returning it" : "Someone else is returning it?") + '</summary><form data-form="expect" data-loan="' + l.num + '" class="inline">' +
      field("Bringing it back", sel("who", [["", "Select…"], ...S.people.map((p) => [p.name, p.name])], l.expect ? l.expect.who : "", { required: true })) +
      field("Expected", "<input" + attr({ type: "datetime-local", name: "when", required: true, value: l.expect ? toInput(l.expect.when) : "" }) + ">") +
      '<button type="submit">Save for next shift</button></form></details>'
    );
  }

  // ---- Returns
  function returns() {
    const f = F("returns");
    let h = head("Returns", "Scan or type the ID on the label, then check condition and accessories");
    h +=
      '<form data-form="return-lookup" class="lookup"><label><span>Unit ID</span><input name="id" autocomplete="off" autocapitalize="characters" placeholder="e.g. AD-12" required data-autofocus></label>' +
      '<button type="submit" class="primary">Find slip</button><button type="button" data-action="scan-into" data-val="return-lookup">' + icon("scan") + " Scan</button></form>";
    const q = (f.q || "").toLowerCase().trim();
    const open = S.loans
      .filter((l) => l.status === "open")
      .filter((l) => !q || searchLoan(l).includes(q))
      .sort((a, b) => ms(a.due) - ms(b.due));
    h += '<div class="filters"><label class="search"><span class="sr">Find by person</span><input type="search" data-filter="returns|q" value="' + esc(f.q || "") + '" placeholder="Who’s at the counter? Name, club or request"></label></div>';
    if (!open.length) return h + empty(q ? "No open slips match." : "Nothing is out right now.", q ? "returns" : "");
    const groups = {};
    for (const l of open) (groups[l.req] = groups[l.req] || []).push(l);
    for (const [reqId, loans] of Object.entries(groups)) {
      const r = D.getReq(S, reqId);
      h += '<section class="panel group"><div class="grouphead"><div><b>' + esc(r.club + " · " + r.event) + "</b><small>" + reqLink(r.id) + " issued to " + esc([...new Set(loans.map((l) => l.borrower))].join(", ")) + "</small></div>" + (loans.length > 1 ? btn("Return all " + loans.length + "…", "return", loans.map((l) => l.num).join(",")) : "") + "</div>";
      for (const l of loans) {
        const a = D.getAsset(S, l.asset);
        h += '<div class="row"><div><strong>' + esc("L-" + l.num + " · " + assetLabel(a)) + "</strong><small>" + esc(a.model + " · due " + dt(l.due)) + "</small>" + (l.expect ? '<small class="expected">' + esc(l.expect.who + " is bringing it back " + dt(l.expect.when)) + "</small>" : "") + '</div><div class="rowend">' + loanStatus(l) + btn("Record return", "return", String(l.num), "primary", { "aria-label": "Record return of " + a.id + " " + a.type }) + "</div></div>";
      }
      h += "</section>";
    }
    return h;
  }
  function searchLoan(l) {
    const a = D.getAsset(S, l.asset);
    const r = D.getReq(S, l.req);
    return ["L-" + l.num, a.id, a.type, a.model, r.id, r.club, r.event, l.borrower, l.expect ? l.expect.who : "", l.returnedBy || ""].join(" ").toLowerCase();
  }

  // ---- Loan register
  function loans() {
    const f = F("loans");
    const status = f.status || "open";
    const q = (f.q || "").toLowerCase().trim();
    const n = now();
    const list = S.loans
      .filter((l) => {
        const a = D.getAsset(S, l.asset);
        const r = D.getReq(S, l.req);
        if (status === "open" && l.status !== "open") return false;
        if (status === "overdue" && !D.isOverdue(l, n)) return false;
        if (status === "returned" && l.status !== "returned") return false;
        if (status === "void" && l.status !== "void") return false;
        if (status === "damaged" && !(l.status === "returned" && l.condition !== "good")) return false;
        if (f.type && a.type !== f.type) return false;
        if (f.club && r.club !== f.club) return false;
        if (f.from && ms(l.issuedAt) < ms(fromInput(f.from + "T00:00"))) return false;
        if (f.to && ms(l.issuedAt) > ms(fromInput(f.to + "T23:59"))) return false;
        return !q || searchLoan(l).includes(q);
      })
      .sort((a, b) => (a.status === "open") !== (b.status === "open") ? (a.status === "open" ? -1 : 1) : a.status === "open" ? ms(a.due) - ms(b.due) : b.num - a.num);
    let h = head("Loan register", "One slip per physical unit", btn("Export CSV", "export", "loans") + btn("Print", "print-view", "loans"));
    h += filterBar("loans", [
      ["status", "Status", [["open", "Open"], ["overdue", "Overdue"], ["returned", "Returned"], ["damaged", "Returned damaged"], ["void", "Reversed"], ["all", "All"]], status],
      ["type", "Category", [["", "All categories"], ...D.types(S).map((t) => [t, t])], f.type || ""],
      ["club", "Club", [["", "All clubs"], ...[...new Set(S.requests.map((r) => r.club))].sort().map((c) => [c, c])], f.club || ""],
    ], true, "Borrower, unit, slip, request");
    h += '<p class="count" aria-live="polite">' + esc(list.length + " slip" + (list.length === 1 ? "" : "s")) + "</p>";
    if (!list.length) return h + empty("No slips match these filters.", "loans");
    h += '<div class="tablewrap"><table><caption class="sr">Loan slips</caption><thead><tr><th scope="col">Slip</th><th scope="col">Unit</th><th scope="col">Request</th><th scope="col">Borrower</th><th scope="col">Issued</th><th scope="col">Due / returned</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>';
    for (const l of list) {
      const a = D.getAsset(S, l.asset);
      const r = D.getReq(S, l.req);
      h +=
        "<tr" + (D.isOverdue(l, n) ? ' class="late"' : "") + "><td class=mono>L-" + l.num + "</td><td>" + unitLink(a.id) + "<small>" + esc(a.type) + "</small></td><td>" + reqLink(r.id) + "<small>" + esc(r.club) + "</small></td><td>" + esc(l.borrower) + (l.expect && l.status === "open" ? '<small class="expected">' + esc(l.expect.who + " returning " + dt(l.expect.when)) + "</small>" : "") + "</td><td>" + esc(dt(l.issuedAt)) + "<small>" + esc(D.userName(S, l.issuedBy)) + "</small></td><td>" +
        esc(l.status === "returned" ? dt(l.returnedAt) : dt(l.due)) + (l.status === "returned" ? "<small>by " + esc(l.returnedBy) + "</small>" : "") + "</td><td>" + loanStatus(l) + '</td><td class="acts">' +
        (l.status === "open" ? btn("Return", "return", String(l.num), "small", { "aria-label": "Record return of " + a.id }) : "") +
        btn("Receipt", "print-receipt", l.status === "returned" ? l.returnTx : l.issueTx, "small", { "aria-label": "Receipt for L-" + l.num }) +
        "</td></tr>";
    }
    return h + "</tbody></table></div>";
  }
  function filterBar(page, selects, dates, placeholder) {
    const f = F(page);
    let h = '<div class="filters">';
    for (const [k, label, list, v] of selects) h += field(label, sel("", list, v, { "data-filter": page + "|" + k }), "compact");
    if (dates)
      h += field("From", "<input" + attr({ type: "date", "data-filter": page + "|from", value: f.from || "" }) + ">", "compact") + field("To", "<input" + attr({ type: "date", "data-filter": page + "|to", value: f.to || "" }) + ">", "compact");
    h += '<label class="search compact"><span>Search</span><input type="search" data-filter="' + page + '|q" value="' + esc(f.q || "") + '" placeholder="' + esc(placeholder) + '"></label>';
    h += btn("Clear filters", "clear-filters", page, "linkish") + "</div>";
    return h;
  }

  // ---- Desk book (handover)
  function deskbook() {
    const n = now();
    const ack = D.toAcknowledge(S, me, n);
    let h = head("Desk book", "Handover tasks, notes for the next shift, and messages from clubs");
    if (ack.length)
      h += '<div class="callout warn"><div><b>' + esc(ack.length) + " item" + (ack.length > 1 ? "s" : "") + " from the previous shift.</b> Read them below, then acknowledge so the last shift knows you’ve got it.</div>" + btn("Acknowledge handover", "ack", "", "primary") + "</div>";
    const tasks = S.tasks.filter((t) => ms(t.createdAt) <= ms(n)).sort((a, b) => (a.status === b.status ? ({ high: 0, normal: 1, low: 2 })[a.priority] - ({ high: 0, normal: 1, low: 2 })[b.priority] : a.status === "pending" ? -1 : 1));
    h += '<h3 class="kittitle">Handover tasks</h3><div class="tablewrap"><table><caption class="sr">Handover tasks</caption><thead><tr><th scope="col">Task</th><th scope="col">Responsible</th><th scope="col">Priority</th><th scope="col">Due</th><th scope="col">Status</th><th scope="col">Acknowledged</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>';
    if (!tasks.length) h += '<tr><td colspan="7">' + esc("No tasks yet.") + "</td></tr>";
    for (const t of tasks)
      h +=
        "<tr" + (t.status === "done" ? ' class="muted"' : "") + "><td><b>" + esc(t.title) + "</b><small>" + esc(t.id + " · added " + dt(t.createdAt) + " by " + D.userName(S, t.createdBy)) + "</small>" + (t.doneNote ? "<small>" + esc(t.doneNote) + "</small>" : "") + "</td><td>" + esc(t.responsible) + "</td><td>" + badge(D.PRIORITIES[t.priority], t.priority === "high" ? "bad" : t.priority === "low" ? "" : "info") + "</td><td>" + esc(t.due ? dt(t.due) : "—") + "</td><td>" +
        (t.status === "done" ? badge("Done", "good") + "<small>" + esc(dt(t.doneAt) + " · " + D.userName(S, t.doneBy)) + "</small>" : t.due && ms(t.due) < ms(n) ? badge("Pending · late", "bad") : badge("Pending", "warn")) + "</td><td>" + (t.ackBy ? "<small>" + esc(D.userName(S, t.ackBy) + " · " + dt(t.ackAt)) + "</small>" : "<small>Not yet</small>") + '</td><td class="acts">' + (t.status === "pending" ? btn("Mark done", "task-done", t.id, "small") : "") + "</td></tr>";
    h += "</tbody></table></div>";
    h +=
      '<details class="addbox"><summary>Add a handover task</summary><form data-form="task" class="form">' +
      field("Task", '<input name="title" required maxlength="160" placeholder="e.g. Check projector remote">', "full") +
      field("Responsible", '<input name="responsible" required maxlength="80" list="people-list" placeholder="Name or role">') +
      field("Priority", sel("priority", Object.entries(D.PRIORITIES), "normal")) +
      field("Due (optional)", '<input type="datetime-local" name="due">') +
      '<div class="full"><button type="submit" class="primary">Add task</button></div></form>' +
      '<datalist id="people-list">' + [...S.people.map((p) => p.name), ...S.users.map((u) => u.name), "Morning staff", "Store manager"].map((x) => '<option value="' + esc(x) + '">').join("") + "</datalist></details>";
    h += '<h3 class="kittitle">Notes and messages</h3>';
    const entries = S.notes.filter((x) => ms(x.at) <= ms(n)).sort((a, b) => ms(b.at) - ms(a.at));
    for (const m of entries)
      h += '<article class="record' + (m.kind === "handover" ? " handover" : "") + '"><small>' + esc(dt(m.at)) + (m.req ? " · " + reqLink(m.req) : "") + (m.kind === "handover" ? " · " + (m.ackBy ? esc("acknowledged by " + D.userName(S, m.ackBy)) : "not yet acknowledged") : "") + "</small><h3>" + esc(m.author) + "</h3><p>" + esc(m.text) + "</p></article>";
    h += '<form data-form="note" class="form"><label class="full"><span>Note for the next shift</span><textarea name="note" rows="2" maxlength="600" required></textarea></label><div class="full"><button type="submit">Add handover note</button></div></form>';
    return h;
  }

  // ---- Inventory
  function inventory() {
    const f = F("inventory");
    const q = (f.q || "").toLowerCase().trim();
    const list = S.assets.filter((a) => {
      const v = D.assetView(S, a);
      if (f.status && v.state !== f.status) return false;
      if (f.type && a.type !== f.type) return false;
      if (f.condition && a.condition !== f.condition) return false;
      return !q || [a.id, a.type, a.model, a.bin, v.reason].join(" ").toLowerCase().includes(q);
    });
    let h = head("Inventory", "Every physical unit, where it is, and why it’s unavailable", btn("Export CSV", "export", "inventory") + btn("Print labels", "labels", list.map((a) => a.id).join(",")) + btn("Print", "print-view", "inventory"));
    h += filterBar("inventory", [
      ["status", "Status", [["", "All statuses"], ...Object.entries(D.STATUSES)], f.status || ""],
      ["type", "Category", [["", "All categories"], ...D.types(S).map((t) => [t, t])], f.type || ""],
      ["condition", "Condition", [["", "Any condition"], ["good", "Good"], ["minor", "Minor damage"], ["major", "Major damage"]], f.condition || ""],
    ], false, "ID, model, shelf, reason");
    h += '<p class="count" aria-live="polite">' + esc(list.length + " of " + S.assets.length + " units") + "</p>";
    if (!list.length) return h + empty("No units match these filters.", "inventory");
    h += '<div class="tablewrap"><table><caption class="sr">Inventory</caption><thead><tr><th scope="col">Unit</th><th scope="col">Model</th><th scope="col">Shelf</th><th scope="col">Status</th><th scope="col">Why / where</th><th scope="col">Available again</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>';
    for (const a of list) {
      const v = D.assetView(S, a);
      h +=
        "<tr><td>" + unitLink(a.id) + "<small>" + esc(a.type) + "</small></td><td>" + esc(a.model) + (a.accessories.length ? "<small>With " + esc(a.accessories.join(", ")) + "</small>" : "") + "</td><td>" + esc(a.bin) + "</td><td>" + badge(v.label, tone(v.state)) + "</td><td><small>" + esc(v.reason || "—") + "</small></td><td>" + esc(v.expected ? dt(v.expected) : v.state === "available" ? "Now" : "Unknown") + '</td><td class="acts">' +
        (can("asset.setStatus") && !v.loan ? btn("Change status", "asset-status", a.id, "small") : !v.loan && !["damaged", "missing", "retired"].includes(a.status) ? btn("Report problem", "asset-report", a.id, "small") : "") +
        "</td></tr>";
    }
    return h + "</tbody></table></div>";
  }

  // ---- Maintenance
  function maintenance() {
    const f = F("maintenance");
    const show = f.status || "active";
    const list = S.tickets.filter((t) => (show === "active" ? !["closed", "cancelled"].includes(t.status) : true)).sort((a, b) => ms(b.openedAt) - ms(a.openedAt));
    let h = head("Maintenance", "Damaged units stay off the shelf until a store manager clears them");
    h += '<div class="filters"><div class="seg" role="group" aria-label="Tickets">' + btn("Active", "filter", "maintenance|status|active", "", { "aria-pressed": String(show === "active") }) + btn("All tickets", "filter", "maintenance|status|all", "", { "aria-pressed": String(show === "all") }) + "</div></div>";
    const damaged = S.assets.filter((a) => a.status === "damaged" && !S.tickets.some((t) => t.asset === a.id && !["closed", "cancelled"].includes(t.status)));
    for (const a of damaged) h += '<div class="callout warn"><div><b>' + esc(a.id) + "</b> is marked damaged without an open ticket: " + esc(a.reason) + "</div></div>";
    if (!list.length) return h + empty("No open tickets. Everything is either on the shelf or out on loan.");
    for (const t of list) {
      const a = D.getAsset(S, t.asset);
      const done = ["closed", "cancelled"].includes(t.status);
      h +=
        '<section class="panel ticket"><div class="grouphead"><div><b class="mono">' + esc(t.id) + "</b> " + unitLink(a.id) + " " + esc(a.type + " · " + a.model) + "<small>" + esc(t.issue) + "</small></div>" + badge(D.TICKET_STATUSES[t.status], t.status === "repaired" ? "good" : t.status === "open" ? "bad" : done ? "" : "warn") + "</div>" +
        '<dl class="facts"><div><dt>Opened</dt><dd>' + esc(dt(t.openedAt) + " · " + D.userName(S, t.openedBy)) + "</dd></div><div><dt>Technician</dt><dd>" + esc(t.technician || "Not assigned") + "</dd></div><div><dt>Expected back</dt><dd>" + esc(t.eta ? dt(t.eta) : "Not set") + "</dd></div>" + (t.loan ? "<div><dt>From slip</dt><dd>L-" + esc(t.loan) + "</dd></div>" : "") + "</dl>" +
        '<details class="history"><summary>History (' + t.history.length + ")</summary><ol>" + t.history.map((x) => "<li><small>" + esc(dt(x.at) + " · " + D.userName(S, x.by)) + "</small>" + esc(x.text) + "</li>").join("") + "</ol></details>" +
        (!done && can("maintenance.update") ? '<div class="rowactions">' + btn("Update", "ticket", t.id) + btn("Clear and release", "ticket-release", t.id, "primary") + btn("Retire unit", "ticket-retire", t.id) + "</div>" : !done ? '<p class="hint">A store manager updates and clears tickets.</p>' : "") +
        "</section>";
    }
    return h;
  }

  // ---- Reports
  function reports() {
    const f = F("reports");
    const range = f.range || "term";
    const from = range === "30" ? new Date(ms(now()) - 30 * 864e5).toISOString() : range === "7" ? new Date(ms(now()) - 7 * 864e5).toISOString() : null;
    const r = D.reports(S, now(), from);
    let h = head("Reports", "From " + dateOnly(r.from) + " to " + dateOnly(r.to), btn("Loans CSV", "export", "loans-all") + btn("Inventory CSV", "export", "inventory") + btn("Transactions CSV", "export", "activity") + btn("Print report", "print-view", "reports"));
    h += '<div class="filters"><div class="seg" role="group" aria-label="Period">' + [["term", "Term so far"], ["30", "Last 30 days"], ["7", "Last 7 days"]].map(([k, t]) => btn(t, "filter", "reports|range|" + k, "", { "aria-pressed": String(range === k) })).join("") + "</div></div>";
    h += '<div class="tiles">' + [["Loans", num(r.loans)], ["Returned late or overdue", num(r.late) + " · " + pct(r.overdueRate)], ["Returned with damage", num(r.damaged)], ["Units in service", num(S.assets.filter((a) => a.status !== "retired").length)]].map(([l, v]) => '<div class="tile static"><b>' + esc(v) + "</b><span>" + esc(l) + "</span></div>").join("") + "</div>";
    const maxU = Math.max(0.0001, ...r.byType.map((x) => x.utilisation));
    h += '<section class="panel"><h3>Utilisation by category</h3><p class="hint">Share of time units in each category spent out on loan.</p><div class="tablewrap"><table><thead><tr><th scope="col">Category</th><th scope="col">Units</th><th scope="col">Loans</th><th scope="col">Hours out</th><th scope="col" class="barcol">Utilisation</th><th scope="col">Damage rate</th></tr></thead><tbody>' +
      r.byType.map((x) => "<tr><td>" + esc(x.type) + "</td><td>" + num(x.units) + "</td><td>" + num(x.loans) + "</td><td>" + num(Math.round(x.hours)) + '</td><td class="barcol"><div class="barcell"><span class="bar"><span data-w="' + (x.utilisation / maxU) + '" title="' + esc(x.type + ": " + pct(x.utilisation)) + '"></span></span><b>' + esc(pctU(x.utilisation)) + "</b></div></td><td>" + esc(pct(x.damageRate)) + "</td></tr>").join("") +
      "</tbody></table></div></section>";
    const maxN = Math.max(1, ...r.topUnits.map((x) => x.n));
    h += '<div class="cols"><section class="panel"><h3>Most borrowed units</h3><table><thead><tr><th scope="col">Unit</th><th scope="col" class="barcol">Loans</th></tr></thead><tbody>' + r.topUnits.map((x) => "<tr><td>" + unitLink(x.id) + "<small>" + esc(x.type) + '</small></td><td class="barcol"><div class="barcell"><span class="bar"><span data-w="' + x.n / maxN + '" title="' + esc(x.id + ": " + x.n) + '"></span></span><b>' + num(x.n) + "</b></div></td></tr>").join("") + "</tbody></table></section>";
    const maxM = Math.max(1, ...r.months.map((x) => x[1]));
    h += '<section class="panel"><h3>Transactions per month</h3><table><thead><tr><th scope="col">Month</th><th scope="col" class="barcol">Records</th></tr></thead><tbody>' + r.months.map(([k, n]) => "<tr><td>" + esc(new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(k + "-15"))) + '</td><td class="barcol"><div class="barcell"><span class="bar"><span data-w="' + n / maxM + '" title="' + esc(k + ": " + n) + '"></span></span><b>' + num(n) + "</b></div></td></tr>").join("") + "</tbody></table></section></div>";
    return h;
  }

  // ---- Activity log
  function activity() {
    const f = F("activity");
    const q = (f.q || "").toLowerCase().trim();
    const kinds = [...new Set(S.log.map((t) => t.kind))].sort();
    const list = S.log
      .filter((t) => ms(t.at) <= ms(now()) || t.kind === "reversal")
      .filter((t) => (!f.kind || t.kind === f.kind) && (!q || [t.id, t.summary, D.userName(S, t.by), t.reason || ""].join(" ").toLowerCase().includes(q)))
      .filter((t) => (!f.from || ms(t.at) >= ms(fromInput(f.from + "T00:00"))) && (!f.to || ms(t.at) <= ms(fromInput(f.to + "T23:59"))))
      .slice()
      .reverse();
    let h = head("Activity log", "Every change, who made it and when. Corrections are new records, never edits.", btn("Export CSV", "export", "activity"));
    h += filterBar("activity", [["kind", "Type", [["", "All types"], ...kinds.map((k) => [k, cap(k)])], f.kind || ""]], true, "Transaction, person, text");
    if (!list.length) return h + empty("No records match.", "activity");
    h += '<div class="tablewrap"><table><caption class="sr">Activity log</caption><thead><tr><th scope="col">ID</th><th scope="col">When</th><th scope="col">By</th><th scope="col">Type</th><th scope="col">What happened</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>';
    for (const t of list.slice(0, 200)) {
      const blocker = D.reverseBlocker(S, t, me);
      h +=
        "<tr" + (t.reversedBy ? ' class="muted"' : "") + "><td class=mono>" + esc(t.id) + "</td><td>" + esc(dt(t.at)) + "</td><td>" + esc(D.userName(S, t.by)) + "</td><td>" + badge(cap(t.kind), t.kind === "reversal" ? "warn" : "") + "</td><td>" + esc(t.summary) + (t.reversedBy ? "<small>Reversed by " + esc(t.reversedBy) + "</small>" : "") + '</td><td class="acts">' +
        (t.kind === "issue" || t.kind === "return" ? btn("Receipt", "print-receipt", t.id, "small") : "") +
        (!blocker ? btn("Reverse", "reverse", t.id, "small") : "") +
        "</td></tr>";
    }
    return h + "</tbody></table></div>" + (list.length > 200 ? '<p class="hint">Showing the latest 200. Export CSV for the full log.</p>' : "");
  }

  // ---- Settings
  function settings() {
    const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [S.settings.tz, "UTC"];
    let h = head("Settings", "Applies to everyone using this desk");
    h +=
      '<form data-form="settings" class="form panel"><h3 class="full">Region and time</h3>' +
      field("Desk time zone", sel("tz", zones.map((z) => [z, z.replace(/_/g, " ")]), S.settings.tz)) +
      field("Language and region for dates and numbers", "<input" + attr({ name: "locale", value: S.settings.locale, placeholder: "Browser default (" + navigator.language + ")", list: "locales" }) + ">" + '<datalist id="locales">' + ["en-IN", "en-GB", "en-US", "hi-IN", "ta-IN", "de-DE", "fr-FR", "es-ES", "ja-JP", "ar-EG", "pt-BR", "zh-CN"].map((x) => '<option value="' + x + '">').join("") + "</datalist>") +
      field("Clock", sel("clock", [["story", "Sample shift (story time)"], ["live", "Live clock (real time)"]], S.settings.clock)) +
      '<p class="hint full">Example: ' + esc(new Intl.DateTimeFormat(S.settings.locale || navigator.language, { timeZone: S.settings.tz, dateStyle: "full", timeStyle: "short" }).format(new Date(now()))) + "</p>" +
      '<div class="full"><button type="submit" class="primary">Save settings</button></div></form>';
    h += '<section class="panel"><h3>Staff and roles</h3><p class="hint">Desk operators issue and return equipment. Store managers also approve requests, clear repairs, change unit status and reverse any record. Admins also manage settings and roles.</p><div class="tablewrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Role</th></tr></thead><tbody>' +
      S.users.map((u) => "<tr><td>" + esc(u.name) + "</td><td>" + sel("", Object.entries(D.ROLES), u.role, { "data-role-for": u.id, "aria-label": "Role for " + u.name }) + "</td></tr>").join("") +
      "</tbody></table></div></section>";
    if (mode === "local")
      h += '<section class="panel"><h3>Backup</h3><p class="hint">Download every record as a file, or restore one. Restoring replaces this browser’s data.</p><div class="rowactions">' + btn("Download backup", "backup") + '<label class="filebtn">Restore from file<input type="file" accept="application/json" data-restore></label></div></section>';
    return h;
  }

  const VIEWS = { dashboard, requests, returns, loans, deskbook, inventory, maintenance, reports, activity, settings };

  // --------------------------------------------------------------- paint
  function paint() {
    if (!S || !me) return;
    const page = PAGES.find((p) => p.key === ui.page && canSee(p)) ? ui.page : "dashboard";
    ui.page = page;
    const focus = rememberFocus();
    const n = now();
    $("[data-clock]").textContent = clockText(n);
    const story = S.settings.clock === "story";
    $("[data-shiftbar]").hidden = !story;
    if (story) {
      const ph = SHIFTS[S.story.phase];
      $("[data-shift-title]").textContent = ph.title;
      $("[data-shift]").textContent = ph.text;
      const adv = $('[data-action="advance"]');
      adv.hidden = !ph.next;
      adv.textContent = ph.next || "";
    }
    $('[data-action="restart"]').hidden = mode === "remote" && me.role !== "admin";
    // who
    $("[data-who]").innerHTML =
      mode === "local"
        ? '<label><span class="sr">Acting as</span>' + sel("", S.users.map((u) => [u.id, u.name + " · " + D.ROLES[u.role]]), me.id, { "data-switch-user": "" }) + "</label>"
        : "<span><b>" + esc(me.name) + "</b><small>" + esc(D.ROLES[me.role]) + "</small></span>" + btn("Sign out", "logout", "", "small");
    // bell
    const notes = D.notifications(S, me, n).filter((x) => !dismissed(x.id));
    const bell = $("[data-bell]");
    bell.innerHTML = icon("bell") + (notes.length ? '<span class="count' + (notes.some((x) => x.level === "danger") ? " late" : "") + '">' + notes.length + "</span>" : "");
    bell.setAttribute("aria-label", "Notifications" + (notes.length ? ", " + notes.length + " new" : ""));
    if (!$("#notifs").hidden) renderNotifs();
    // nav
    let lastGroup = "";
    const open = S.loans.filter((l) => l.status === "open").length;
    const late = S.loans.filter((l) => D.isOverdue(l, n)).length;
    const pend = S.requests.filter((r) => r.status === "pending").length;
    const ack = D.toAcknowledge(S, me, n).length;
    const counts = { loans: [open, late], requests: [pend, 0], deskbook: [ack, ack], maintenance: [S.tickets.filter((t) => !["closed", "cancelled"].includes(t.status)).length, 0] };
    $("[data-nav]").innerHTML = PAGES.filter(canSee)
      .map((p) => {
        let g = "";
        if (p.group !== lastGroup) {
          g = '<span class="navgroup">' + esc(p.group) + "</span>";
          lastGroup = p.group;
        }
        const c = counts[p.key];
        return g + "<button" + attr({ type: "button", "data-action": "go", "data-val": p.key, "aria-current": page === p.key ? "page" : false }) + ">" + icon(p.icon) + '<span class="navlabel">' + esc(p.label) + "</span>" + (c && c[0] ? '<span class="count' + (c[1] ? " late" : "") + '">' + c[0] + "</span>" : "") + "</button>";
      })
      .join("");
    $("[data-view]").innerHTML = VIEWS[page]();
    for (const b of $$("[data-w]")) b.style.width = Math.max(2, Number(b.dataset.w) * 100) + "%";
    const fl = $("[data-flash]");
    fl.hidden = !flashMsg;
    fl.className = "flash" + (flashMsg ? " " + flashMsg.kind : "");
    fl.innerHTML = flashMsg ? "<span>" + esc(flashMsg.text) + "</span>" + (flashMsg.actions || []).map(([l, a, v]) => btn(l, a, v, "small")).join("") + btn("Dismiss", "dismiss-flash", "", "small ghost", { "aria-label": "Dismiss message" }) : "";
    setMode();
    restoreFocus(focus);
    saveUi();
  }
  function rememberFocus() {
    const el = document.activeElement;
    if (!el || !root.contains(el) || dialog.contains(el)) return null;
    const keys = ["data-filter", "data-action", "name", "id", "data-switch-user", "data-role-for"];
    for (const k of keys)
      if (el.hasAttribute(k)) {
        const v = el.getAttribute(k);
        const val = el.getAttribute("data-val");
        return { sel: "[" + k + '="' + CSS.escape(v) + '"]' + (val !== null && k === "data-action" ? '[data-val="' + CSS.escape(val) + '"]' : ""), caret: el.selectionStart };
      }
    return null;
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = $(f.sel);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof f.caret === "number" && el.setSelectionRange) try { el.setSelectionRange(f.caret, f.caret); } catch { /* not a text input */ }
  }
  function go(page, opts = {}) {
    ui.page = page;
    if (page !== "requests") ui.request = null;
    if (opts.request !== undefined) ui.request = opts.request;
    flashMsg = opts.keepFlash ? flashMsg : null;
    closePopovers();
    paint();
    const h = $("[data-pagehead]");
    if (h) h.focus();
    const af = $("[data-autofocus]");
    if (af) af.focus();
  }

  const SHIFTS = [
    { title: "Pickup at the counter", text: "Kabir is here for the Film Society screening. The film starts at four. Can he leave with everything he needs?", next: "Move to return time" },
    { title: "The kit comes back in pieces", text: "Kabir has brought back the projector and speaker. “Leela still has the adapter. She’ll drop it off tomorrow at nine.” Take the return and hand over to the morning shift.", next: "Move to next morning" },
    { title: "Morning shift", text: "You’ve just taken over. Leela walks in with an adapter. Work out what was outstanding from the screening and close the loan for the right item." },
  ];

  // ------------------------------------------------------- popovers
  function renderNotifs() {
    const list = D.notifications(S, me, now()).filter((x) => !dismissed(x.id));
    $("#notifs").innerHTML =
      '<div class="pophead"><b>Notifications</b>' + (list.length ? btn("Dismiss all", "dismiss-all", "", "linkish") : "") + "</div>" +
      (list.length ? '<ul class="plain">' + list.map((n) => '<li class="note ' + n.level + '"><span class="dot" aria-hidden="true"></span>' + btn(n.text, "notif", n.page + "|" + n.ref, "linkish") + btn("×", "dismiss", n.id, "ghost small", { "aria-label": "Dismiss: " + n.text }) + "</li>").join("") + "</ul>" : '<p class="empty">You’re all caught up.</p>');
  }
  function closePopovers() {
    $("#notifs").hidden = true;
    $("[data-bell]").setAttribute("aria-expanded", "false");
    $("#gresults").hidden = true;
    $("#gsearch").setAttribute("aria-expanded", "false");
  }
  function globalSearch(q) {
    q = q.trim().toLowerCase();
    const box = $("#gresults");
    if (!q) {
      box.hidden = true;
      $("#gsearch").setAttribute("aria-expanded", "false");
      return;
    }
    const res = [];
    for (const a of S.assets)
      if ([a.id, a.type, a.model].join(" ").toLowerCase().includes(q)) res.push(["Unit", a.id + " · " + a.type, D.assetView(S, a).label, "asset", a.id]);
    for (const r of S.requests)
      if ([r.id, r.club, r.event, r.owner].join(" ").toLowerCase().includes(q)) res.push(["Request", r.id + " · " + r.club + " · " + r.event, D.requestStage(S, r).label, "open-request", r.id]);
    for (const l of S.loans.filter((l) => l.status === "open"))
      if (searchLoan(l).includes(q)) res.push(["Open slip", "L-" + l.num + " · " + l.asset + " · " + l.borrower, "Due " + dt(l.due), "return", String(l.num)]);
    for (const p of S.people)
      if (p.name.toLowerCase().includes(q)) res.push(["Person", p.name + " · " + p.club, "Show their slips", "person", p.name]);
    box.innerHTML = res.length
      ? res.slice(0, 12).map(([k, t, s, act, val], i) => "<button" + attr({ type: "button", role: "option", id: "gr-" + i, "data-action": act, "data-val": val, class: "result" }) + "><small>" + esc(k) + "</small><b>" + esc(t) + "</b><small>" + esc(s) + "</small></button>").join("")
      : '<p class="empty">No matches for “' + esc(q) + "”.</p>";
    box.hidden = false;
    $("#gsearch").setAttribute("aria-expanded", "true");
  }

  // --------------------------------------------------------- dialogs
  function openDialog(title, body, opts = {}) {
    dialog.className = opts.wide ? "wide" : "";
    dialog.innerHTML =
      '<div class="dlghead"><h2 id="dlg-title">' + esc(title) + "</h2>" + btn("×", "close-dialog", "", "ghost", { "aria-label": "Close" }) + "</div>" +
      '<p class="dlgerror" data-dlg-error role="alert" tabindex="-1" hidden></p>' + body;
    if (!dialog.open) dialog.showModal();
    const first = $("[data-autofocus]", dialog) || $("input:not([type=hidden]), select, textarea, button.primary", dialog);
    if (first) first.focus();
  }
  function closeDialog() {
    stopScanner();
    if (dialog.open) dialog.close();
    dialog.innerHTML = "";
  }
  dialog.addEventListener("close", () => {
    stopScanner();
  });

  function confirmIssue(form) {
    const r = D.getReq(S, form.dataset.req);
    const data = new FormData(form);
    const units = data.getAll("unit").filter(Boolean);
    const who = data.get("who");
    const due = fromInput(data.get("due"));
    if (!units.length) return flashNow("Pick at least one unit to issue.", "error");
    if (!who) return flashNow("Choose who is collecting before issuing.", "error");
    if (!due) return flashNow("Enter a return time.", "error");
    const assets = units.map((id) => D.getAsset(S, id));
    const missingTypes = D.kitLines(S, r).filter((x) => !x.loan && !assets.some((a) => a.type === x.type)).map((x) => x.type);
    openDialog(
      "Confirm pickup",
      '<form data-form="issue-confirm" data-op="' + uid() + '" data-req="' + esc(r.id) + '" data-who="' + esc(who) + '" data-due="' + esc(due) + '" data-units="' + esc(units.join(",")) + '">' +
        '<dl class="facts"><div><dt>Request</dt><dd>' + esc(r.id + " · " + r.event + " · " + r.club) + "</dd></div><div><dt>Borrower</dt><dd>" + esc(who) + "</dd></div><div><dt>Return by</dt><dd>" + esc(dt(due)) + "</dd></div><div><dt>Items</dt><dd>" + esc(units.length + " of " + r.items.length + " approved") + "</dd></div></dl>" +
        '<table class="tight"><thead><tr><th scope="col">Approved item</th><th scope="col">Unit leaving the desk</th><th scope="col">Hand over with</th></tr></thead><tbody>' +
        assets.map((a) => "<tr><td>" + esc(a.type) + "</td><td><b class=mono>" + esc(a.id) + "</b> " + esc(a.model) + "<small>Shelf " + esc(a.bin) + "</small></td><td>" + esc(a.accessories.join(", ") || "—") + "</td></tr>").join("") +
        missingTypes.map((t) => "<tr><td>" + esc(t) + '</td><td colspan="2"><span class="badtext">Not issuing now — the request stays partly fulfilled</span></td></tr>').join("") +
        "</tbody></table>" +
        '<label class="check"><input type="checkbox" name="ok" required> I have verified the equipment and borrower details.</label>' +
        '<div class="dlgactions">' + btn("Back", "close-dialog") + '<button type="submit" class="primary">Issue ' + units.length + " item" + (units.length > 1 ? "s" : "") + "</button></div></form>",
      { wide: true },
    );
  }

  function returnDialog(nums) {
    const loans = nums.map((n) => D.getLoan(S, n)).filter((l) => l && l.status === "open");
    if (!loans.length) return flashNow("That slip is already closed.", "warn");
    const first = loans[0];
    const who = first.expect ? first.expect.who : first.borrower;
    let body =
      '<form data-form="return" data-op="' + uid() + '" data-loans="' + loans.map((l) => l.num).join(",") + '">' +
      '<div class="form">' + field("Returned by (who is at the counter)", sel("returnedBy", [["", "Select…"], ...S.people.map((p) => [p.name, p.name + " · " + p.club])], who, { required: true })) +
      '<p class="hint">Recorded at ' + esc(dt(now())) + " by " + esc(me.name) + ".</p></div>";
    for (const l of loans) {
      const a = D.getAsset(S, l.asset);
      body +=
        '<fieldset class="retunit" data-loan="' + l.num + '"><legend>' + esc(a.type + " · slip L-" + l.num) + "</legend>" +
        (loans.length > 1 ? '<label class="check"><input type="checkbox" name="include-' + l.num + '" checked> Returning this now</label>' : "") +
        '<p class="hint">Slip is for <b class="mono">' + esc(a.id) + "</b> " + esc(a.model) + " · issued to " + esc(l.borrower) + " · due " + esc(dt(l.due)) + (D.isOverdue(l, now()) ? ' · <span class="badtext">overdue</span>' : "") + "</p>" +
        '<div class="verify">' + field("Unit ID on the label", "<input" + attr({ name: "verify-" + l.num, required: true, autocomplete: "off", autocapitalize: "characters", placeholder: "Scan or type", "data-autofocus": l === first ? "" : false }) + ">") + "<button" + attr({ type: "button", "data-action": "scan-into", "data-val": "verify-" + l.num }) + ">" + icon("scan") + " Scan</button></div>" +
        '<div class="radios" role="radiogroup" aria-label="Condition of ' + esc(a.id) + '">' + Object.entries(D.CONDITIONS).filter(([k]) => k !== "accessories" || a.accessories.length).map(([k, t]) => '<label class="radio"><input type="radio" name="cond-' + l.num + '" value="' + k + '"' + (k === "good" ? " checked" : "") + "> " + esc(t) + "</label>").join("") + "</div>" +
        (a.accessories.length ? '<div class="accs"><span>Accessories back (untick anything missing)</span>' + a.accessories.map((x) => '<label class="check"><input type="checkbox" name="acc-' + l.num + '" value="' + esc(x) + '" checked> ' + esc(x) + "</label>").join("") + "</div>" : "") +
        field("Damage or remarks", '<textarea name="remarks-' + l.num + '" rows="2" maxlength="400" placeholder="Required for damage"></textarea>') +
        "</fieldset>";
    }
    body +=
      '<p class="hint">Anything returned damaged or incomplete is held off the shelf and a maintenance ticket opens automatically.</p>' +
      '<label class="check"><input type="checkbox" name="ok" required> I have checked the unit IDs and condition.</label>' +
      '<div class="dlgactions">' + btn("Cancel", "close-dialog") + '<button type="submit" class="primary">Confirm return</button></div></form>';
    openDialog(loans.length > 1 ? "Record returns" : "Record return · " + first.asset, body, { wide: true });
  }

  function reverseDialog(txId) {
    const t = S.log.find((x) => x.id === txId);
    const why = D.reverseBlocker(S, t, me);
    if (why) return flashNow(why, "error");
    openDialog(
      "Reverse " + t.id,
      '<form data-form="reverse" data-op="' + uid() + '" data-tx="' + esc(t.id) + '"><p>' + esc(t.summary) + "</p><p class=hint>" + esc(dt(t.at) + " · " + D.userName(S, t.by)) + "</p>" +
        '<p class="hint">The original stays in the log. A new reversal record is added with your name and reason.</p>' +
        field("Reason", '<textarea name="reason" rows="2" required minlength="3" maxlength="400" data-autofocus></textarea>') +
        '<div class="dlgactions">' + btn("Cancel", "close-dialog") + '<button type="submit" class="primary">Reverse</button></div></form>',
    );
  }

  function requestForm(r) {
    const items = r ? r.items : [];
    const typesList = D.types(S);
    const qty = (t) => items.filter((x) => x === t).length;
    openDialog(
      r ? "Modify " + r.id : "New request",
      '<form data-form="request" data-op="' + uid() + '"' + (r ? ' data-id="' + esc(r.id) + '"' : "") + ' class="form">' +
        (r ? "" : field("Club", '<input name="club" required maxlength="80" list="clubs">') + '<datalist id="clubs">' + [...new Set(S.people.map((p) => p.club))].map((c) => '<option value="' + esc(c) + '">').join("") + "</datalist>" + field("Event", '<input name="event" required maxlength="120">') + field("Filed by", sel("owner", [["", "Select…"], ...S.people.map((p) => [p.name, p.name + " · " + p.club])], "", { required: true }))) +
        field("Pickup", "<input" + attr({ type: "datetime-local", name: "pickup", required: true, value: r ? toInput(r.pickup) : "" }) + ">") +
        field("Return by", "<input" + attr({ type: "datetime-local", name: "due", required: true, value: r ? toInput(r.due) : "" }) + ">") +
        '<fieldset class="full qty"><legend>Equipment</legend>' + typesList.map((t) => field(t, "<input" + attr({ type: "number", min: 0, max: 5, name: "qty", "data-type": t, value: qty(t) }) + ">", "compact")).join("") + "</fieldset>" +
        field("Note", '<textarea name="note" rows="2" maxlength="400">' + esc(r ? r.note : "") + "</textarea>", "full") +
        '<div class="dlgactions full">' + btn("Cancel", "close-dialog") + '<button type="submit" class="primary">' + (r ? "Save changes" : "Create request") + "</button></div></form>",
      { wide: true },
    );
  }

  function reasonDialog(title, form, id, label, cta) {
    openDialog(title, '<form data-form="' + form + '" data-op="' + uid() + '" data-id="' + esc(id) + '">' + field(label, '<textarea name="reason" rows="2" required maxlength="400" data-autofocus></textarea>') + '<div class="dlgactions">' + btn("Back", "close-dialog") + '<button type="submit" class="primary">' + esc(cta) + "</button></div></form>");
  }

  function assetDialog(id) {
    const a = D.getAsset(S, id);
    if (!a) return;
    const v = D.assetView(S, a);
    const hist = S.loans.filter((l) => l.asset === id && l.status !== "void").sort((x, y) => ms(y.issuedAt) - ms(x.issuedAt));
    const tickets = S.tickets.filter((t) => t.asset === id);
    openDialog(
      a.id + " · " + a.type,
      '<dl class="facts"><div><dt>Model</dt><dd>' + esc(a.model) + "</dd></div><div><dt>Shelf</dt><dd>" + esc(a.bin) + "</dd></div><div><dt>Status</dt><dd>" + badge(v.label, tone(v.state)) + "</dd></div><div><dt>Available again</dt><dd>" + esc(v.expected ? dt(v.expected) : v.state === "available" ? "Now" : "Unknown") + "</dd></div></dl>" +
        (v.reason ? '<p class="hint">' + esc(v.reason) + "</p>" : "") +
        "<p><b>Accessories:</b> " + esc(a.accessories.join(", ") || "none") + "</p>" +
        '<div class="label-preview">' + barcodeSvg(a.id) + "</div>" +
        '<h3 class="kittitle">Loan history</h3>' + (hist.length ? '<table class="tight"><tbody>' + hist.map((l) => "<tr><td class=mono>L-" + l.num + "</td><td>" + esc(l.borrower) + "<small>" + esc(l.req) + "</small></td><td>" + esc(dt(l.issuedAt)) + "</td><td>" + loanStatus(l) + "</td></tr>").join("") + "</tbody></table>" : '<p class="empty">Never borrowed.</p>') +
        (tickets.length ? '<h3 class="kittitle">Maintenance</h3><ul>' + tickets.map((t) => "<li>" + esc(t.id + " · " + D.TICKET_STATUSES[t.status] + " · " + t.issue) + "</li>").join("") + "</ul>" : "") +
        '<div class="dlgactions">' + btn("Print label", "labels", a.id) + (v.loan && v.loan.status === "open" ? btn("Record return", "return", String(v.loan.num), "primary") : "") + btn("Close", "close-dialog") + "</div>",
      { wide: true },
    );
  }

  function statusDialog(id, report) {
    const a = D.getAsset(S, id);
    const choices = report ? [["damaged", "Damaged"], ["missing", "Missing"]] : Object.entries(D.STATUSES).filter(([k]) => k !== "on-loan");
    const reqs = S.requests.filter((r) => r.status === "approved" && r.items.includes(a.type) && ms(r.due) > ms(now()));
    openDialog(
      (report ? "Report a problem · " : "Change status · ") + a.id,
      '<form data-form="' + (report ? "asset-report" : "asset-status") + '" data-op="' + uid() + '" data-id="' + esc(a.id) + '" class="form">' +
        field("Status", sel("status", choices, report ? "damaged" : a.status)) +
        (report ? "" : field("Reserve for (if reserved)", sel("reservedFor", [["", "—"], ...reqs.map((r) => [r.id, r.id + " · " + r.club])], a.reservedFor || "")) + field("Expected availability (optional)", "<input" + attr({ type: "datetime-local", name: "expected", value: toInput(a.expected) }) + ">")) +
        field("Reason", '<textarea name="reason" rows="2" maxlength="400" data-autofocus>' + esc(report ? "" : a.reason) + "</textarea>", "full") +
        (report ? '<p class="hint full">Damaged units open a maintenance ticket. A store manager clears them.</p>' : "") +
        '<div class="dlgactions full">' + btn("Cancel", "close-dialog") + '<button type="submit" class="primary">Save</button></div></form>',
    );
  }

  function ticketDialog(id) {
    const t = S.tickets.find((x) => x.id === id);
    openDialog(
      "Update " + t.id + " · " + t.asset,
      '<form data-form="ticket" data-op="' + uid() + '" data-id="' + esc(t.id) + '" class="form">' +
        field("Status", sel("status", [["open", D.TICKET_STATUSES.open], ["in_progress", D.TICKET_STATUSES.in_progress], ["repaired", D.TICKET_STATUSES.repaired]], t.status)) +
        field("Technician", "<input" + attr({ name: "technician", value: t.technician, maxlength: 80 }) + ">") +
        field("Expected back on the shelf", "<input" + attr({ type: "datetime-local", name: "eta", value: toInput(t.eta) }) + ">") +
        field("Note", '<textarea name="note" rows="2" maxlength="400"></textarea>', "full") +
        '<div class="dlgactions full">' + btn("Cancel", "close-dialog") + '<button type="submit" class="primary">Save</button></div></form>',
    );
  }

  function flashNow(text, kind) {
    flash(text, kind);
    paint();
    $("[data-flash]").focus();
  }

  // ---------------------------------------------------------- scanning
  let scanStream = null;
  let scanTimer = null;
  function stopScanner() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
    const v = $("[data-scan-video]");
    if (v) v.remove();
  }
  /** Scan a label with the camera; falls back to typing (USB scanners type too). */
  async function scan(onCode, host) {
    const target = host || dialog;
    const ok = "BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    const box = document.createElement("div");
    box.className = "scanner";
    box.setAttribute("data-scan-video", "");
    box.innerHTML = ok ? '<video playsinline muted aria-label="Camera view"></video><p class="hint" role="status">Point the camera at the label…</p>' + btn("Stop scanning", "stop-scan", "", "small") : '<p class="hint" role="status">Camera scanning isn’t available in this browser. Type the ID, or use a USB barcode scanner — it types into the field for you.</p>';
    stopScanner();
    if (!target.open && target === dialog) openDialog("Scan a label", "");
    target.appendChild(box);
    if (!ok) return;
    try {
      const detector = new window.BarcodeDetector({ formats: ["code_128", "qr_code", "code_39", "ean_13"] });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = $("video", box);
      video.srcObject = scanStream;
      await video.play();
      scanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            const value = codes[0].rawValue.trim().toUpperCase();
            stopScanner();
            onCode(value);
          }
        } catch {
          /* keep trying */
        }
      }, 300);
    } catch {
      $("p", box).textContent = "Couldn’t open the camera (permission denied or no camera). Type the ID instead.";
    }
  }
  function lookupUnit(id) {
    id = String(id || "").trim().toUpperCase().replace(/\s+/g, "");
    const a = D.getAsset(S, id);
    if (!a) return flashNow("No unit with ID “" + id + "”. Check the label.", "error");
    const l = D.openLoan(S, id);
    if (l) returnDialog([l.num]);
    else assetDialog(id);
  }

  // ---------------------------------------------------- Code 128 labels
  const C128 = "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112".split(" ");
  function barcodeSvg(value) {
    const codes = [104];
    for (const ch of value) codes.push(ch.charCodeAt(0) - 32);
    let sum = 104;
    for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
    codes.push(sum % 103, 106);
    let x = 10;
    let bars = "";
    for (const c of codes) {
      const p = C128[c];
      for (let i = 0; i < p.length; i++) {
        const w = Number(p[i]);
        if (i % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="40"/>';
        x += w;
      }
    }
    x += 10;
    return '<svg class="barcode" viewBox="0 0 ' + x + ' 52" role="img" aria-label="Barcode for ' + esc(value) + '" xmlns="http://www.w3.org/2000/svg"><rect width="' + x + '" height="52" fill="#fff"/><g fill="#000">' + bars + '</g><text x="' + x / 2 + '" y="50" text-anchor="middle" font-size="9" font-family="monospace" fill="#000">' + esc(value) + "</text></svg>";
  }

  // ---------------------------------------------------- export & print
  function csv(rows) {
    const cell = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  }
  function download(name, content, type = "text/csv;charset=utf-8") {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCsv(kind) {
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === "inventory")
      return download("campus-stores-inventory-" + stamp + ".csv", csv([["Unit", "Category", "Model", "Shelf", "Status", "Reason", "Available again", "Condition", "Accessories"], ...S.assets.map((a) => { const v = D.assetView(S, a); return [a.id, a.type, a.model, a.bin, v.label, v.reason, v.expected || "", a.condition, a.accessories.join("; ")]; })]));
    if (kind === "activity")
      return download("campus-stores-transactions-" + stamp + ".csv", csv([["ID", "When (UTC)", "By", "Type", "Summary", "Reversed by", "Reverses", "Reason"], ...S.log.map((t) => [t.id, t.at, D.userName(S, t.by), t.kind, t.summary, t.reversedBy || "", t.reverses || "", t.reason || ""])]));
    const list = kind === "loans-all" ? S.loans : currentLoans();
    return download("campus-stores-loans-" + stamp + ".csv", csv([["Slip", "Unit", "Category", "Request", "Club", "Borrower", "Issued (UTC)", "Issued by", "Due (UTC)", "Status", "Returned (UTC)", "Returned by", "Condition", "Missing", "Remarks"], ...list.map((l) => { const a = D.getAsset(S, l.asset); const r = D.getReq(S, l.req); return ["L-" + l.num, a.id, a.type, r.id, r.club, l.borrower, l.issuedAt, D.userName(S, l.issuedBy), l.due, l.status, l.returnedAt || "", l.returnedBy || "", l.condition || "", (l.missing || []).join("; "), l.remarks || ""]; })]));
  }
  function currentLoans() {
    return $$("[data-view] tbody tr td.mono").map((td) => D.getLoan(S, td.textContent.replace("L-", ""))).filter(Boolean);
  }
  function printHTML(title, html) {
    const pr = document.getElementById("print-root");
    pr.innerHTML = '<div class="printdoc"><header><b>Campus Stores · Media equipment desk</b><span>' + esc(title) + "</span><small>Printed " + esc(dt(now())) + " · " + esc(me.name) + "</small></header>" + html + "</div>";
    document.body.classList.add("printing");
    const done = () => {
      document.body.classList.remove("printing");
      pr.innerHTML = "";
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1500);
  }
  function printReceipt(txId) {
    const t = S.log.find((x) => x.id === txId);
    if (!t) return flashNow("No receipt for that record.", "warn");
    const loans = t.refs.loans.map((n) => D.getLoan(S, n));
    const r = D.getReq(S, t.refs.req);
    const isReturn = t.kind === "return";
    const rows = loans.map((l) => {
      const a = D.getAsset(S, l.asset);
      return "<tr><td>L-" + l.num + "</td><td><b>" + esc(a.id) + "</b> " + esc(a.type + " · " + a.model) + "</td><td>" + esc(a.accessories.join(", ") || "—") + "</td><td>" + esc(isReturn ? (D.CONDITIONS[l.condition] || "") + ((l.missing || []).length ? " · missing " + l.missing.join(", ") : "") : dt(l.due)) + (isReturn && l.remarks ? "<br><small>" + esc(l.remarks) + "</small>" : "") + "</td></tr>";
    }).join("");
    printHTML(
      (isReturn ? "Return receipt " : "Pickup receipt ") + t.id,
      "<dl><dt>Request</dt><dd>" + esc(r.id + " · " + r.club + " · " + r.event) + "</dd><dt>" + (isReturn ? "Returned by" : "Borrower") + "</dt><dd>" + esc(isReturn ? loans[0].returnedBy : loans[0].borrower) + "</dd><dt>Time</dt><dd>" + esc(dt(t.at)) + "</dd><dt>Desk staff</dt><dd>" + esc(D.userName(S, t.by)) + "</dd>" + (t.reversedBy ? "<dt>Note</dt><dd>Reversed by " + esc(t.reversedBy) + "</dd>" : "") + "</dl>" +
        "<table><thead><tr><th>Slip</th><th>Unit</th><th>Accessories</th><th>" + (isReturn ? "Condition" : "Return by") + "</th></tr></thead><tbody>" + rows + "</tbody></table>" +
        '<div class="sign"><span>Borrower signature</span><span>Desk signature</span></div>',
    );
  }
  function printView() {
    const v = $("[data-view]").cloneNode(true);
    $$(".linkish", v).forEach((el) => el.replaceWith(document.createTextNode(el.textContent)));
    $$("button, input, select, details, .filters, .acts, .seg", v).forEach((el) => el.remove());
    printHTML($("[data-pagehead]") ? $("[data-pagehead]").textContent : "", v.innerHTML);
  }
  function printLabels(ids) {
    printHTML("Unit labels", '<div class="labels">' + ids.map((id) => { const a = D.getAsset(S, id); return '<div class="label">' + barcodeSvg(a.id) + "<small>" + esc(a.type + " · " + a.model) + "<br>Campus Stores · shelf " + a.bin + "</small></div>"; }).join("") + "</div>");
  }

  // ------------------------------------------------------------ events
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) {
      if (!e.target.closest(".popover, [data-gsearch]")) closePopovers();
      return;
    }
    if (b.getAttribute("aria-disabled") === "true") return e.preventDefault();
    const v = b.dataset.val || "";
    switch (b.dataset.action) {
      case "go":
        return go(v);
      case "tile":
      case "notif": {
        const [page, ref] = v.split("|");
        if (b.dataset.action === "notif") {
          if (page === "request") return go("requests", { request: ref });
          if (page === "loans" && ref) return go("returns");
          return go(page);
        }
        if (page === "requests") ui.f.requests = { status: ref || "open" };
        if (page === "loans") ui.f.loans = { status: ref || "open" };
        if (page === "inventory") ui.f.inventory = ref ? { status: ref } : {};
        if (page === "maintenance") ui.f.maintenance = {};
        return go(page);
      }
      case "open-request":
        closeDialog();
        return go("requests", { request: v });
      case "close-request":
        return go("requests", { request: null });
      case "person":
        ui.f.loans = { status: "all", q: v };
        return go("loans");
      case "filter": {
        const [page, k, val] = v.split("|");
        F(page)[k] = val;
        return paint();
      }
      case "clear-filters":
        ui.f[v] = {};
        paint();
        return;
      case "advance": {
        const res = await dispatch("story.advance", {});
        if (res && mode === "local") {
          const staff = D.getUser(S, D.PHASES[S.story.phase].staff);
          if (staff && staff.id !== me.id) {
            Local.setUser(staff.id);
            flash("Desk time is now " + clockText(now()) + ". " + staff.name + " has taken over the desk.");
            paint();
          } else {
            flash("Desk time is now " + clockText(now()) + ".");
            paint();
          }
        }
        return;
      }
      case "restart":
        if (!confirm("Restart the sample shift? Every change in this browser will be lost.")) return;
        return restartShift();
      case "return":
        return returnDialog(v.split(",").map(Number));
      case "reverse":
        return reverseDialog(v);
      case "print-receipt":
        return printReceipt(v);
      case "print-view":
        return printView();
      case "labels":
        return printLabels(v.split(",").filter(Boolean));
      case "export":
        return exportCsv(v);
      case "asset":
        closePopovers();
        return assetDialog(v);
      case "asset-status":
        return statusDialog(v, false);
      case "asset-report":
        return statusDialog(v, true);
      case "ticket":
        return ticketDialog(v);
      case "ticket-release":
        if (!confirm("Clear " + v + " and put the unit back on the shelf?")) return;
        return dispatch("maintenance.release", { id: v });
      case "ticket-retire":
        return reasonDialog("Retire unit · " + v, "retire", v, "Why is it being retired?", "Retire unit");
      case "approve":
        return dispatch("request.approve", { id: v });
      case "reject":
        return reasonDialog("Reject " + v, "reject", v, "Reason (sent to the club)", "Reject request");
      case "cancel-request":
        return reasonDialog("Cancel " + v, "cancel", v, "Reason", "Cancel request");
      case "modify-request":
        return requestForm(D.getReq(S, v));
      case "new-request":
        return requestForm(null);
      case "task-done":
        return dispatch("task.done", { id: v });
      case "ack":
        return dispatch("handover.ack", {});
      case "close-dialog":
        return closeDialog();
      case "dismiss-flash":
        flashMsg = null;
        return paint();
      case "bell": {
        const box = $("#notifs");
        const open = box.hidden;
        closePopovers();
        box.hidden = !open;
        b.setAttribute("aria-expanded", String(open));
        if (open) {
          renderNotifs();
          const first = $("button", box);
          if (first) first.focus();
        }
        return;
      }
      case "dismiss":
      case "dismiss-all": {
        const ids = b.dataset.action === "dismiss" ? [v] : D.notifications(S, me, now()).map((n) => n.id);
        ui.dismissed[me.id] = [...new Set([...(ui.dismissed[me.id] || []), ...ids])].slice(-200);
        paint();
        renderNotifs();
        const next = $("#notifs button");
        if (next) next.focus();
        else $("[data-bell]").focus();
        return;
      }
      case "scan-lookup":
        return scan((code) => {
          closeDialog();
          lookupUnit(code);
        });
      case "scan-into": {
        const inDialog = dialog.contains(b);
        const input = inDialog ? $('[name="' + v + '"]', dialog) : $('[data-form="' + v + '"] input[name=id]');
        return scan((code) => {
          if (input) {
            input.value = code;
            input.focus();
          }
          if (!inDialog) {
            closeDialog();
            lookupUnit(code);
          }
        }, inDialog ? b.closest("fieldset") || dialog : null);
      }
      case "stop-scan":
        stopScanner();
        return;
      case "logout":
        await fetch("api/logout", { method: "POST", credentials: "same-origin", headers: { "X-Campus-Stores": "1" } });
        location.reload();
        return;
      case "backup":
        return download("campus-stores-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(S, null, 1), "application/json");
    }
  });

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const d = new FormData(f);
    const op = f.dataset.op;
    const close = { close: true, inDialog: true, opId: op };
    switch (f.dataset.form) {
      case "kit":
        return confirmIssue(f);
      case "issue-confirm":
        return dispatch("issue", { req: f.dataset.req, units: f.dataset.units.split(","), borrower: f.dataset.who, due: f.dataset.due }, close);
      case "return": {
        const nums = f.dataset.loans.split(",").map(Number);
        const items = nums
          .filter((n) => nums.length === 1 || d.get("include-" + n))
          .map((n) => {
            const a = D.getAsset(S, D.getLoan(S, n).asset);
            const back = d.getAll("acc-" + n);
            return { loan: n, verify: d.get("verify-" + n), condition: d.get("cond-" + n), missing: a.accessories.filter((x) => !back.includes(x)), remarks: d.get("remarks-" + n) || "" };
          });
        return dispatch("return", { returnedBy: d.get("returnedBy"), items }, close);
      }
      case "return-lookup":
        return lookupUnit(d.get("id"));
      case "expect":
        return dispatch("expect", { loan: Number(f.dataset.loan), who: d.get("who"), when: fromInput(d.get("when")) });
      case "note": {
        const res = await dispatch("note", { text: d.get("note") });
        if (res) f.reset();
        return;
      }
      case "task":
        return dispatch("task.add", { title: d.get("title"), responsible: d.get("responsible"), priority: d.get("priority"), due: fromInput(d.get("due")) });
      case "reverse":
        return dispatch("txn.reverse", { tx: f.dataset.tx, reason: d.get("reason") }, close);
      case "reject":
        return dispatch("request.reject", { id: f.dataset.id, reason: d.get("reason") }, close);
      case "cancel":
        return dispatch("request.cancel", { id: f.dataset.id, reason: d.get("reason") }, close);
      case "retire":
        return dispatch("maintenance.retire", { id: f.dataset.id, note: d.get("reason") }, close);
      case "request": {
        const items = [];
        for (const inp of $$("input[name=qty]", f)) for (let i = 0; i < Number(inp.value || 0); i++) items.push(inp.dataset.type);
        const payload = { items, pickup: fromInput(d.get("pickup")), due: fromInput(d.get("due")), note: d.get("note") };
        if (f.dataset.id) return dispatch("request.modify", { id: f.dataset.id, ...payload }, close);
        return dispatch("request.create", { ...payload, club: d.get("club"), event: d.get("event"), owner: d.get("owner") }, close);
      }
      case "asset-status":
        return dispatch("asset.setStatus", { id: f.dataset.id, status: d.get("status"), reason: d.get("reason"), reservedFor: d.get("reservedFor"), expected: fromInput(d.get("expected")) }, close);
      case "asset-report":
        return dispatch("asset.report", { id: f.dataset.id, status: d.get("status"), reason: d.get("reason") }, close);
      case "ticket":
        return dispatch("maintenance.update", { id: f.dataset.id, status: d.get("status"), technician: d.get("technician"), eta: fromInput(d.get("eta")), note: d.get("note") }, close);
      case "settings":
        return dispatch("settings.update", { tz: d.get("tz"), locale: d.get("locale").trim(), clock: d.get("clock") });
      case "login":
        return login(d);
    }
  });

  let filterTimer = null;
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "gsearch") return globalSearch(t.value);
    if (t.matches("[data-filter]") && t.type === "search") {
      const [page, k] = t.dataset.filter.split("|");
      F(page)[k] = t.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(paint, 120);
    }
  });
  root.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.name && t.name.startsWith("include-")) {
      // Units not coming back now are left out of the checks and the record.
      const fs = t.closest("fieldset");
      for (const el of $$("input, select, textarea, button", fs)) if (el !== t) el.disabled = !t.checked;
      fs.classList.toggle("skipped", !t.checked);
      return;
    }
    if (t.matches("[data-filter]") && t.type !== "search") {
      const [page, k] = t.dataset.filter.split("|");
      F(page)[k] = t.value;
      return paint();
    }
    if (t.matches("[data-switch-user]")) {
      Local.setUser(t.value);
      flash("Now acting as " + me.name + " · " + D.ROLES[me.role] + ".");
      return paint();
    }
    if (t.matches("[data-role-for]")) return dispatch("user.setRole", { id: t.dataset.roleFor, role: t.value });
    if (t.matches("[data-restore]") && t.files[0]) {
      try {
        const d = JSON.parse(await t.files[0].text());
        if (!D.validState(d)) throw new Error("bad");
        if (!confirm("Replace all records in this browser with this backup?")) return;
        d.rev = S.rev + 1;
        S = d;
        Local.write(S);
        if (Local.channel) Local.channel.postMessage({ rev: S.rev });
        flash("Backup restored.");
      } catch {
        flash("That file isn’t a Campus Stores backup.", "error");
      }
      return paint();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.target.closest("input, textarea, select") && !dialog.open) {
      e.preventDefault();
      $("#gsearch").focus();
    }
    if (e.key === "Escape" && (!$("#notifs").hidden || !$("#gresults").hidden)) {
      const fromBell = !$("#notifs").hidden;
      closePopovers();
      (fromBell ? $("[data-bell]") : $("#gsearch")).focus();
    }
    if (e.target.id === "gsearch" && e.key === "ArrowDown") {
      const first = $("#gresults button");
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
    if (e.target.closest && e.target.closest("#gresults") && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const all = $$("#gresults button");
      const i = all.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1);
      (all[i] || $("#gsearch")).focus();
    }
  });

  async function restartShift() {
    ui.request = null;
    ui.f = {};
    ui.dismissed = {};
    closeDialog();
    await dispatch("story.restart", {});
    if (mode === "local") Local.setUser(D.PHASES[0].staff);
    go("dashboard", { keepFlash: true });
  }

  // -------------------------------------------------------------- login
  function loginScreen(msg = "") {
    $("[data-nav]").innerHTML = "";
    $("[data-shiftbar]").hidden = true;
    $(".tools").hidden = true;
    $("[data-view]").innerHTML =
      head("Sign in to the desk", "Use the account your store manager gave you") +
      '<form data-form="login" class="form narrow">' + (msg ? '<p class="dlgerror full" role="alert">' + esc(msg) + "</p>" : "") +
      field("Username", '<input name="username" autocomplete="username" required data-autofocus>', "full") +
      field("Password", '<input name="password" type="password" autocomplete="current-password" required>', "full") +
      '<div class="full"><button type="submit" class="primary">Sign in</button></div></form>';
    $("[data-mode]").textContent = "Desk server";
    const f = $("[data-autofocus]");
    if (f) f.focus();
  }
  async function login(d) {
    const r = await fetch("api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Campus-Stores": "1" },
      body: JSON.stringify({ username: d.get("username"), password: d.get("password") }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return loginScreen(e.error || "Sign-in failed.");
    }
    location.reload();
  }

  // --------------------------------------------------------------- boot
  async function boot() {
    if (location.protocol.startsWith("http")) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch("api/health", { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok && (await r.json()).app === "campus-stores") mode = "remote";
      } catch {
        /* static hosting: use this browser's storage */
      }
    }
    if (mode === "remote") {
      if (!(await Remote.init())) return loginScreen();
      $(".tools").hidden = false;
    } else Local.init();
    paint();
    // Small hook for the guided demo (tour.js). Local sample mode only.
    if (mode === "local")
      window.CampusStores = {
        restart: restartShift,
        go: (page) => go(page),
        closeDialog,
        dialog,
      };
    document.dispatchEvent(new CustomEvent("campus-stores:ready", { detail: { mode } }));
  }
  boot();
})();
