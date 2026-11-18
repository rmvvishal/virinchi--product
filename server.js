#!/usr/bin/env node
/*
 * Campus Stores desk server — zero dependencies, Node 20+.
 *
 *   node server.js                 start (http://127.0.0.1:8080)
 *   node server.js passwd <user>   set a password (reads CAMPUS_NEW_PASSWORD)
 *
 * What it gives you over opening index.html:
 *   - one shared database for every computer at the desk (data/db.json)
 *   - real sign-in (scrypt-hashed passwords, HttpOnly session cookies)
 *   - roles enforced on the server, not just hidden in the UI
 *   - every change applied in order by the same rules as the browser
 *     (domain.js), so two desks can never issue the same unit
 *   - live updates to every open screen (Server-Sent Events)
 *   - atomic writes and rolling backups (data/backups/)
 *
 * Environment:
 *   PORT (8080), HOST (127.0.0.1), DATA_DIR (./data)
 *   SECURE_COOKIES=1 when served over HTTPS (behind a proxy)
 *   CAMPUS_INITIAL_PASSWORD  first-run password for every account (demos/tests only)
 */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const D = require("./domain.js");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DB = path.join(DATA, "db.json");
const USERS = path.join(DATA, "users.json");
const BACKUPS = path.join(DATA, "backups");
const SECURE = process.env.SECURE_COOKIES === "1";
const SESSION_HOURS = 12;
const BACKUP_EVERY = 20;
const KEEP_BACKUPS = 30;

// ------------------------------------------------------------- storage
fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });

function writeAtomic(file, data) {
  const tmp = file + "." + process.pid + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}
function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(DB, "utf8"));
    if (D.validState(d)) return d;
    console.error("data/db.json failed validation — starting from the newest valid backup.");
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Could not read data/db.json:", e.message);
  }
  for (const f of listBackups().reverse()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(BACKUPS, f), "utf8"));
      if (D.validState(d)) return d;
    } catch {
      /* try the next one */
    }
  }
  return D.seed();
}
const listBackups = () => fs.readdirSync(BACKUPS).filter((f) => /^db-.*\.json$/.test(f)).sort();
function backup() {
  writeAtomic(path.join(BACKUPS, "db-" + new Date().toISOString().replace(/[:.]/g, "-") + "-r" + state.rev + ".json"), JSON.stringify(state));
  const all = listBackups();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUPS, f));
}

let state = loadState();
writeAtomic(DB, JSON.stringify(state));
let opsSinceBackup = 0;

// --------------------------------------------------------------- users
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex") };
}
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS, "utf8"));
  } catch {
    const shared = process.env.CAMPUS_INITIAL_PASSWORD;
    const created = state.users.map((u) => {
      const pw = shared || crypto.randomBytes(9).toString("base64url");
      return { username: u.id, id: u.id, initial: pw, ...hashPassword(pw) };
    });
    writeAtomic(USERS, JSON.stringify(created.map(({ initial, ...u }) => u), null, 1));
    if (!shared) {
      console.log("\nFirst run: created desk accounts. Give each person their password, then ask them to change it.");
      for (const u of created) console.log("  " + u.username.padEnd(8) + " " + u.initial);
      console.log("Change one with: CAMPUS_NEW_PASSWORD='…' node server.js passwd <username>\n");
    }
    return created.map(({ initial, ...u }) => u);
  }
}
let users = loadUsers();

if (process.argv[2] === "passwd") {
  const name = process.argv[3];
  const pw = process.env.CAMPUS_NEW_PASSWORD || "";
  const u = users.find((x) => x.username === name);
  if (!u) {
    console.error("No such user: " + name);
    process.exit(1);
  }
  if (pw.length < 10) {
    console.error("Set CAMPUS_NEW_PASSWORD to at least 10 characters.");
    process.exit(1);
  }
  Object.assign(u, hashPassword(pw));
  writeAtomic(USERS, JSON.stringify(users, null, 1));
  console.log("Password updated for " + name + ".");
  process.exit(0);
}

const sessions = new Map(); // token -> { userId, expires }
const failures = new Map(); // ip|user -> { n, until }
function staff(userId) {
  const u = state.users.find((x) => x.id === userId);
  return u ? { id: u.id, name: u.name, role: u.role } : null;
}
function sessionUser(req) {
  const m = /(?:^|;\s*)cs_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) {
    sessions.delete(m[1]);
    return null;
  }
  s.expires = Date.now() + SESSION_HOURS * 3600e3;
  return staff(s.userId);
}
const cookie = (token, maxAge) =>
  "cs_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + (SECURE ? "; Secure" : "");

// ---------------------------------------------------------- live updates
const listeners = new Set();
function broadcast() {
  const msg = "data: " + JSON.stringify({ state }) + "\n\n";
  for (const l of listeners) l.write(msg);
}
setInterval(() => {
  for (const l of listeners) l.write(": keep-alive\n\n");
}, 25000).unref();

// ------------------------------------------------------------------ http
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/domain.js": ["domain.js", "text/javascript; charset=utf-8"],
  "/tour.js": ["tour.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/third-party/lucide-LICENSE.txt": ["third-party/lucide-LICENSE.txt", "text/plain; charset=utf-8"],
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": isJson ? "application/json; charset=utf-8" : headers["Content-Type"] || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("Invalid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}
// Browsers can't add this header cross-site without a CORS preflight we never answer,
// so requiring it on every write blocks cross-site request forgery.
const csrfOk = (req) => req.headers["x-campus-stores"] === "1";

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/health") return send(res, 200, { app: "campus-stores", schema: D.SCHEMA });

  if (p === "/api/login" && req.method === "POST") {
    if (!csrfOk(req)) return send(res, 403, { error: "Forbidden." });
    const body = await readJson(req, 4096);
    const name = String(body.username || "").trim().toLowerCase();
    const key = req.socket.remoteAddress + "|" + name;
    const f = failures.get(key);
    if (f && f.until > Date.now() && f.n >= 5) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const u = users.find((x) => x.username === name);
    const check = u ? hashPassword(String(body.password || ""), u.salt).hash : hashPassword("x").hash;
    const ok = u && crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(u.hash, "hex")) && staff(u.id);
    if (!ok) {
      failures.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60e3 });
      return send(res, 401, { error: "Wrong username or password." });
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { userId: u.id, expires: Date.now() + SESSION_HOURS * 3600e3 });
    return send(res, 200, { user: staff(u.id) }, { "Set-Cookie": cookie(token, SESSION_HOURS * 3600) });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const m = /(?:^|;\s*)cs_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || "");
    if (m) sessions.delete(m[1]);
    return send(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
  }

  if (p.startsWith("/api/")) {
    const user = sessionUser(req);
    if (!user) return send(res, 401, { error: "Sign in first." });

    if (p === "/api/session") return send(res, 200, { user, state });

    if (p === "/api/events") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write("data: " + JSON.stringify({ state }) + "\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (p === "/api/ops" && req.method === "POST") {
      if (!csrfOk(req)) return send(res, 403, { error: "Forbidden." });
      const op = await readJson(req);
      if ((op.type === "story.restart" || op.type === "story.advance") && user.role !== "admin" && user.role !== "manager")
        return send(res, 403, { error: "Only a store manager or admin can move the sample shift on a shared desk." });
      if (op.type === "story.restart" && user.role !== "admin") return send(res, 403, { error: "Only an admin can restart the shared desk." });
      try {
        const out = D.apply(state, { type: op.type, payload: op.payload, id: typeof op.id === "string" ? op.id.slice(0, 80) : undefined }, { user, now: D.nowFor(state) });
        if (!out.duplicate) {
          state = out.state;
          writeAtomic(DB, JSON.stringify(state));
          if (++opsSinceBackup >= BACKUP_EVERY || op.type === "story.restart") {
            backup();
            opsSinceBackup = 0;
          }
          broadcast();
        }
        return send(res, 200, { state, notice: out.notice, receipt: out.receipt, tx: out.tx, duplicate: !!out.duplicate });
      } catch (e) {
        if (e instanceof D.DomainError) return send(res, /role/.test(e.message) ? 403 : 409, { error: e.message, state });
        throw e;
      }
    }
    return send(res, 404, { error: "Not found." });
  }

  const file = STATIC[p];
  if (!file || (req.method !== "GET" && req.method !== "HEAD")) return send(res, 404, "Not found");
  return send(res, 200, fs.readFileSync(path.join(__dirname, file[0])), { "Content-Type": file[1], "Cache-Control": "no-cache" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "Server error." });
    if (!e.status) console.error(e);
  });
});
server.listen(PORT, HOST, () => {
  backup();
  console.log("Campus Stores desk server on http://" + HOST + ":" + server.address().port + " · data in " + DATA);
});
function shutdown() {
  try {
    writeAtomic(DB, JSON.stringify(state));
    backup();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
