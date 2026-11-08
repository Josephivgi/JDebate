"use strict";

// One battle database for the JDebate app and every agent. The app opens
// battles; agents send entries (HTML, CSS and JS) through the jdebate MCP
// server. Both use ~/.jdebate/jdebate.db at the same time, so every
// check-then-write runs in one BEGIN IMMEDIATE transaction.
//
// Agents name battles and entries by number (battle 3, entry 2); the app
// uses ids. The two are never mixed on one path.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const similarity = require("./similarity.js");
const files = require("./files.js");

const MAX_CODE = 400000;
const MAX_TASK = 20000;
const DRAFT_MINUTES = 30;
// What a battle asks for. page: one page. website: a site with pages and
// images, sent as a folder. video: a clip of video_seconds at
// video_size, sent as an animation page or as a finished video file.
// model: a 3D model made in Blender (a .glb, PNG renders, Roblox import
// files), shown next to the battle's current version for approve or deny.
const KINDS = ["page", "website", "video", "model", "icon"];
const REVIEWS = ["", "approved", "denied"];
const VIDEO_SIZES = ["1280x720", "1080x1920", "1080x1080"];

function dataHome(home) {
  if (home) return path.join(home, ".jdebate");
  return process.env.JDEBATE_HOME ? path.resolve(process.env.JDEBATE_HOME) : path.join(os.homedir(), ".jdebate");
}

// Database files whose tables this process already made. The setup below
// writes (INSERT OR IGNORE), so running it on every read would take the write
// lock and wait behind an agent's submit; the app's preview frames read here.
const ready = new Set();

// The app keeps one connection per database open (keepOpen). Opening and
// closing on every call costs 20-150 ms on Windows (the close checkpoints the
// WAL), and the preview frames ask for an entry on every file they load. The
// MCP server and tests open per call, so nothing holds the file between runs.
let keep = false;
const open = new Map(); // file -> DatabaseSync

function keepOpen(on = true) {
  keep = Boolean(on);
  if (!keep) closeAll();
}

function closeAll() {
  for (const db of open.values()) {
    try {
      db.close();
    } catch {}
  }
  open.clear();
}

function withDb(home, fn) {
  const dir = dataHome(home);
  const file = path.join(dir, "jdebate.db");
  if (ready.has(file) && !fs.existsSync(file)) {
    ready.delete(file);
    const old = open.get(file);
    if (old) {
      open.delete(file);
      try {
        old.close();
      } catch {}
    }
  }
  if (keep && open.has(file)) return fn(open.get(file));
  if (!ready.has(file)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  let kept = false;
  try {
    db.exec("PRAGMA busy_timeout=20000; PRAGMA foreign_keys=ON;");
    if (!ready.has(file)) setup(db);
    ready.add(file);
    if (keep) {
      open.set(file, db);
      kept = true;
    }
    return fn(db);
  } finally {
    if (!kept) db.close();
  }
}

function setup(db) {
  db.exec(
    "PRAGMA journal_mode=WAL;" +
      "CREATE TABLE IF NOT EXISTS battles (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, winner_id TEXT, created_at INTEGER NOT NULL, closed_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, battle_id TEXT NOT NULL REFERENCES battles(id) ON DELETE CASCADE, num INTEGER NOT NULL, agent TEXT NOT NULL, client TEXT NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL, css TEXT NOT NULL, js TEXT NOT NULL, notes TEXT NOT NULL, how_made TEXT NOT NULL, matches TEXT NOT NULL, key_hash TEXT NOT NULL, replaced_by TEXT, removed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (battle_id, num));" +
      "CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, battle_id TEXT NOT NULL REFERENCES battles(id) ON DELETE CASCADE, agent TEXT NOT NULL, client TEXT NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL, css TEXT NOT NULL, js TEXT NOT NULL, notes TEXT NOT NULL, replaces TEXT, matches TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER);" +
      "CREATE TABLE IF NOT EXISTS stamp (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);" +
      "INSERT OR IGNORE INTO stamp (id, value) VALUES (1, 0);" +
      // The last battle number handed out. Numbers are never used twice,
      // so an agent told "battle 3" never lands in a newer battle.
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), battle INTEGER NOT NULL);" +
      "INSERT OR IGNORE INTO counter (id, battle) VALUES (1, 0);" +
      // App settings, such as the theme. Agents never read these.
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
      // Work rounds: the battles the user picked to review. At most one draft
      // (the work in progress); sending it freezes the results for agents.
      "CREATE TABLE IF NOT EXISTS work_rounds (id TEXT PRIMARY KEY, num INTEGER, status TEXT NOT NULL, battle_ids TEXT NOT NULL, results TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, sent_at INTEGER);",
  );
  // Columns added after the first release. Old copies of the server keep
  // working: every new column has a default.
  const add = {
    // old_files / old_notes: the current version a model battle redesigns.
    battles: ["kind TEXT NOT NULL DEFAULT 'page'", "video_seconds INTEGER NOT NULL DEFAULT 30", "video_size TEXT NOT NULL DEFAULT '1280x720'", "old_files TEXT NOT NULL DEFAULT '[]'", "old_notes TEXT NOT NULL DEFAULT ''",
      // no_winner: the user judged the battle and no entry won; the reason is shown to agents.
      "no_winner INTEGER NOT NULL DEFAULT 0", "no_winner_reason TEXT NOT NULL DEFAULT ''",
      // feedback: the user's notes for agents, read in battle_read and work rounds.
      "feedback TEXT NOT NULL DEFAULT ''"],
    // format: html (html, css, js), site (files, index.html first) or video (one video file).
    // review: '' (waiting), approved or denied, with the user's note.
    entries: ["format TEXT NOT NULL DEFAULT 'html'", "extra TEXT NOT NULL DEFAULT ''", "files TEXT NOT NULL DEFAULT '[]'", "review TEXT NOT NULL DEFAULT ''", "review_note TEXT NOT NULL DEFAULT ''", "reviewed_at INTEGER"],
    drafts: ["format TEXT NOT NULL DEFAULT 'html'", "extra TEXT NOT NULL DEFAULT ''", "files TEXT NOT NULL DEFAULT '[]'"],
  };
  for (const [table, cols] of Object.entries(add)) {
    const have = new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name));
    for (const col of cols) {
      if (have.has(col.split(" ")[0])) continue;
      try {
        db.exec("ALTER TABLE " + table + " ADD COLUMN " + col);
      } catch (e) {
        // Another process added it first.
        if (!/duplicate column/i.test(String(e.message))) throw e;
      }
    }
  }
  // Battle lists count live entries per battle and the activity feed sorts by
  // time; without these every list scans the entries' code.
  db.exec(
    "CREATE INDEX IF NOT EXISTS entries_live ON entries (battle_id, removed, replaced_by);" +
      "CREATE INDEX IF NOT EXISTS entries_created ON entries (created_at);",
  );
}

function tx(home, fn) {
  return withDb(home, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(db);
      db.prepare("UPDATE stamp SET value = value + 1 WHERE id = 1").run();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
}

// Goes up on every change, so the app only redraws when something happened.
function stamp(home) {
  return withDb(home, (db) => db.prepare("SELECT value FROM stamp WHERE id = 1").get().value);
}

// ---- Values ----

function text(v, what, max, opts) {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new Error(what + " must be text.");
  const t = opts && opts.raw ? v : v.trim();
  if (!t.trim() && !(opts && opts.optional)) throw new Error(what + " must not be empty.");
  if (t.length > max) throw new Error(what + " is longer than " + max + " characters.");
  return t;
}

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

function kindOf(v) {
  const k = v === undefined || v === null || v === "" ? "page" : String(v);
  if (!KINDS.includes(k)) throw new Error("kind must be one of " + KINDS.join(", ") + ".");
  return k;
}

function videoSeconds(v) {
  if (v === undefined || v === null || v === "") return 30;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 3 || n > 600) throw new Error("The video length must be a whole number of seconds from 3 to 600.");
  return n;
}

function videoSize(v) {
  const s = v === undefined || v === null || v === "" ? VIDEO_SIZES[0] : String(v);
  if (!VIDEO_SIZES.includes(s)) throw new Error("The video size must be one of " + VIDEO_SIZES.join(", ") + ".");
  return s;
}

// The kind fields of a new battle or an edit. Only fields in input are read.
function kindFields(input, all) {
  const out = {};
  if (all || Object.hasOwn(input, "kind")) out.kind = kindOf(input.kind);
  if (all || Object.hasOwn(input, "videoSeconds")) out.video_seconds = videoSeconds(input.videoSeconds);
  if (all || Object.hasOwn(input, "videoSize")) out.video_size = videoSize(input.videoSize);
  return out;
}

// ---- Rows ----

function battleRow(db, r) {
  if (!r) return null;
  const c = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL").get(r.id).n;
  // Who sent entries, and the winner's number, title and agent, for lists.
  const agents = db.prepare("SELECT agent FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL GROUP BY agent ORDER BY MIN(num)").all(r.id).map((x) => x.agent);
  const w = r.winner_id ? db.prepare("SELECT num, title, agent FROM entries WHERE id = ?").get(r.winner_id) : null;
  const rv = db.prepare("SELECT review, COUNT(*) AS n FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL GROUP BY review").all(r.id);
  const reviews = { waiting: 0, approved: 0, denied: 0 };
  for (const x of rv) reviews[x.review || "waiting"] = x.n;
  return { ...r, old_files: JSON.parse(r.old_files || "[]"), entries: c, agents, reviews, winner: w ? { num: w.num, title: w.title, agent: w.agent } : null };
}

function entryRow(r, opts) {
  if (!r) return null;
  const out = { ...r, matches: JSON.parse(r.matches), files: JSON.parse(r.files || "[]") };
  delete out.key_hash;
  if (opts && opts.noCode) {
    delete out.html;
    delete out.css;
    delete out.js;
    delete out.extra;
  }
  return out;
}

// ---- Battles ----

// input: { title, task, kind, videoSeconds, videoSize }
function openBattle(home, input = {}) {
  const title = text(input.title, "title", 200);
  const task = text(input.task, "task", MAX_TASK);
  const k = kindFields(input, true);
  return tx(home, (db) => {
    const last = db.prepare("SELECT battle FROM counter WHERE id = 1").get().battle;
    const num = Math.max(last, db.prepare("SELECT COALESCE(MAX(num), 0) AS n FROM battles").get().n) + 1;
    db.prepare("UPDATE counter SET battle = ? WHERE id = 1").run(num);
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO battles (id, num, title, task, status, created_at, kind, video_seconds, video_size) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)").run(
      id, num, title, task, Date.now(), k.kind, k.video_seconds, k.video_size,
    );
    return battleRow(db, db.prepare("SELECT * FROM battles WHERE id = ?").get(id));
  });
}

function listBattles(home) {
  return withDb(home, (db) => db.prepare("SELECT * FROM battles ORDER BY status = 'open' DESC, num DESC").all().map((r) => battleRow(db, r)));
}

// The app passes an id; agents pass the battle number with { byNum: true }.
function findBattle(db, ref, opts) {
  if (opts && opts.byNum) {
    const n = Number(String(ref).replace(/^#/, ""));
    return Number.isInteger(n) ? db.prepare("SELECT * FROM battles WHERE num = ?").get(n) : undefined;
  }
  return db.prepare("SELECT * FROM battles WHERE id = ?").get(String(ref));
}

function getBattle(home, ref, opts) {
  return withDb(home, (db) => battleRow(db, findBattle(db, ref, opts)));
}

function setStatus(home, id, status) {
  return tx(home, (db) => {
    const b = findBattle(db, id);
    if (!b) throw new Error("That battle is gone.");
    db.prepare("UPDATE battles SET status = ?, closed_at = ? WHERE id = ?").run(status, status === "closed" ? Date.now() : null, b.id);
    return battleRow(db, findBattle(db, b.id));
  });
}

const closeBattle = (home, id) => setStatus(home, id, "closed");
const reopenBattle = (home, id) => setStatus(home, id, "open");

function editBattle(home, id, patch) {
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object.");
  const changes = {};
  if (Object.hasOwn(patch, "title")) changes.title = text(patch.title, "title", 200);
  if (Object.hasOwn(patch, "task")) changes.task = text(patch.task, "task", MAX_TASK);
  Object.assign(changes, kindFields(patch, false));
  return tx(home, (db) => {
    const b = findBattle(db, id);
    if (!b) throw new Error("That battle is gone.");
    if (changes.kind && changes.kind !== b.kind && db.prepare("SELECT COUNT(*) AS n FROM entries WHERE battle_id = ? AND removed = 0").get(b.id).n) {
      throw new Error("This battle already has entries, so its kind cannot change. Open a new battle instead.");
    }
    const keys = Object.keys(changes);
    if (keys.length) db.prepare("UPDATE battles SET " + keys.map((k) => k + " = ?").join(", ") + " WHERE id = ?").run(...keys.map((k) => changes[k]), b.id);
    return battleRow(db, findBattle(db, b.id));
  });
}

function removeBattle(home, id) {
  return tx(home, (db) => db.prepare("DELETE FROM battles WHERE id = ?").run(String(id)).changes > 0);
}

function setWinner(home, battleId, entryId) {
  return tx(home, (db) => {
    const b = findBattle(db, battleId);
    if (!b) throw new Error("That battle is gone.");
    if (entryId) {
      const e = db.prepare("SELECT * FROM entries WHERE id = ? AND battle_id = ? AND removed = 0 AND replaced_by IS NULL").get(String(entryId), b.id);
      if (!e) throw new Error("That entry is not in this battle any more.");
    }
    // Picking a winner undoes "No winner"; clearing the winner leaves it alone.
    if (entryId) db.prepare("UPDATE battles SET winner_id = ?, no_winner = 0, no_winner_reason = '' WHERE id = ?").run(String(entryId), b.id);
    else db.prepare("UPDATE battles SET winner_id = NULL WHERE id = ?").run(b.id);
    return battleRow(db, findBattle(db, b.id));
  });
}

// Mark a battle as having no winner, with a reason agents read in battle_read
// and battle_results. reason null clears it.
function setNoWinner(home, battleId, reason) {
  const clear = reason === null || reason === undefined;
  const why = clear ? "" : String(reason).trim().slice(0, MAX_TASK);
  if (!clear && !why) throw new Error("Say why no entry won. Agents see the reason.");
  return tx(home, (db) => {
    const b = findBattle(db, battleId);
    if (!b) throw new Error("That battle is gone.");
    if (clear) db.prepare("UPDATE battles SET no_winner = 0, no_winner_reason = '' WHERE id = ?").run(b.id);
    else db.prepare("UPDATE battles SET winner_id = NULL, no_winner = 1, no_winner_reason = ? WHERE id = ?").run(why, b.id);
    return battleRow(db, findBattle(db, b.id));
  });
}

// Notes for agents on a battle: what to change in a redesign.
function setFeedback(home, battleId, notes) {
  const t = text(notes, "Notes", MAX_TASK, { optional: true });
  return tx(home, (db) => {
    const b = findBattle(db, battleId);
    if (!b) throw new Error("That battle is gone.");
    db.prepare("UPDATE battles SET feedback = ? WHERE id = ?").run(t, b.id);
    return battleRow(db, findBattle(db, b.id));
  });
}

// ---- Work rounds ----

function roundRow(r) {
  return r ? { ...r, battle_ids: JSON.parse(r.battle_ids), results: JSON.parse(r.results) } : null;
}

// The work in progress, or null.
function workDraft(home) {
  return withDb(home, (db) => roundRow(db.prepare("SELECT * FROM work_rounds WHERE status = 'draft'").get()));
}

// Start working on these battles (ids, in this order). Replaces any draft.
function startWork(home, battleIds) {
  const ids = [...new Set((Array.isArray(battleIds) ? battleIds : []).map(String))];
  if (!ids.length) throw new Error("Pick at least one battle to work on.");
  return tx(home, (db) => {
    for (const id of ids) if (!findBattle(db, id)) throw new Error("A battle you picked is gone.");
    db.prepare("DELETE FROM work_rounds WHERE status = 'draft'").run();
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO work_rounds (id, status, battle_ids, created_at) VALUES (?, 'draft', ?, ?)").run(id, JSON.stringify(ids), Date.now());
    return roundRow(db.prepare("SELECT * FROM work_rounds WHERE id = ?").get(id));
  });
}

function endWork(home) {
  return tx(home, (db) => db.prepare("DELETE FROM work_rounds WHERE status = 'draft'").run().changes > 0);
}

// Freeze the draft's results (each battle's winner or no winner, the notes and
// the entry reviews) and number the round, so agents can read it.
function sendWork(home) {
  return tx(home, (db) => {
    const d = db.prepare("SELECT * FROM work_rounds WHERE status = 'draft'").get();
    if (!d) throw new Error("There is no work to send.");
    const results = [];
    for (const id of JSON.parse(d.battle_ids)) {
      const b = findBattle(db, id);
      if (!b) continue;
      const w = b.winner_id ? db.prepare("SELECT num, title, agent FROM entries WHERE id = ?").get(b.winner_id) : null;
      // A battle you did not decide or write notes on has nothing to send.
      if (!w && !b.no_winner && !b.feedback) continue;
      const reviews = db.prepare("SELECT num, title, agent, review, review_note FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL AND review != '' ORDER BY num").all(b.id)
        .map((e) => ({ num: e.num, title: e.title, agent: e.agent, review: e.review, note: e.review_note }));
      results.push({
        battle_id: b.id, num: b.num, title: b.title, kind: b.kind, status: b.status,
        result: w ? "winner" : b.no_winner ? "no_winner" : "undecided",
        winner: w ? { num: w.num, title: w.title, agent: w.agent } : null,
        reason: b.no_winner ? b.no_winner_reason : "",
        notes: b.feedback, reviews,
      });
    }
    if (!results.length) throw new Error("Pick a winner, mark No winner or add notes on at least one battle first.");
    const num = db.prepare("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM work_rounds").get().n;
    db.prepare("UPDATE work_rounds SET status = 'sent', num = ?, results = ?, sent_at = ? WHERE id = ?").run(num, JSON.stringify(results), Date.now(), d.id);
    return roundRow(db.prepare("SELECT * FROM work_rounds WHERE id = ?").get(d.id));
  });
}

// A sent round by number, or the newest one.
function workRound(home, num) {
  return withDb(home, (db) => roundRow(num
    ? db.prepare("SELECT * FROM work_rounds WHERE status = 'sent' AND num = ?").get(Number(num))
    : db.prepare("SELECT * FROM work_rounds WHERE status = 'sent' ORDER BY num DESC LIMIT 1").get()));
}

// ---- Entries ----

// Live entries of a battle: not removed and not replaced by a newer one.
function entries(home, battleId, opts) {
  return withDb(home, (db) =>
    db.prepare("SELECT * FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL ORDER BY num").all(String(battleId)).map((r) => entryRow(r, opts)),
  );
}

// The newest live entries in every battle, for the app's activity feed,
// with how many came in over the last day and in all.
function activity(home, limit = 30) {
  return withDb(home, (db) => {
    const live = "FROM entries e JOIN battles b ON b.id = e.battle_id WHERE e.removed = 0 AND e.replaced_by IS NULL";
    const recent = db.prepare("SELECT e.id, e.num, e.title, e.agent, e.client, e.format, e.created_at, e.battle_id, b.num AS battle_num, b.title AS battle_title " + live + " ORDER BY e.created_at DESC LIMIT ?").all(Number(limit) || 30);
    const today = db.prepare("SELECT COUNT(*) AS n " + live + " AND e.created_at >= ?").get(Date.now() - 86400000).n;
    const total = db.prepare("SELECT COUNT(*) AS n " + live).get().n;
    return { recent, today, total };
  });
}

// ---- Settings ----

const SETTINGS = { theme: ["system", "light", "dark"] };

function getSetting(home, key) {
  if (!SETTINGS[key]) throw new Error("Unknown setting " + key + ".");
  const r = withDb(home, (db) => db.prepare("SELECT value FROM settings WHERE key = ?").get(key));
  return r && SETTINGS[key].includes(r.value) ? r.value : SETTINGS[key][0];
}

function setSetting(home, key, value) {
  if (!SETTINGS[key]) throw new Error("Unknown setting " + key + ".");
  if (!SETTINGS[key].includes(value)) throw new Error(key + " must be one of " + SETTINGS[key].join(", ") + ".");
  withDb(home, (db) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value));
  return value;
}

function getEntry(home, id) {
  return withDb(home, (db) => entryRow(db.prepare("SELECT * FROM entries WHERE id = ?").get(String(id))));
}

function findEntry(db, battle, num) {
  return db.prepare("SELECT * FROM entries WHERE battle_id = ? AND num = ? AND removed = 0 AND replaced_by IS NULL").get(battle.id, Number(num));
}

function removeEntry(home, id) {
  return tx(home, (db) => {
    const e = db.prepare("SELECT * FROM entries WHERE id = ?").get(String(id));
    if (!e) return false;
    db.prepare("UPDATE entries SET removed = 1 WHERE id = ?").run(e.id);
    db.prepare("UPDATE battles SET winner_id = NULL WHERE id = ? AND winner_id = ?").run(e.battle_id, e.id);
    return true;
  });
}

// Every live entry in every battle except skipId, with where it is from.
function everyEntry(db, skipId) {
  return db
    .prepare("SELECT e.id, e.num, e.agent, e.title, e.html, e.css, e.js, e.extra, e.format, e.files, b.num AS battle_num, b.title AS battle_title FROM entries e JOIN battles b ON b.id = e.battle_id WHERE e.removed = 0 AND e.replaced_by IS NULL AND e.id IS NOT ?")
    .all(skipId || null)
    .map((r) => Object.assign(r, { media: mediaOf(r) }));
}

// The sha of a video entry's video file, so the same video sent twice is caught.
// The one file that makes two entries the same work: a video's file, or a
// model's .glb.
function mediaOf(r) {
  if (r.format !== "video" && r.format !== "model") return "";
  const list = Array.isArray(r.files) ? r.files : JSON.parse(r.files || "[]");
  const f = r.format === "model" ? list.find((x) => files.MODEL_EXT.some((ext) => x.path.toLowerCase().endsWith(ext))) : list[0];
  return f ? f.sha : "";
}

function describe(matches, all) {
  return matches.map((m) => {
    const o = all.find((x) => x.id === m.id);
    return Object.assign({}, m, { battle: o.battle_num, battleTitle: o.battle_title, entry: o.num, agent: o.agent, title: o.title });
  });
}

const given = (v) => v !== undefined && v !== null && v !== "";

// The entry's work in one of three forms:
//   html:  html, css, js (one page)
//   site:  folder (a path on this computer) or files (path to text or data: URL)
//   video: video (a path to an MP4 or WebM file) and source (how it was made, as code)
// Files are stored before the battle is checked; a refused entry leaves them
// unused in blobs, where an identical later file reuses them.
// An icon entry: one SVG, as markup or a path to an .svg file. It is shown
// by JDebate itself (in <img>, so nothing in it runs), so it must stand alone:
// a square viewBox, no scripts, no event handlers, nothing from outside.
const MAX_SVG = 300000;
function iconSvg(v) {
  let t = text(v, "svg", 1000000, { raw: true }).trim();
  if (!t.startsWith("<") && /\.svg$/i.test(t)) {
    if (!fs.existsSync(t)) throw new Error("There is no file " + t + ". Pass the SVG markup or the full path to an .svg file.");
    t = fs.readFileSync(t, "utf8").trim();
  }
  t = t.replace(/^\uFEFF/, "").replace(/^<\?xml[^>]*\?>\s*/i, "").replace(/^<!--[\s\S]*?-->\s*/g, "").replace(/^<!DOCTYPE[^>]*>\s*/i, "");
  if (t.length > MAX_SVG) throw new Error("The SVG is longer than " + MAX_SVG + " characters. Simplify the paths.");
  if (!/^<svg[\s>]/i.test(t) || !/<\/svg>\s*$/i.test(t)) throw new Error("svg must be one SVG document: it starts with <svg and ends with </svg>. Send only the icon, no HTML page around it.");
  const vb = /<svg[^>]*\sviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(t);
  if (!vb) throw new Error("The <svg> needs a viewBox, e.g. viewBox=\"0 0 512 512\".");
  if (Number(vb[3]) !== Number(vb[4])) throw new Error("App icons are square. The viewBox is " + vb[3] + " by " + vb[4] + ".");
  if (!/<svg[^>]*\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(t)) t = t.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/<script[\s>]/i.test(t)) throw new Error("An icon cannot have <script>.");
  if (/<foreignObject[\s>]/i.test(t)) throw new Error("An icon cannot have <foreignObject>. Draw it with SVG shapes.");
  if (/\son[a-z]+\s*=/i.test(t)) throw new Error("An icon cannot have event handlers (onload, onclick and so on).");
  // Texture makes icons look off and muddy when small.
  if (/<feTurbulence[\s/>]/i.test(t)) throw new Error("Keep the icon simple: no noise or grain (feTurbulence). Use a few flat shapes and at most one soft gradient.");
  if (/<pattern[\s>]/i.test(t)) throw new Error("Keep the icon simple: no pattern fills (halftone, stripes, grids, textures). Use a few flat shapes and at most one soft gradient.");
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/i.test(t) || /url\(\s*["']?\s*(?!#|data:image\/)/i.test(t) || /@import/i.test(t)) throw new Error("An icon cannot load anything from outside. Links may only point inside the SVG (#id) or be data:image URLs.");
  return t;
}

function work(home, input, kind) {
  if (kind === "icon") {
    if (!given(input.svg)) throw new Error("This is an app icon battle. Send svg: the icon as SVG markup (or the full path to an .svg file), with a square viewBox. JDebate shows it at every size itself, so do not build a page around it.");
    if (given(input.html) || given(input.folder) || given(input.files) || given(input.video) || given(input.css) || given(input.js)) throw new Error("An app icon battle takes only svg. JDebate makes the preview page itself.");
    return { format: "icon", html: iconSvg(input.svg), css: "", js: "", extra: "", files: [] };
  }
  if (given(input.svg)) throw new Error("svg is only for app icon battles. This battle is a " + kind + " battle.");
  if (kind === "model") {
    if (!given(input.folder)) throw new Error("This is a 3D model battle. Send folder: the full path to a folder with your .glb, PNG renders, and .fbx/.obj, .blend and README.md. blender_export and blender_render write them for you.");
    if (given(input.html) || given(input.files) || given(input.video) || given(input.css) || given(input.js)) throw new Error("A 3D model battle takes only folder.");
    const m = files.storeModel(dataHome(home), text(input.folder, "folder", 1000));
    if (m.html.length > MAX_CODE) throw new Error("README.md is longer than " + MAX_CODE + " characters.");
    return { format: "model", html: m.html, css: "", js: "", extra: m.extra, files: m.files };
  }
  const site = given(input.folder) || given(input.files);
  const ways = [given(input.html) && "html", site && "folder or files", given(input.video) && "video"].filter(Boolean);
  if (given(input.folder) && given(input.files)) throw new Error("Send folder or files, not both.");
  if (ways.length > 1) throw new Error("Send one of html, folder or files, or video. This entry has " + ways.join(" and ") + ".");
  if (!ways.length) throw new Error("The entry is empty. Send html (one page), folder or files (a site with pages and images), or video (a video file).");
  if ((site || given(input.video)) && (given(input.css) || given(input.js))) throw new Error("css and js go with html. For a folder, files or video, put styles and scripts in the files.");
  const dir = dataHome(home);
  if (given(input.video)) {
    const source = text(input.source, "source", MAX_CODE, { raw: true });
    return { format: "video", html: "", css: "", js: "", extra: source, files: [files.storeVideo(dir, input.video)] };
  }
  if (site) {
    const s = files.storeSite(dir, { folder: given(input.folder) ? text(input.folder, "folder", 1000) : null, files: input.files });
    if (s.html.length > MAX_CODE) throw new Error("index.html is longer than " + MAX_CODE + " characters.");
    if (s.extra.length > MAX_CODE * 4) throw new Error("The site's text files are longer than " + MAX_CODE * 4 + " characters together.");
    return { format: "site", html: s.html, css: "", js: "", extra: s.extra, files: s.files };
  }
  const html = text(input.html, "html", MAX_CODE, { raw: true });
  const css = text(input.css, "css", MAX_CODE, { raw: true, optional: true });
  const js = text(input.js, "js", MAX_CODE, { raw: true, optional: true });
  return { format: "html", html, css, js, extra: "", files: [] };
}

// The copy check compares with every entry and can take seconds, so it runs
// on a plain read before the write lock. Inside the lock only entries that
// came in since are compared, so other agents are not kept waiting.
function precheck(home, c, skipId) {
  return withDb(home, (db) => {
    const all = everyEntry(db, skipId);
    return { skip: skipId || null, ids: new Set(all.map((x) => x.id)), matches: similarity.compare(c, all) };
  });
}

function finishCheck(db, c, skipId, early) {
  const all = everyEntry(db, skipId);
  if (!early || early.skip !== (skipId || null)) return describe(similarity.compare(c, all), all);
  const live = new Set(all.map((x) => x.id));
  const fresh = all.filter((x) => !early.ids.has(x.id));
  const m = early.matches.filter((x) => live.has(x.id)).concat(similarity.compare(c, fresh)).sort((a, b) => b.score - a.score);
  return describe(m, all);
}

// Step 1 for an agent: check an entry before it goes in. Too close to an
// entry already in JDebate: refused, no draft. Otherwise a draft is kept
// for DRAFT_MINUTES and the agent must call submit with it.
// input: { battle (number), agent, client, title, html, css, js | folder | files | video, source, notes, replaces (entry number), key }
function prepare(home, input) {
  const pre = withDb(home, (db) => findBattle(db, input.battle, { byNum: true }));
  const c = work(home, input, pre && pre.kind);
  const title = text(input.title, "title", 200);
  const notes = text(input.notes, "notes", 4000, { optional: true });
  const agent = text(input.agent || input.client || "an agent", "agent", 120);
  const client = String(input.client || "").slice(0, 120);
  c.media = mediaOf(c);
  const skip = given(input.replaces) && pre
    ? withDb(home, (db) => {
        const o = findEntry(db, pre, input.replaces);
        return o && input.key && hashKey(input.key) === o.key_hash ? o.id : null;
      })
    : null;
  const early = pre ? precheck(home, c, skip) : null;
  return tx(home, (db) => {
    const b = findBattle(db, input.battle, { byNum: true });
    if (!b) throw new Error("There is no battle " + input.battle + ". Call battles to see the open ones.");
    if (b.status !== "open") throw new Error("Battle " + b.num + " is closed. It takes no more entries.");
    if (c.format === "video" && b.kind !== "video") throw new Error("Battle " + b.num + " is a " + b.kind + " battle. Video files go in video battles; send html, folder or files.");
    if ((c.format === "model") !== (b.kind === "model")) throw new Error("Battle " + b.num + " changed kind. Call battle_read and send again.");
    if ((c.format === "icon") !== (b.kind === "icon")) throw new Error("Battle " + b.num + " changed kind. Call battle_read and send again.");
    c.media = mediaOf(c);
    let replaces = null;
    if (input.replaces !== undefined && input.replaces !== null) {
      const old = findEntry(db, b, input.replaces);
      if (!old || !input.key || hashKey(input.key) !== old.key_hash) throw new Error("Entry " + input.replaces + " in battle " + b.num + " is not yours to replace. Pass the key you got when you submitted it.");
      replaces = old.id;
    }
    const matches = finishCheck(db, c, replaces, early);
    const blocked = matches.some((m) => m.level === "block");
    if (blocked) return { battle: battleRow(db, b), matches, blocked: true, draft: null };
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO drafts (id, battle_id, agent, client, title, html, css, js, notes, replaces, matches, created_at, format, extra, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, b.id, agent, client, title, c.html, c.css, c.js, notes, replaces, JSON.stringify(matches), Date.now(), c.format, c.extra, JSON.stringify(c.files),
    );
    return { battle: battleRow(db, b), matches, blocked: false, draft: id };
  });
}

// Step 2: the agent says how it made the entry and sends the draft in. The
// checks run again, since another entry may have come in since step 1.
function submit(home, { draft, howMade, client } = {}) {
  howMade = text(howMade, "how_made", 4000);
  if (howMade.length < 20) throw new Error("how_made is too short. Say in a sentence or two how you made this entry.");
  const d0 = withDb(home, (db) => db.prepare("SELECT * FROM drafts WHERE id = ?").get(String(draft || "")));
  let early = null;
  if (d0 && !d0.used_at) {
    d0.media = mediaOf(d0);
    early = precheck(home, d0, d0.replaces);
  }
  return tx(home, (db) => {
    const d = db.prepare("SELECT * FROM drafts WHERE id = ?").get(String(draft || ""));
    if (!d) throw new Error("No draft " + draft + ". Call prepare_submission first.");
    if (d.used_at) throw new Error("That draft was already submitted.");
    if (client !== undefined && d.client !== String(client || "").slice(0, 120)) throw new Error("That draft was made in another session. Call prepare_submission again.");
    if (Date.now() - d.created_at > DRAFT_MINUTES * 60000) throw new Error("That draft is more than " + DRAFT_MINUTES + " minutes old. Call prepare_submission again.");
    const b = findBattle(db, d.battle_id);
    if (!b) throw new Error("That battle is gone.");
    if (b.status !== "open") throw new Error("Battle " + b.num + " closed before the entry came in.");
    if (d.replaces && !db.prepare("SELECT id FROM entries WHERE id = ? AND removed = 0 AND replaced_by IS NULL").get(d.replaces)) throw new Error("The entry this replaces is gone. Call prepare_submission again.");
    d.media = mediaOf(d);
    const matches = finishCheck(db, d, d.replaces, early);
    if (matches.some((m) => m.level === "block")) {
      db.prepare("UPDATE drafts SET used_at = ? WHERE id = ?").run(Date.now(), d.id);
      return { blocked: true, matches, entry: null, key: null, battle: battleRow(db, b) };
    }
    const num = db.prepare("SELECT COALESCE(MAX(num), 0) + 1 AS n FROM entries WHERE battle_id = ?").get(b.id).n;
    const id = crypto.randomUUID();
    const key = crypto.randomBytes(12).toString("hex");
    db.prepare(
      "INSERT INTO entries (id, battle_id, num, agent, client, title, html, css, js, notes, how_made, matches, key_hash, created_at, format, extra, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, b.id, num, d.agent, d.client, d.title, d.html, d.css, d.js, d.notes, howMade, JSON.stringify(matches), hashKey(key), Date.now(), d.format, d.extra, d.files);
    if (d.replaces) {
      db.prepare("UPDATE entries SET replaced_by = ? WHERE id = ?").run(id, d.replaces);
      db.prepare("UPDATE battles SET winner_id = ? WHERE id = ? AND winner_id = ?").run(id, b.id, d.replaces);
    }
    db.prepare("UPDATE drafts SET used_at = ? WHERE id = ?").run(Date.now(), d.id);
    return { blocked: false, matches, entry: entryRow(db.prepare("SELECT * FROM entries WHERE id = ?").get(id), { noCode: true }), key, battle: battleRow(db, b) };
  });
}

// Entries of a battle by number, for agents. Code only once it is closed.
function results(home, battleNum) {
  return withDb(home, (db) => {
    const b = findBattle(db, battleNum, { byNum: true });
    if (!b) return null;
    const list = db.prepare("SELECT * FROM entries WHERE battle_id = ? AND removed = 0 AND replaced_by IS NULL ORDER BY num").all(b.id).map((r) => entryRow(r, { noCode: b.status === "open" }));
    return { battle: battleRow(db, b), entries: list };
  });
}

// The stored file behind one path of an entry: { file, type, size } or null.
function entryFile(home, entry, p) {
  let want;
  try {
    want = files.cleanPath(p).toLowerCase();
  } catch {
    return null;
  }
  const f = (entry.files || []).find((x) => x.path.toLowerCase() === want);
  return f ? { file: files.blobPath(dataHome(home), f.sha), type: f.type, size: f.size, path: f.path } : null;
}

// ---- 3D model battles: the current version and reviews ----

// Where agents read a model battle's current version: ~/.jdebate/old/battle-<num>.
const oldDir = (home, num) => path.join(dataHome(home), "old", "battle-" + num);

function writeOldDir(home, b) {
  const dir = oldDir(home, b.num);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of b.old_files) {
    const to = path.join(dir, ...f.path.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(files.blobPath(dataHome(home), f.sha), to);
  }
  if (b.old_notes) fs.writeFileSync(path.join(dir, "CURRENT-VERSION.md"), b.old_notes);
  return dir;
}

// Sets what a model battle redesigns: screenshots or renders of the current
// version (and its .glb or part list if there is one) from a folder, plus notes.
// input: { folder, notes }. folder may be left out to change only the notes.
function setOld(home, battleId, input = {}) {
  const notes = Object.hasOwn(input, "notes") ? text(input.notes, "notes", MAX_TASK, { optional: true }) : null;
  const stored = given(input.folder) ? files.storeModel(dataHome(home), text(input.folder, "folder", 1000), { loose: true }).files : null;
  const b = tx(home, (db) => {
    const r = findBattle(db, battleId);
    if (!r) throw new Error("That battle is gone.");
    if (stored) db.prepare("UPDATE battles SET old_files = ? WHERE id = ?").run(JSON.stringify(stored), r.id);
    if (notes !== null) db.prepare("UPDATE battles SET old_notes = ? WHERE id = ?").run(notes, r.id);
    return battleRow(db, findBattle(db, r.id));
  });
  writeOldDir(home, b);
  return b;
}

// The current-version folder for agents, written again if it went missing.
function oldFolder(home, b) {
  if (!b.old_files.length && !b.old_notes) return null;
  const dir = oldDir(home, b.num);
  if (!fs.existsSync(dir)) writeOldDir(home, b);
  return dir;
}

function oldFile(home, b, p) {
  let want;
  try {
    want = files.cleanPath(p).toLowerCase();
  } catch {
    return null;
  }
  const f = (b.old_files || []).find((x) => x.path.toLowerCase() === want);
  return f ? { file: files.blobPath(dataHome(home), f.sha), type: f.type, size: f.size, path: f.path } : null;
}

// The user approves or denies an entry, with a note the agent reads back.
function review(home, entryId, status, note) {
  const st = status === null || status === undefined ? "" : String(status);
  if (!REVIEWS.includes(st)) throw new Error("review must be approved, denied or empty.");
  const n = text(note, "note", 4000, { optional: true });
  return tx(home, (db) => {
    const e = db.prepare("SELECT * FROM entries WHERE id = ? AND removed = 0").get(String(entryId));
    if (!e) throw new Error("That entry is gone.");
    db.prepare("UPDATE entries SET review = ?, review_note = ?, reviewed_at = ? WHERE id = ?").run(st, n, st ? Date.now() : null, e.id);
    return entryRow(db.prepare("SELECT * FROM entries WHERE id = ?").get(e.id), { noCode: true });
  });
}

const blobFile = (home, sha) => files.blobPath(dataHome(home), sha);
const putBlob = (home, buf) => files.putBlob(dataHome(home), buf);

module.exports = {
  KINDS, REVIEWS, VIDEO_SIZES, keepOpen, closeAll, entryFile, setOld, oldFolder, oldFile, review, blobFile, putBlob,
  dataHome, stamp, openBattle, listBattles, getBattle, closeBattle, reopenBattle, editBattle, removeBattle, setWinner, setNoWinner, setFeedback,
  workDraft, startWork, endWork, sendWork, workRound,
  entries, activity, getSetting, setSetting, getEntry, removeEntry, prepare, submit, results, MAX_CODE, DRAFT_MINUTES,
};
