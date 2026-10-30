"use strict";

// Everything the JDebate window calls, plus the jdebate-preview: scheme.
// Shared by the standalone app (main.cjs) and by JWorkspace, which loads
// JDebate as a plugin app (workspace.cjs). The caller passes how to register a
// handler, how to tell the window about update changes, and who owns the theme.

const path = require("node:path");
const fs = require("node:fs");
const { shell, clipboard } = require("electron");
const store = require("../server/lib/store.js");
const { isText } = require("../server/lib/files.js");
const install = require("../core/install.cjs");
const { Readable } = require("node:stream");
const { compose, videoPage, guard, cspFor, CSP } = require("../core/preview.cjs");
const { createUpdater, RELEASES_URL } = require("./updater.cjs");
const { writeEntry } = require("../core/export.cjs");
const video = require("./video.cjs");

const id = (v) => String(v || "");

// opts: { home, smoke, handle(name, fn), theme: { get(), set(v) },
//         updater: { updater, packaged, version }, onUpdate(state) }
function createBackend(opts) {
  const HOME = opts.home;
  const SMOKE = Boolean(opts.smoke);
  const handle = opts.handle;

  handle("stamp", () => store.stamp(HOME));
  handle("battles", () => store.listBattles(HOME));
  handle("activity", () => store.activity(HOME));
  // Light, dark or system. The page's prefers-color-scheme follows it.
  handle("theme", () => opts.theme.get());
  handle("theme-set", (v) => opts.theme.set(String(v)));
  handle("battle", (bid) => {
    const b = store.getBattle(HOME, id(bid));
    if (!b) return null;
    return { battle: b, entries: store.entries(HOME, b.id, { noCode: true }) };
  });
  handle("battle-open", (input) => {
    const i = input || {};
    return store.openBattle(HOME, { title: i.title, task: i.task, kind: i.kind, videoSeconds: i.videoSeconds, videoSize: i.videoSize });
  });
  handle("battle-edit", (bid, patch) => store.editBattle(HOME, id(bid), patch));
  handle("battle-close", (bid) => store.closeBattle(HOME, id(bid)));
  handle("battle-reopen", (bid) => store.reopenBattle(HOME, id(bid)));
  handle("battle-remove", (bid) => store.removeBattle(HOME, id(bid)));
  handle("winner", (bid, eid) => store.setWinner(HOME, id(bid), eid ? id(eid) : null));
  handle("entry", (eid) => store.getEntry(HOME, id(eid)));
  handle("entry-remove", (eid) => store.removeEntry(HOME, id(eid)));
  // One text file of a site entry, for its Files tab.
  handle("entry-text", (eid, file) => {
    const e = store.getEntry(HOME, id(eid));
    const f = e && store.entryFile(HOME, e, String(file || ""));
    if (!f) throw new Error("That file is not in this entry.");
    if (!isText(f.path)) return null;
    return fs.readFileSync(f.file, "utf8").slice(0, 400000);
  });
  handle("install-state", () => install.status(HOME));
  // The MCP server entry for an agent JDebate does not know, to paste into its config.
  handle("install-command", () => {
    const n = install.nodeCommand();
    const out = { command: n.command, args: [install.status(HOME).serverFile] };
    if (n.env && Object.keys(n.env).length) out.env = n.env;
    return out;
  });
  handle("install", async (ids) => Object.assign(await install.install(Array.isArray(ids) ? ids.map(String) : [], HOME), { state: install.status(HOME) }));
  handle("uninstall", (ids) => Object.assign(install.uninstall(Array.isArray(ids) ? ids.map(String) : [], HOME), { state: install.status(HOME) }));
  handle("copy", (text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });
  handle("reveal", (file) => {
    const f = String(file || "");
    if (!f) return false;
    if (fs.existsSync(f)) shell.showItemInFolder(f);
    else shell.openPath(path.dirname(f));
    return true;
  });
  // The entry's submitted work as files: index.html and about.txt, plus any
  // video saved from it.
  handle("entry-folder", async (eid) => {
    const { dir } = writeEntry(HOME, id(eid));
    const err = SMOKE ? "" : await shell.openPath(dir);
    if (err) throw new Error(err);
    return dir;
  });
  // A video entry's own file, opened in the computer's video player.
  handle("entry-play", async (eid) => {
    const { video: file } = writeEntry(HOME, id(eid));
    if (!file) throw new Error("This entry is not a video file.");
    const err = SMOKE ? "" : await shell.openPath(file);
    if (err) throw new Error(err);
    return file;
  });
  let recording = null;
  // Records a page entry to MP4: the battle's length and size for video
  // battles, 30 seconds at 1280x720 for the rest.
  handle("entry-video", async (eid) => {
    if (recording) throw new Error("A video is already being saved.");
    const { dir, entry, battle } = writeEntry(HOME, id(eid));
    if (entry.format === "video") throw new Error("This entry is already a video. Use Play video.");
    const isVideo = battle.kind === "video";
    const [width, height] = (isVideo ? battle.video_size : "1280x720").split("x").map(Number);
    const out = path.join(dir, "entry-" + entry.num + ".mp4");
    recording = video.record({ url: "jdebate-preview://" + entry.id + "/", out, seconds: isVideo ? battle.video_seconds : 30, width, height, session: opts.session });
    try {
      await recording;
    } finally {
      recording = null;
    }
    if (!SMOKE) shell.showItemInFolder(out);
    return out;
  });

  // Bring the installed jdebate server up to this version before agents use it.
  const startup = install.update(HOME).catch((e) => ({ updated: false, error: String(e.message || e), results: [] }));
  handle("startup-update", () => startup);

  // Updates for JDebate itself. Inside JWorkspace there is no installer, so the
  // state says "source" and checks do nothing.
  const u = opts.updater || {};
  const appUpdater = createUpdater({ updater: u.updater || null, packaged: Boolean(u.packaged), version: u.version, onChange: opts.onUpdate });
  handle("app-update-state", () => appUpdater.state());
  handle("app-update-check", () => appUpdater.check());
  handle("app-update-download", () => appUpdater.download());
  handle("app-update-install", () => appUpdater.install());
  handle("app-releases", () => shell.openExternal(RELEASES_URL).then(() => true));

  const preview = (req) => {
    try {
      return previewResponse(HOME, req);
    } catch (e) {
      return new Response(String(e.message || e), { status: 500, headers: { "content-type": "text/plain" } });
    }
  };
  return { preview, updater: appUpdater, startup };
}

const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });

// A stored file, with byte ranges so a video can seek.
function fileResponse(req, f, headers) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  const base = Object.assign({ "content-type": f.type, "accept-ranges": "bytes", "cache-control": "no-store", "access-control-allow-origin": "*" }, headers);
  if (!range || (!range[1] && !range[2])) {
    return new Response(Readable.toWeb(fs.createReadStream(f.file)), { headers: Object.assign(base, { "content-length": String(f.size) }) });
  }
  let start = range[1] ? Number(range[1]) : Math.max(0, f.size - Number(range[2]));
  let end = range[1] && range[2] ? Math.min(Number(range[2]), f.size - 1) : f.size - 1;
  if (start >= f.size || start > end) return new Response("", { status: 416, headers: Object.assign(base, { "content-range": "bytes */" + f.size }) });
  return new Response(Readable.toWeb(fs.createReadStream(f.file, { start, end })), {
    status: 206,
    headers: Object.assign(base, { "content-length": String(end - start + 1), "content-range": "bytes " + start + "-" + end + "/" + f.size }),
  });
}

function previewResponse(HOME, req) {
  const u = new URL(req.url);
  // jdebate-preview://entry/<id>: links from before entries had their own origin.
  const legacy = u.hostname === "entry";
  const entry = store.getEntry(HOME, legacy ? u.pathname.slice(1) : u.hostname);
  if (!entry) return notFound();
  const page = (html) => new Response(guard(html), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": legacy ? CSP : cspFor(entry.id), "cache-control": "no-store" } });
  let p = legacy ? "" : decodeURIComponent(u.pathname).replace(/^\/+/, "");
  if (!p || p.endsWith("/")) p += "index.html";
  if (entry.format === "video") return p === "index.html" ? page(videoPage(entry.files[0].path)) : (store.entryFile(HOME, entry, p) ? fileResponse(req, store.entryFile(HOME, entry, p)) : notFound());
  if (entry.format !== "site") return p === "index.html" ? page(compose(entry)) : notFound();
  // A site: the file at the path, or path.html, or path/index.html.
  const f = store.entryFile(HOME, entry, p) || (!/\.[a-z0-9]+$/i.test(p) && (store.entryFile(HOME, entry, p + ".html") || store.entryFile(HOME, entry, p + "/index.html")));
  if (!f) return new Response("This site has no page " + p + ".", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const headers = { "content-security-policy": cspFor(entry.id) };
  if (/^text\/html/.test(f.type)) return new Response(guard(fs.readFileSync(f.file, "utf8")), { headers: Object.assign(headers, { "content-type": f.type, "cache-control": "no-store" }) });
  return fileResponse(req, f, headers);
}

module.exports = { createBackend };
