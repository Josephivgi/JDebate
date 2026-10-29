"use strict";

// JDebate desktop app. The user opens battles, watches agents' entries come
// in, looks at each one live, and picks a winner. It also installs the
// jdebate MCP server into every coding agent, the way JMCP does.
//
// --smoke [--out file.png] [--page id]: load the window hidden, render it,
// save a screenshot and the page text, then quit. No window is shown.

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, shell, nativeTheme, protocol, clipboard } = require("electron");
const store = require("../server/lib/store.js");
const { isText } = require("../server/lib/files.js");
const install = require("../core/install.cjs");
const { Readable } = require("node:stream");
const { compose, videoPage, guard, cspFor, CSP } = require("../core/preview.cjs");
const { createUpdater, RELEASES_URL } = require("./updater.cjs");
const { writeEntry } = require("../core/export.cjs");
const video = require("./video.cjs");
const siteShot = require("./site-shot.cjs");

const argv = process.argv.slice(1);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] || "" : null;
};
const SMOKE = argv.includes("--smoke");
// --home works on a scratch home folder (tests and smoke runs).
const HOME = flag("--home") || process.env.JDEBATE_TEST_HOME || undefined;

app.setName("JDebate");
if (SMOKE) app.disableHardwareAcceleration();
if (flag("--theme")) nativeTheme.themeSource = flag("--theme");

// Entry pages load from jdebate-preview://<entry id>/ in a sandboxed frame;
// jdebate-preview://before/<battle id> is the screenshot of a site to redesign.
protocol.registerSchemesAsPrivileged([{ scheme: "jdebate-preview", privileges: { standard: true, secure: true } }]);

function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

const id = (v) => String(v || "");

handle("stamp", () => store.stamp(HOME));
handle("battles", () => store.listBattles(HOME));
// Screenshots of sites being redesigned, by battle id, while they are taken.
const shooting = new Set();
function shootSite(b, again) {
  if (!b || b.kind !== "website" || !b.site_url || shooting.has(b.id)) return b;
  if (!again && (b.before_sha || b.before_error)) return b;
  shooting.add(b.id);
  const url = b.site_url;
  siteShot
    .shoot(url)
    .then((png) => ({ sha: store.putBlob(HOME, png) }), (e) => ({ error: String((e && e.message) || e) }))
    .then((r) => {
      // Done before the write, so the redraw the write causes sees it.
      shooting.delete(b.id);
      store.setBefore(HOME, b.id, Object.assign({ url }, r));
    })
    .catch(() => shooting.delete(b.id));
  return b;
}

handle("battle", (bid) => {
  const b = store.getBattle(HOME, id(bid));
  if (!b) return null;
  shootSite(b);
  return { battle: b, entries: store.entries(HOME, b.id, { noCode: true }), shooting: shooting.has(b.id) };
});
handle("battle-open", (input) => {
  const i = input || {};
  return shootSite(store.openBattle(HOME, { title: i.title, task: i.task, kind: i.kind, site: i.site, videoSeconds: i.videoSeconds, videoSize: i.videoSize }));
});
handle("battle-edit", (bid, patch) => shootSite(store.editBattle(HOME, id(bid), patch)));
handle("battle-shoot", (bid) => shootSite(store.getBattle(HOME, id(bid)), true));
handle("open-site", (bid) => {
  const b = store.getBattle(HOME, id(bid));
  if (!b || !/^https?:\/\//.test(b.site_url)) throw new Error("This battle has no site.");
  return shell.openExternal(b.site_url).then(() => true);
});
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
  recording = video.record({ url: "jdebate-preview://" + entry.id + "/", out, seconds: isVideo ? battle.video_seconds : 30, width, height });
  try {
    await recording;
  } finally {
    recording = null;
  }
  if (!SMOKE) shell.showItemInFolder(out);
  return out;
});
let startup = Promise.resolve(null);
handle("startup-update", () => startup);
// Updates for JDebate itself, from GitHub Releases. Created when the app is
// ready; the window gets each change as an "app-update" event.
let appUpdater = null;
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
function startUpdater() {
  appUpdater = createUpdater({
    updater: app.isPackaged ? require("electron-updater").autoUpdater : null,
    packaged: app.isPackaged && !SMOKE,
    version: app.getVersion(),
    onChange: (s) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("app-update", s);
    },
  });
  if (app.isPackaged && !SMOKE) {
    setTimeout(() => appUpdater.check(), 8000);
    setInterval(() => appUpdater.check(), UPDATE_EVERY).unref();
  }
}
handle("app-update-state", () => appUpdater.state());
handle("app-update-check", () => appUpdater.check());
handle("app-update-download", () => appUpdater.download());
handle("app-update-install", () => appUpdater.install());
handle("app-releases", () => shell.openExternal(RELEASES_URL).then(() => true));

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

function previewResponse(req) {
  const u = new URL(req.url);
  if (u.hostname === "before") {
    const b = store.getBattle(HOME, u.pathname.slice(1));
    if (!b || !b.before_sha) return notFound();
    const file = store.blobFile(HOME, b.before_sha);
    return fileResponse(req, { file, type: "image/png", size: fs.statSync(file).size });
  }
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

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: Number(flag("--width")) || 1280,
    height: SMOKE && Number(flag("--height")) ? Number(flag("--height")) : 820,
    minWidth: 600,
    minHeight: 520,
    show: !SMOKE,
    title: "JDebate",
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: dark ? "#16181d" : "#f5f6f8",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: SMOKE },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Entry frames must not move the app window anywhere.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Links inside an entry move between its own pages, never to the web.
  win.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame && !e.url.startsWith("jdebate-preview://")) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: SMOKE && flag("--page") ? { page: flag("--page") } : {} });
  return win;
}

async function smoke(win) {
  const out = path.resolve(flag("--out") || "jdebate-smoke.png");
  await new Promise((r) => win.webContents.once("did-finish-load", r));
  const until = Date.now() + 60000;
  while (Date.now() < until && !(await win.webContents.executeJavaScript("document.documentElement.dataset.ready === '1'"))) await new Promise((r) => setTimeout(r, 200));
  const settle = async () => {
    const end = Date.now() + 60000;
    while (Date.now() < end && (await win.webContents.executeJavaScript("/Working|Installing|Loading|Saving video/.test(document.querySelector('main').innerText)"))) await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => setTimeout(r, 500));
  };
  await settle();
  // Hidden actions in order: --smoke-type Label=value, --smoke-click Button.
  for (let i = 0; i < argv.length; i++) {
    const action = argv[i];
    if (action !== "--smoke-type" && action !== "--smoke-click") continue;
    const entry = argv[++i] || "";
    if (action === "--smoke-type") {
      const eq = entry.indexOf("=");
      const found = await win.webContents.executeJavaScript(
        "(() => { const el = [...document.querySelectorAll('main input, main textarea')].find((x) => x.getAttribute('aria-label') === " + JSON.stringify(entry.slice(0, eq)) + "); if (!el) return false; el.value = " + JSON.stringify(entry.slice(eq + 1)) + "; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
      );
      if (!found) throw new Error("smoke: no input " + entry.slice(0, eq));
      continue;
    }
    const found = await win.webContents.executeJavaScript(
      "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(" + JSON.stringify(entry) + ") || x.getAttribute('aria-label') === " + JSON.stringify(entry) + "); if (b) b.click(); return Boolean(b); })()",
    );
    if (!found) throw new Error("smoke: no button " + entry);
    await settle();
  }
  // Frames load on their own; give them a moment before the capture.
  await new Promise((r) => setTimeout(r, Number(flag("--wait")) || 1200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  const text = await win.webContents.executeJavaScript("document.querySelector('main').innerText");
  const errors = await win.webContents.executeJavaScript("window.__errors || []");
  process.stdout.write(JSON.stringify({ png: out, errors, text: text.slice(0, 4000) }, null, 1) + "\n");
  app.exit(errors.length ? 1 : 0);
}

app.whenReady().then(() => {
  protocol.handle("jdebate-preview", (req) => {
    try {
      return previewResponse(req);
    } catch (e) {
      return new Response(String(e.message || e), { status: 500, headers: { "content-type": "text/plain" } });
    }
  });
  // Bring the installed jdebate server up to this version before agents use it.
  startUpdater();
  startup = install.update(HOME).catch((e) => ({ updated: false, error: String(e.message || e), results: [] }));
  const win = createWindow();
  if (SMOKE) {
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") process.stderr.write("renderer: " + e.message + "\n");
    });
    smoke(win).catch((e) => {
      process.stderr.write(String(e && e.stack) + "\n");
      app.exit(1);
    });
  }
});
app.on("window-all-closed", () => app.quit());
