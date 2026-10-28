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
const install = require("../core/install.cjs");
const { compose, CSP } = require("../core/preview.cjs");
const { createUpdater, RELEASES_URL } = require("./updater.cjs");

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

// Entry pages load from jdebate-preview://entry/<id> in a sandboxed frame.
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
handle("battle", (bid) => {
  const b = store.getBattle(HOME, id(bid));
  if (!b) return null;
  return { battle: b, entries: store.entries(HOME, b.id, { noCode: true }) };
});
handle("battle-open", (input) => store.openBattle(HOME, { title: input && input.title, task: input && input.task }));
handle("battle-edit", (bid, patch) => store.editBattle(HOME, id(bid), patch));
handle("battle-close", (bid) => store.closeBattle(HOME, id(bid)));
handle("battle-reopen", (bid) => store.reopenBattle(HOME, id(bid)));
handle("battle-remove", (bid) => store.removeBattle(HOME, id(bid)));
handle("winner", (bid, eid) => store.setWinner(HOME, id(bid), eid ? id(eid) : null));
handle("entry", (eid) => store.getEntry(HOME, id(eid)));
handle("entry-remove", (eid) => store.removeEntry(HOME, id(eid)));
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

function previewResponse(url) {
  const u = new URL(url);
  const entry = u.hostname === "entry" ? store.getEntry(HOME, u.pathname.replace(/^\//, "")) : null;
  if (!entry) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(compose(entry), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" } });
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
    while (Date.now() < end && (await win.webContents.executeJavaScript("/Working|Installing|Loading/.test(document.querySelector('main').innerText)"))) await new Promise((r) => setTimeout(r, 300));
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
      return previewResponse(req.url);
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
