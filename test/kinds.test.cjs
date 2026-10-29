"use strict";

// Website and video battles: kinds, sites sent as folders or inline files,
// and video files.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("../server/lib/store.js");
const { methods } = require("../server/server.cjs");
const { writeEntry } = require("../core/export.cjs");
const { scratch, CLOCK, FLIP } = require("./fixtures.cjs");

const HOW = "Wrote the pages first, then the styles and the menu script.";

function send(home, input, who) {
  const p = store.prepare(home, Object.assign({ agent: who || "a", client: who || "a" }, input));
  if (p.blocked) return { prepared: p };
  return { prepared: p, submitted: store.submit(home, { draft: p.draft, howMade: HOW, client: who || "a" }) };
}

// A small site in a folder: two pages, a stylesheet, a script and a PNG.
function siteFolder(root, entry) {
  fs.mkdirSync(path.join(root, "img"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), entry.html.replace("</body>", '<a href="about.html">About</a><img src="img/logo.png" alt=""></body>'));
  fs.writeFileSync(path.join(root, "about.html"), "<!doctype html><title>About</title><link rel=stylesheet href=site.css><h1>About us</h1>");
  fs.writeFileSync(path.join(root, "site.css"), entry.css);
  fs.writeFileSync(path.join(root, "app.js"), entry.js);
  fs.writeFileSync(path.join(root, "img", "logo.png"), crypto.randomBytes(300));
  fs.writeFileSync(path.join(root, "node_modules", "junk", "x.js"), "skipped");
  return root;
}

function fakeVideo(dir, name, seed) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.concat([Buffer.from("....ftypisom"), crypto.createHash("sha256").update(seed).digest(), Buffer.alloc(4096, seed)]));
  return f;
}

const call = (name, args) => methods["tools/call"]({ name, arguments: args });

test("battles have a kind, a site to redesign, and a video length and shape", () => {
  const home = scratch();
  const page = store.openBattle(home, { title: "Clock", task: "Build a clock" });
  assert.equal(page.kind, "page");
  const web = store.openBattle(home, { title: "Redesign", task: "Redesign it", kind: "website", site: "example.com" });
  assert.equal(web.kind, "website");
  assert.equal(web.site_url, "https://example.com/");
  const vid = store.openBattle(home, { title: "Demo", task: "Make a demo", kind: "video", videoSeconds: "15", videoSize: "1080x1920" });
  assert.equal(vid.video_seconds, 15);
  assert.equal(vid.video_size, "1080x1920");
  assert.throws(() => store.openBattle(home, { title: "x", task: "x", kind: "game" }), /kind must be one of/);
  assert.throws(() => store.openBattle(home, { title: "x", task: "x", kind: "website", site: "ftp://x" }), /https:\/\/ or http/);
  assert.throws(() => store.openBattle(home, { title: "x", task: "x", kind: "video", videoSeconds: 1 }), /from 3 to 600/);
  assert.throws(() => store.openBattle(home, { title: "x", task: "x", kind: "video", videoSize: "640x480" }), /size must be one of/);
  // A new site clears the old screenshot; a late screenshot of the old site is dropped.
  store.setBefore(home, web.id, { url: web.site_url, sha: "a".repeat(64) });
  assert.equal(store.getBattle(home, web.id).before_sha, "a".repeat(64));
  const moved = store.editBattle(home, web.id, { site: "https://example.org" });
  assert.equal(moved.before_sha, "");
  assert.equal(store.setBefore(home, web.id, { url: web.site_url, sha: "b".repeat(64) }), null);
  assert.equal(store.getBattle(home, web.id).before_sha, "");
});

test("an old database gets the new columns and keeps its battles", () => {
  const home = scratch();
  const dir = path.join(home, ".jdebate");
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "jdebate.db"));
  db.exec("CREATE TABLE battles (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL, winner_id TEXT, created_at INTEGER NOT NULL, closed_at INTEGER);");
  db.exec("INSERT INTO battles VALUES ('old', 1, 'Old', 'Old task', 'open', NULL, 1, NULL)");
  db.close();
  const b = store.listBattles(home)[0];
  assert.equal(b.title, "Old");
  assert.equal(b.kind, "page");
  assert.equal(b.video_seconds, 30);
  assert.equal(send(home, Object.assign({ battle: 1 }, CLOCK)).submitted.entry.format, "html");
});

test("a website comes in as a folder, with every page and image", () => {
  const home = scratch();
  store.openBattle(home, { title: "Site", task: "Redesign", kind: "website", site: "https://example.com" });
  const root = siteFolder(path.join(home, "site-a"), CLOCK);
  const r = send(home, { battle: 1, title: "New site", folder: root });
  assert.equal(r.prepared.blocked, false);
  const e = store.getEntry(home, r.submitted.entry.id);
  assert.equal(e.format, "site");
  assert.deepEqual(e.files.map((f) => f.path), ["index.html", "about.html", "app.js", "img/logo.png", "site.css"]);
  assert.match(e.html, /about\.html/);
  assert.match(e.extra, /About us/);
  const logo = store.entryFile(home, e, "img/logo.png");
  assert.equal(logo.type, "image/png");
  assert.equal(fs.readFileSync(logo.file).length, 300);
  assert.equal(store.entryFile(home, e, "../jdebate.db"), null);
  // The folder comes out again as a site that runs on its own.
  const out = writeEntry(home, e.id);
  assert.ok(fs.existsSync(path.join(out.dir, "img", "logo.png")));
  assert.match(fs.readFileSync(path.join(out.dir, "about.html"), "utf8"), /About us/);
  assert.ok(fs.existsSync(path.join(out.dir, "about.txt")));
});

test("a copied site is caught through its other files too", () => {
  const home = scratch();
  store.openBattle(home, { title: "Site", task: "Redesign", kind: "website" });
  send(home, { battle: 1, title: "A", folder: siteFolder(path.join(home, "a"), CLOCK) }, "a");
  // Same site, new index page: the stylesheet and script give it away.
  const copy = { "index.html": FLIP.html, "site.css": CLOCK.css, "app.js": CLOCK.js };
  const r = send(home, { battle: 1, title: "B", files: copy }, "b");
  assert.equal(r.prepared.blocked, true);
  const own = send(home, { battle: 1, title: "C", files: { "index.html": FLIP.html, "style.css": FLIP.css, "main.js": FLIP.js, "dot.png": "data:image/png;base64," + crypto.randomBytes(40).toString("base64") } }, "c");
  assert.equal(own.prepared.blocked, false, JSON.stringify(own.prepared.matches));
  const e = store.getEntry(home, own.submitted.entry.id);
  assert.equal(fs.readFileSync(store.entryFile(home, e, "dot.png").file).length, 40);
});

test("sites need an index.html and plain paths, and one way of sending", () => {
  const home = scratch();
  store.openBattle(home, { title: "Site", task: "Redesign", kind: "website" });
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a", files: { "home.html": "<p>hi</p>" } }), /needs an index\.html/);
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a", files: { "index.html": "x", "../up.html": "x" } }), /plain relative path/);
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a", html: "<p>x</p>", files: { "index.html": "x" } }), /Send one of html/);
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a", folder: path.join(home, "nope") }), /does not exist/);
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a" }), /entry is empty/);
});

test("a video battle takes a video file with its source, and the same file twice is refused", () => {
  const home = scratch();
  store.openBattle(home, { title: "Page", task: "x" });
  store.openBattle(home, { title: "Demo", task: "Make a demo", kind: "video", videoSeconds: 10 });
  const clip = fakeVideo(home, "demo.mp4", "one");
  assert.throws(() => store.prepare(home, { battle: 1, title: "x", agent: "a", video: clip, source: CLOCK.js }), /Video files go in video battles/);
  assert.throws(() => store.prepare(home, { battle: 2, title: "x", agent: "a", video: clip }), /source must not be empty/);
  assert.throws(() => store.prepare(home, { battle: 2, title: "x", agent: "a", video: path.join(home, "demo.gif"), source: "x" }), /MP4 or WebM/);
  const r = send(home, { battle: 2, title: "Demo A", video: clip, source: CLOCK.js }, "a");
  const e = store.getEntry(home, r.submitted.entry.id);
  assert.equal(e.format, "video");
  assert.equal(e.files[0].path, "video.mp4");
  assert.equal(e.files[0].type, "video/mp4");
  // The same video with a different story about how it was made.
  const again = send(home, { battle: 2, title: "Demo B", video: fakeVideo(home, "renamed.mp4", "one"), source: FLIP.js }, "b");
  assert.equal(again.prepared.blocked, true);
  assert.equal(again.prepared.matches[0].exact, true);
  // An animation page is fine in a video battle too.
  assert.equal(send(home, Object.assign({ battle: 2 }, FLIP), "c").prepared.blocked, false);
  const out = writeEntry(home, e.id);
  assert.equal(out.video, path.join(out.dir, "video.mp4"));
  assert.ok(fs.existsSync(path.join(out.dir, "source.txt")));
});

test("agents read what to send for each kind, and get a site's files after it closes", async () => {
  const home = scratch();
  process.env.JDEBATE_HOME = path.join(home, ".jdebate");
  try {
    const web = store.openBattle(undefined, { title: "Site", task: "Redesign the bakery site", kind: "website", site: "https://example.com" });
    store.openBattle(undefined, { title: "Demo", task: "Make a demo", kind: "video", videoSeconds: 20, videoSize: "1080x1080" });
    const list = (await call("battles", {})).content[0].text;
    assert.match(list, /Battle 1: Site \(website, open, 0 entries\)/);
    assert.match(list, /Battle 2: Demo \(video, open/);
    const read1 = (await call("battle_read", { battle: 1 })).content[0].text;
    assert.match(read1, /website redesign of https:\/\/example\.com\//);
    assert.match(read1, /folder set to the folder's full path/);
    const read2 = (await call("battle_read", { battle: 2 })).content[0].text;
    assert.match(read2, /20 seconds at 1080x1080 \(square\)/);
    assert.match(read2, /\.mp4 \(H\.264\)/);
    const prep = await call("prepare_submission", { battle: 1, title: "New", agent: "a", folder: siteFolder(path.join(home, "s"), CLOCK) });
    assert.equal(prep.isError, false, prep.content[0].text);
    const draft = /draft "([^"]+)"/.exec(prep.content[0].text)[1];
    assert.equal((await call("submit", { draft, originality: "all my own work", how_made: HOW })).isError, false);
    assert.doesNotMatch((await call("battle_results", { battle: 1 })).content[0].text, /About us/);
    store.closeBattle(undefined, web.id);
    const res = (await call("battle_results", { battle: 1 })).content[0].text;
    assert.match(res, /Files: index\.html, about\.html, app\.js, img\/logo\.png, site\.css/);
    assert.match(res, /About us/);
  } finally {
    delete process.env.JDEBATE_HOME;
  }
});

test("served pages get the link guard after the doctype or head, and each entry its own CSP origin", () => {
  const { guard, cspFor } = require("../core/preview.cjs");
  const doc = guard("<!doctype html><html><head><title>x</title></head><body><a href=\"https://example.com\">x</a></body></html>");
  assert.match(doc, /^<!doctype html><html><head><script>addEventListener\('click'/);
  assert.match(guard("<!DOCTYPE html>\n<p>hi</p>"), /^<!DOCTYPE html><script>/);
  assert.match(guard("<p>hi</p>"), /^<script>.*<\/script><p>hi<\/p>$/);
  const csp = cspFor("abc");
  assert.match(csp, /img-src data: blob: jdebate-preview:\/\/abc;/);
  assert.match(csp, /connect-src 'none'/);
});
