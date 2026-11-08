"use strict";

// App icon battles: agents send only an SVG, JDebate makes the preview page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../server/lib/store.js");
const { iconPage } = require("../core/preview.cjs");
const { writeEntry } = require("../core/export.cjs");
const { scratch } = require("./fixtures.cjs");

const HOW = "Drew the tile first, then the letter, then checked it at 16 px.";
const SVG = (fill, extra) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="110" fill="${fill}"/><path d="M300 100v220a90 90 0 0 1-180 0" fill="none" stroke="#111" stroke-width="70"/>${extra || ""}</svg>`;

function send(home, input, who) {
  const p = store.prepare(home, Object.assign({ agent: who || "a", client: who || "a" }, input));
  if (p.blocked) return { prepared: p };
  return { prepared: p, submitted: store.submit(home, { draft: p.draft, howMade: HOW, client: who || "a" }) };
}

test("an icon battle takes an SVG and stores it as an icon entry", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "JNotes icon redesign", task: "Make the icon.", kind: "icon" });
  assert.equal(b.kind, "icon");
  const r = send(home, { battle: b.num, title: "Gold J", svg: '<?xml version="1.0"?>\n' + SVG("#f5b82e") });
  const e = store.getEntry(home, r.submitted.entry.id);
  assert.equal(e.format, "icon");
  assert.match(e.html, /^<svg/);
  assert.match(iconPage(e.html, "JNotes"), /data:image\/svg\+xml;base64,/);
  const { dir } = writeEntry(home, e.id);
  assert.equal(fs.readFileSync(path.join(dir, "icon.svg"), "utf8"), e.html);
});

test("an icon can be sent as a path to an .svg file", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Icon", task: "Make the icon.", kind: "icon" });
  const f = path.join(home, "my.svg");
  fs.writeFileSync(f, SVG("#2e7cf5"));
  const r = send(home, { battle: b.num, title: "From file", svg: f });
  assert.equal(store.getEntry(home, r.submitted.entry.id).format, "icon");
});

test("icon battles refuse pages, unsafe SVG and non-square icons", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Icon", task: "Make the icon.", kind: "icon" });
  const bad = (input, re) => assert.throws(() => store.prepare(home, Object.assign({ battle: b.num, title: "x", agent: "a" }, input)), re);
  bad({ html: "<h1>hi</h1>" }, /svg/);
  bad({ svg: SVG("#fff"), html: "<p>" }, /only svg/);
  bad({ svg: "<html><body>" + SVG("#fff") + "</body></html>" }, /starts with <svg/);
  bad({ svg: SVG("#fff", "<script>alert(1)</script>") }, /script/);
  bad({ svg: SVG("#fff", '<rect onload="x()"/>') }, /event handlers/);
  bad({ svg: SVG("#fff", '<image href="https://example.com/a.png"/>') }, /outside/);
  bad({ svg: SVG("#fff", "<foreignObject><div/></foreignObject>") }, /foreignObject/);
  bad({ svg: SVG("#fff").replace("0 0 512 512", "0 0 512 300") }, /square/);
  bad({ svg: SVG("#fff").replace(' viewBox="0 0 512 512"', "") }, /viewBox/);
  // svg is only for icon battles.
  const page = store.openBattle(home, { title: "Page", task: "A page." });
  assert.throws(() => store.prepare(home, { battle: page.num, title: "x", agent: "a", svg: SVG("#fff") }), /only for app icon/);
});

test("the copy check catches the same icon sent twice", () => {
  const home = scratch();
  const b = store.openBattle(home, { title: "Icon", task: "Make the icon.", kind: "icon" });
  send(home, { battle: b.num, title: "One", svg: SVG("#f5b82e") }, "a");
  const r = send(home, { battle: b.num, title: "Two", svg: SVG("#f5b82e") }, "b");
  assert.equal(r.prepared.blocked, true);
});
