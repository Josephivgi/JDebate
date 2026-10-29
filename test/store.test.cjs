"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../server/lib/store.js");
const similarity = require("../server/lib/similarity.js");
const { scratch, CLOCK, FLIP } = require("./fixtures.cjs");

function send(home, battle, entry, who, extra) {
  const p = store.prepare(home, Object.assign({ battle, agent: who, client: who }, entry, extra || {}));
  if (p.blocked) return { prepared: p };
  const s = store.submit(home, { draft: p.draft, howMade: "Wrote the markup first, then the styles and the timer.", client: who });
  return { prepared: p, submitted: s };
}

test("open a battle and send two original entries", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  assert.equal(b.num, 1);
  assert.equal(b.status, "open");
  const a = send(home, 1, CLOCK, "claude-code");
  assert.equal(a.prepared.blocked, false);
  assert.equal(a.submitted.entry.num, 1);
  assert.ok(a.submitted.key);
  const c = send(home, 1, FLIP, "codex");
  assert.equal(c.prepared.blocked, false, JSON.stringify(c.prepared.matches));
  assert.equal(c.submitted.entry.num, 2);
  const list = store.entries(home, b.id);
  assert.deepEqual(list.map((e) => e.agent), ["claude-code", "codex"]);
  assert.equal(store.getBattle(home, b.id).entries, 2);
  assert.equal(store.openBattle(home, { title: "Second", task: "x" }).num, 2);
});

test("a copy with small changes is refused, with the entry it copies", () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  send(home, 1, CLOCK, "claude-code");
  const copy = Object.assign({}, CLOCK, { title: "My clock", css: CLOCK.css.replace("#7aa2ff", "#ff7a7a").replace("40px", "44px"), js: CLOCK.js.replace(/label/g, "out") });
  const r = send(home, 1, copy, "cursor");
  assert.equal(r.prepared.blocked, true);
  assert.equal(r.prepared.draft, null);
  assert.equal(r.prepared.matches[0].entry, 1);
  assert.equal(r.prepared.matches[0].agent, "claude-code");
  assert.equal(store.entries(home, store.listBattles(home)[0].id).length, 1);
});

test("a fork that adds a lot on top is still refused", () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  send(home, 1, CLOCK, "claude-code");
  const fork = Object.assign({}, CLOCK, { js: CLOCK.js + "\n" + FLIP.js, css: CLOCK.css + "\n" + FLIP.css });
  assert.equal(send(home, 1, fork, "gemini").prepared.blocked, true);
});

test("copying from an earlier battle is caught too", () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  send(home, 1, CLOCK, "claude-code");
  store.openBattle(home, { title: "Clock again", task: "Build a clock" });
  const r = send(home, 2, CLOCK, "devin");
  assert.equal(r.prepared.blocked, true);
  assert.equal(r.prepared.matches[0].battle, 1);
  assert.equal(r.prepared.matches[0].exact, true);
});

test("an exact copy of a tiny entry is refused", () => {
  const home = scratch();
  store.openBattle(home, { title: "Hi", task: "Say hi" });
  const tiny = { title: "Hi", html: "<h1>Hello</h1>", css: "h1{color:red}", js: "" };
  assert.equal(send(home, 1, tiny, "a").prepared.blocked, false);
  assert.equal(send(home, 1, Object.assign({}, tiny, { html: "<h1>Hello</h1>\n" }), "b").prepared.blocked, true);
});

test("submit needs a fresh draft from the same session", () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  const p = store.prepare(home, Object.assign({ battle: 1, agent: "x", client: "claude-code" }, CLOCK));
  assert.throws(() => store.submit(home, { draft: p.draft, howMade: "short", client: "claude-code" }), /too short/);
  assert.throws(() => store.submit(home, { draft: p.draft, howMade: "Wrote it all by hand from the task.", client: "codex" }), /another session/);
  store.submit(home, { draft: p.draft, howMade: "Wrote it all by hand from the task.", client: "claude-code" });
  assert.throws(() => store.submit(home, { draft: p.draft, howMade: "Wrote it all by hand from the task.", client: "claude-code" }), /already submitted/);
  assert.throws(() => store.submit(home, { draft: "nope", howMade: "Wrote it all by hand from the task." }), /No draft/);
});

test("an entry that comes in between prepare and submit is checked again", () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  const p1 = store.prepare(home, Object.assign({ battle: 1, agent: "a", client: "a" }, CLOCK));
  const p2 = store.prepare(home, Object.assign({ battle: 1, agent: "b", client: "b" }, CLOCK));
  assert.equal(p2.blocked, false);
  store.submit(home, { draft: p1.draft, howMade: "Wrote it all by hand from the task.", client: "a" });
  const r = store.submit(home, { draft: p2.draft, howMade: "Wrote it all by hand from the task.", client: "b" });
  assert.equal(r.blocked, true);
  assert.equal(r.matches[0].agent, "a");
});

test("an agent can replace its own entry only with its key", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  const first = send(home, 1, CLOCK, "claude-code").submitted;
  store.setWinner(home, b.id, first.entry.id);
  const better = Object.assign({}, CLOCK, { css: CLOCK.css.replace("#7aa2ff", "#9fe870") });
  assert.throws(() => store.prepare(home, Object.assign({ battle: 1, agent: "codex", client: "codex", replaces: 1, key: "wrong" }, better)), /not yours/);
  const r = send(home, 1, better, "claude-code", { replaces: 1, key: first.key });
  assert.equal(r.prepared.blocked, false);
  const live = store.entries(home, b.id);
  assert.equal(live.length, 1);
  assert.equal(live[0].num, 2);
  assert.equal(store.getBattle(home, b.id).winner_id, live[0].id, "the winner follows the new version");
});

test("closed battles take no entries and show code in results", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  send(home, 1, CLOCK, "claude-code");
  assert.equal(store.results(home, 1).entries[0].html, undefined, "code is hidden while open");
  store.closeBattle(home, b.id);
  assert.throws(() => store.prepare(home, Object.assign({ battle: 1, agent: "x", client: "x" }, FLIP)), /closed/);
  assert.match(store.results(home, 1).entries[0].html, /ring/);
  store.reopenBattle(home, b.id);
  assert.equal(store.getBattle(home, b.id).status, "open");
});

test("removed entries leave the battle and the winner", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  const e = send(home, 1, CLOCK, "claude-code").submitted.entry;
  store.setWinner(home, b.id, e.id);
  assert.equal(store.removeEntry(home, e.id), true);
  assert.equal(store.getBattle(home, b.id).winner_id, null);
  assert.equal(store.entries(home, b.id).length, 0);
  // Removed work no longer blocks anyone.
  assert.equal(send(home, 1, CLOCK, "codex").prepared.blocked, false);
});

test("deleting a battle deletes its entries", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  send(home, 1, CLOCK, "claude-code");
  assert.equal(store.removeBattle(home, b.id), true);
  assert.equal(store.listBattles(home).length, 0);
  store.openBattle(home, { title: "New", task: "Build a clock" });
  assert.equal(send(home, 2, CLOCK, "x").prepared.blocked, false);
});

test("the stamp moves on every change", () => {
  const home = scratch();
  const s0 = store.stamp(home);
  store.openBattle(home, { title: "Clock", task: "Build a clock" });
  assert.ok(store.stamp(home) > s0);
});

test("similarity ignores comments and page boilerplate", () => {
  const a = { html: "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"></head><body><p>one</p></body></html>", css: "", js: "" };
  const b = { html: "<!-- hi --><!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"></head><body><p>two</p></body></html>", css: "", js: "" };
  assert.equal(similarity.compare(a, [Object.assign({ id: "x" }, b)]).length, 0);
  assert.equal(similarity.score(CLOCK, FLIP) < similarity.WARN_AT, true);
});

test("battles list their agents and winner, and activity shows the newest entries", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  assert.deepEqual(store.getBattle(home, b.id).agents, []);
  assert.equal(store.getBattle(home, b.id).winner, null);
  assert.deepEqual(store.activity(home), { recent: [], today: 0, total: 0 });
  send(home, 1, CLOCK, "claude-code");
  const c = send(home, 1, FLIP, "codex");
  store.setWinner(home, b.id, c.submitted.entry.id);
  const row = store.listBattles(home)[0];
  assert.deepEqual(row.agents, ["claude-code", "codex"]);
  assert.deepEqual(row.winner, { num: 2, title: "Flip digits", agent: "codex" });
  const a = store.activity(home);
  assert.equal(a.total, 2);
  assert.equal(a.today, 2);
  assert.deepEqual(a.recent.map((e) => [e.num, e.agent, e.battle_num, e.battle_title]), [[2, "codex", 1, "Clock"], [1, "claude-code", 1, "Clock"]]);
  assert.equal(a.recent[0].html, undefined, "the feed carries no code");
  store.removeEntry(home, c.submitted.entry.id);
  assert.equal(store.activity(home).total, 1);
});

test("the theme setting is stored and checked", () => {
  const home = scratch();
  assert.equal(store.getSetting(home, "theme"), "system");
  assert.equal(store.setSetting(home, "theme", "dark"), "dark");
  assert.equal(store.getSetting(home, "theme"), "dark");
  assert.throws(() => store.setSetting(home, "theme", "pink"), /theme must be one of/);
  assert.throws(() => store.getSetting(home, "colour"), /Unknown setting/);
});
