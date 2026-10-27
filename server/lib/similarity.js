"use strict";

// How much of one entry is the same code as another. Used before an entry
// goes into a battle, so a fork or a copy of someone else's work is caught
// even when an agent says it is original.
//
// The HTML, CSS and JS are joined, comments and the usual page boilerplate
// are dropped, the rest is split into tokens, and runs of SHINGLE tokens are
// compared. The score is the share of the smaller entry's runs that also
// appear in the other one, so "their page plus a few changes" still scores
// high.

const SHINGLE = 6;
// Entries with fewer runs than this are too small to judge fairly.
const MIN_RUNS = 30;
const BLOCK_AT = 0.6;
const WARN_AT = 0.35;

// Page structure every entry has. Dropped before tokens are made.
const PAGE_TAGS = /<!doctype[^>]*>|<\/?(?:html|head|body)\b[^>]*>|<meta\b[^>]*>|<title\b[^>]*>[\s\S]*?<\/title>/gi;

// Common CSS and JS lines, dropped as runs.
const BOILERPLATE = [
  "* { box-sizing: border-box; margin: 0; padding: 0; }",
  "*, *::before, *::after { box-sizing: border-box; }",
  "html, body { margin: 0; padding: 0; height: 100%; }",
  "body { margin: 0; }",
  'document.addEventListener("DOMContentLoaded", () => {',
];

function stripComments(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // A // comment, but not the // in a URL like https://.
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
}

function tokens(text) {
  return stripComments(text).replace(PAGE_TAGS, " ").toLowerCase().match(/[a-z_$][\w$-]*|\d+(?:\.\d+)?|[^\s\w]/g) || [];
}

function runs(list) {
  const out = new Set();
  for (let i = 0; i + SHINGLE <= list.length; i++) out.add(list.slice(i, i + SHINGLE).join(" "));
  return out;
}

let boiler = null;
function boilerRuns() {
  if (!boiler) {
    boiler = new Set();
    for (const line of BOILERPLATE) for (const r of runs(tokens(line))) boiler.add(r);
  }
  return boiler;
}

// The runs of one entry ({html, css, js}), boilerplate removed.
function fingerprint(entry) {
  const all = runs(tokens([entry.html, entry.css, entry.js].join("\n")));
  const b = boilerRuns();
  for (const r of b) all.delete(r);
  return all;
}

// 0..1, or null when either entry is too small to judge.
function score(a, b) {
  const fa = a instanceof Set ? a : fingerprint(a);
  const fb = b instanceof Set ? b : fingerprint(b);
  const small = Math.min(fa.size, fb.size);
  if (small < MIN_RUNS) return null;
  const [x, y] = fa.size <= fb.size ? [fa, fb] : [fb, fa];
  let same = 0;
  for (const r of x) if (y.has(r)) same++;
  return same / small;
}

const norm = (e) => [e.html, e.css, e.js].map((s) => String(s || "").replace(/\s+/g, "")).join("\u0000");

// Compare an entry with others. Returns the matches worth reporting, highest
// first: [{ id, score, level: "block"|"warn", exact }].
function compare(entry, others) {
  const mine = fingerprint(entry);
  const exactKey = norm(entry);
  const out = [];
  for (const o of others) {
    const exact = norm(o) === exactKey && exactKey.replace(/\u0000/g, "").length > 0;
    const s = exact ? 1 : score(mine, fingerprint(o));
    if (s === null || s < WARN_AT) continue;
    out.push({ id: o.id, score: Math.round(s * 100) / 100, level: s >= BLOCK_AT ? "block" : "warn", exact });
  }
  return out.sort((a, b) => b.score - a.score);
}

module.exports = { compare, score, fingerprint, tokens, SHINGLE, MIN_RUNS, BLOCK_AT, WARN_AT };
