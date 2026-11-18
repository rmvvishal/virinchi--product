/*
 * Guided demo: walks a reviewer through the sample shift.
 *
 * It drives the real UI the way a person would (clicks, typing, choosing),
 * so what the reviewer sees is exactly what a desk worker would get.
 * Back replays the shift from the start up to the previous step.
 */
(() => {
  "use strict";
  const root = document.getElementById("campus-stores");
  const $ = (s, el = document) => el.querySelector(s);
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---- scripted user
  async function click(sel) {
    const el = typeof sel === "string" ? $(sel, root) : sel;
    if (!el) throw new Error("Demo couldn't find " + sel);
    el.click();
    await wait();
  }
  async function fill(sel, value) {
    const el = $(sel, root);
    if (!el) throw new Error("Demo couldn't find " + sel);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(30);
  }
  async function tick(sel, on = true) {
    const el = $(sel, root);
    if (!el) throw new Error("Demo couldn't find " + sel);
    el.checked = on;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(30);
  }
  const nav = (page) => click('nav [data-val="' + page + '"]');
  const actAs = (id) => fill("[data-switch-user]", id);

  // ---- the script
  // Each step: where to look (target), what to say, and what to do on entering it.
  const STEPS = [
    {
      title: "Guided demo",
      text: "This tour runs the brief’s job from start to finish: the Film Society pickup at 3:45 pm, the partial return at 7:30 pm, and the next morning’s handover. Then it shows the safety nets around it.<br><br>It drives the real app as a desk worker would. Starting resets the sample shift.",
      next: "Start",
    },
    {
      title: "Friday 3:45 pm · the desk at a glance",
      text: "Arjun, a desk operator, opens the dashboard. Each tile is a live count and opens its filtered list. Quick actions cover the jobs a counter does most.",
      target: ".tiles",
      enter: async () => {
        await window.CampusStores.restart();
        await wait(100);
      },
    },
    {
      title: "Notifications",
      text: "The bell collects what needs a person: pickups coming up, overdue or soon-due loans, damaged kit, and handovers to acknowledge. Each staff member can dismiss their own.",
      target: "[data-bell]",
    },
    {
      title: "Kabir is at the counter",
      text: "The Film Society’s request opens as a <b>kit</b>. Every approved item already has a unit picked, with its shelf. The broken projector PR-06 is shown but can’t be chosen.",
      target: ".kit",
      enter: async () => {
        await nav("requests");
        await click('[data-action="open-request"][data-val="RQ-214"]');
      },
    },
    {
      title: "The club’s message, where it’s needed",
      text: "Isha asked for the kit to be issued in Kabir’s name. Before, that message was hidden in a separate desk book. Now it sits on the request.",
      target: ".related",
    },
    {
      title: "Who’s collecting, and when it’s due",
      text: "Pick the borrower. The return time comes from the approved request, in the desk’s own time zone.",
      target: "#kit-form",
      enter: async () => {
        await fill("#kit-form select[name=who]", "Kabir Sen");
      },
      next: "Review and issue",
    },
    {
      title: "Confirm before anything leaves the desk",
      text: "One last check: request, borrower, deadline, item count, the exact unit IDs, and the accessories to hand over. Nothing is issued until the operator ticks <i>“I have verified…”</i>.",
      target: "dialog[open] table",
      enter: async () => {
        await click("#kit-form button[type=submit]");
      },
      next: "Tick and issue",
    },
    {
      title: "Issued, with a transaction ID",
      text: "One click made three slips (one per physical unit) under a single transaction ID. The message offers a printable pickup receipt and an audited <b>Reverse</b> in case of a mistake. Clicking twice can’t issue twice.",
      target: "[data-flash]",
      enter: async () => {
        await tick("dialog input[name=ok]");
        await click("dialog button[type=submit]");
      },
    },
    {
      title: "7:30 pm · the kit comes back in pieces",
      text: "Kabir brings back the projector and speaker. Leela still has the adapter.",
      target: "[data-shiftbar]",
      enter: async () => {
        await click('[data-action="advance"]');
      },
      next: "Record the returns",
    },
    {
      title: "Return only what came back",
      text: "One form for the whole kit. The adapter is unticked because it isn’t here, so its slip stays open. The operator types (or scans) the ID on each unit’s label.",
      target: 'dialog fieldset[data-loan="403"]',
      enter: async () => {
        await click('[data-action="return"][data-val="402,403,404"]');
        await tick("dialog input[name=include-404]", false);
        await fill("dialog input[name=verify-402]", "PR-04");
        await fill("dialog input[name=verify-403]", "SP-05");
      },
      next: "Confirm",
    },
    {
      title: "Caught: wrong unit",
      text: "The speaker on the counter is SP-05, but the slip is for SP-02. The app refuses to close the wrong loan and says exactly why. Before, any slip could be closed with one click.",
      target: "[data-dlg-error]",
      enter: async () => {
        await tick("dialog input[name=ok]");
        await click("dialog button[type=submit]");
      },
      next: "Fix it",
    },
    {
      title: "Condition and accessories",
      text: "With the right speaker, the operator notices its power cable is missing and unticks it. Condition, missing parts and remarks are recorded with the return.",
      target: 'dialog fieldset[data-loan="403"] .accs',
      enter: async () => {
        await fill("dialog input[name=verify-403]", "SP-02");
        await tick('dialog input[name=acc-403][value="Power cable"]', false);
      },
      next: "Confirm return",
    },
    {
      title: "Damaged kit stays off the shelf",
      text: "The projector goes back to shelf A2. The speaker is <b>held for inspection</b>, a maintenance ticket opens automatically, and it can’t be issued again until a store manager clears it.",
      target: "[data-flash]",
      enter: async () => {
        await click("dialog button[type=submit]");
      },
    },
    {
      title: "Hand over the adapter",
      text: "On the adapter’s own slip: Leela Das will bring it back Saturday at 9. This is saved on the slip, not in a free-text note, and it creates a handover task for the morning shift.",
      target: () => { const f = $('form[data-loan="404"]', root); return f && f.closest(".kitline"); },
      enter: async () => {
        const d = $('form[data-loan="404"]', root).closest("details");
        d.open = true;
        await fill('form[data-loan="404"] select[name=who]', "Leela Das");
        await fill('form[data-loan="404"] input[name=when]', "2026-11-21T09:00");
        await click('form[data-loan="404"] button[type=submit]');
      },
    },
    {
      title: "Saturday 9:00 am · a new person at the desk",
      text: "Meera takes over. Without asking anyone she can see one overdue loan, a speaker in repair, and a handover waiting for her.",
      target: ".callout",
      enter: async () => {
        await click('[data-action="advance"]');
        await nav("dashboard");
      },
    },
    {
      title: "Read and acknowledge the handover",
      text: "The task says who is bringing what and when, with its priority. Meera acknowledges it, and the app records who took over the job and when.",
      target: "#view .tablewrap",
      enter: async () => {
        await nav("deskbook");
      },
      next: "Acknowledge",
    },
    {
      title: "Leela walks in with an adapter",
      text: "Meera scans or types the label, <b>AD-12</b>. The app finds the open slip from the screening. Leela isn’t named on the slip, but she is pre-filled because of last night’s handover.",
      target: "dialog select[name=returnedBy]",
      enter: async () => {
        await click('[data-action="ack"]');
        await nav("returns");
        await fill("form[data-form=return-lookup] input[name=id]", "AD-12");
        await click("form[data-form=return-lookup] button[type=submit]");
      },
      next: "Check and confirm",
    },
    {
      title: "The right loan, closed",
      text: "The adapter is back on shelf C4, the Film Society request is closed, and the handover task closed itself.",
      target: "[data-flash]",
      enter: async () => {
        await fill("dialog input[name=verify-404]", "AD-12");
        await tick("dialog input[name=ok]");
        await click("dialog button[type=submit]");
      },
    },
    {
      title: "Every change is on the record",
      text: "Each action has a transaction ID, a person and a time. Mistakes are fixed by a <b>reversal</b>: a new record with a reason, never an edit. Operators can reverse their own latest record; managers can reverse any.",
      target: "#view .tablewrap",
      enter: async () => {
        await nav("activity");
      },
    },
    {
      title: "Store manager · maintenance",
      text: "Switching to Priya, a store manager. The speaker from last night has its own ticket, with technician, expected date and history. Only a manager can clear it back to the shelf or retire it.",
      target: "#view .ticket",
      enter: async () => {
        await actAs("priya");
        await nav("maintenance");
      },
    },
    {
      title: "Inventory tells you why",
      text: "Every unit shows its status, the reason it’s unavailable and when it’s expected back. Filters, CSV export and printable barcode labels are here too.",
      target: () => { const b = $('[data-action="asset"][data-val="SP-02"]', root); return b && b.closest("tr"); },
      enter: async () => {
        await nav("inventory");
      },
    },
    {
      title: "Reports",
      text: "Utilisation, most-borrowed units, damage rate, late returns and monthly activity, for the term or the last 30 or 7 days. Each table can be exported or printed.",
      target: "#view .panel",
      enter: async () => {
        await nav("reports");
      },
    },
    {
      title: "That’s the tour",
      text: "Everything you saw is a working record. Explore from here, use <i>Acting as</i> to switch roles, or press <b>Restart sample shift</b> to start fresh.<br><br>For a shared desk with real logins, run <code>node server.js</code>.",
      next: "Finish",
    },
  ];

  // ---- the card and the spotlight
  const card = document.createElement("div");
  card.className = "cs-tour";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Guided demo");
  const ring = document.createElement("div");
  ring.className = "cs-tour-ring";
  ring.setAttribute("aria-hidden", "true");

  let at = -1;
  let running = false;
  let target = null;
  let poll = null;

  function host() {
    // A modal dialog makes the rest of the page inert, so the card has to live inside it.
    const d = $("dialog[open]", root);
    return d || document.body;
  }
  function mount() {
    const h = host();
    if (card.parentNode !== h) h.appendChild(card);
    if (ring.parentNode !== h) h.appendChild(ring);
  }
  function findTarget(step) {
    if (!step.target) return null;
    return typeof step.target === "function" ? step.target() : $(step.target, root);
  }
  function place() {
    if (at < 0) return;
    mount();
    target = findTarget(STEPS[at]);
    if (!target || !target.getClientRects().length) {
      ring.hidden = true;
      card.classList.add("center");
      return;
    }
    card.classList.remove("center");
    const r = target.getBoundingClientRect();
    Object.assign(ring.style, { top: r.top - 6 + "px", left: r.left - 6 + "px", width: r.width + 12 + "px", height: r.height + 12 + "px" });
    ring.hidden = false;
  }
  function render(error = "") {
    const s = STEPS[at];
    const last = at === STEPS.length - 1;
    card.innerHTML =
      '<div class="cs-tour-top"><span>Step ' + (at + 1) + " of " + STEPS.length + '</span><button type="button" class="cs-tour-x" data-tour="exit" aria-label="Exit demo">×</button></div>' +
      '<div class="cs-tour-bar"><span></span></div>' +
      '<h2 class="cs-tour-title" tabindex="-1">' + esc(s.title) + "</h2>" +
      '<p class="cs-tour-text" aria-live="polite">' + s.text + "</p>" +
      (error ? '<p class="cs-tour-error" role="alert">' + esc(error) + "</p>" : "") +
      '<div class="cs-tour-actions">' +
      (at > 0 && !last ? '<button type="button" data-tour="back">Back</button>' : "<span></span>") +
      '<button type="button" class="cs-tour-next" data-tour="next">' + esc(s.next || (last ? "Finish" : "Next")) + " →</button></div>";
    card.querySelector(".cs-tour-bar span").style.width = ((at + 1) / STEPS.length) * 100 + "%";
    place();
    if (target) target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(place, 350);
    const next = card.querySelector(".cs-tour-next");
    if (next) next.focus({ preventScroll: true });
  }
  async function goTo(i) {
    if (running) return;
    running = true;
    card.classList.add("busy");
    try {
      // Going back replays a clean shift up to the earlier step.
      const from = i < at ? 0 : at + 1;
      if (i < at) {
        const p = card.querySelector(".cs-tour-text");
        if (p) p.textContent = "Replaying the shift up to the previous step…";
      }
      for (let k = from; k <= i; k++) {
        if (STEPS[k].enter) await STEPS[k].enter();
        mount();
      }
      at = i;
      render();
    } catch (e) {
      at = Math.max(at, 0);
      render("The demo got out of step with the app (" + e.message + "). Press Back to replay, or exit and restart the sample shift.");
    } finally {
      running = false;
      card.classList.remove("busy");
    }
  }
  function start() {
    if (!window.CampusStores) return;
    at = 0;
    document.body.classList.add("cs-touring");
    render();
    poll = setInterval(place, 250);
  }
  function exit() {
    clearInterval(poll);
    at = -1;
    card.remove();
    ring.remove();
    document.body.classList.remove("cs-touring");
    const b = $("[data-demo-start]", root);
    if (b) b.focus();
  }

  card.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tour]");
    if (!b || running) return;
    e.stopPropagation();
    const a = b.dataset.tour;
    if (a === "exit") return exit();
    if (a === "back") return goTo(at - 1);
    if (a === "next") return at === STEPS.length - 1 ? exit() : goTo(at + 1);
  });
  document.addEventListener("keydown", (e) => {
    if (at < 0 || running) return;
    if (e.key === "Escape" && !$("dialog[open]", root)) exit();
  });
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);

  function init(mode) {
    const b = $("[data-demo-start]", root);
    if (!b) return;
    b.hidden = mode !== "local";
    b.addEventListener("click", start);
    if (new URLSearchParams(location.search).has("demo")) start();
  }
  if (window.CampusStores) init("local");
  else document.addEventListener("campus-stores:ready", (e) => init(e.detail.mode), { once: true });
})();
