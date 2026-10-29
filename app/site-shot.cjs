"use strict";

// A screenshot of the site a website battle redesigns, so the battle page
// can show it next to the entries. The site loads in a hidden offscreen
// window (never on the desktop) with its own in-memory session: no
// downloads, no permissions, no pop-ups, muted.

const { BrowserWindow, session } = require("electron");

const WIDTH = 1280;
const HEIGHT = 800;
// Sites with ads or chat widgets never finish loading; after this long the
// page is captured as it is.
const TIMEOUT = 25000;
// After load, time for fonts, images and entrance animations.
const SETTLE = 2500;

let ready = null;
function siteSession() {
  if (ready) return ready;
  ready = session.fromPartition("jdebate-site");
  ready.on("will-download", (_e, item) => item.cancel());
  ready.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ready.setPermissionCheckHandler(() => false);
  return ready;
}

// Resolves with PNG bytes.
function shoot(url) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: siteSession() },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let done = false;
    let painted = false;
    let timer = null;
    const finish = (err, png) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (err) reject(err);
      else resolve(png);
    };
    const capture = async () => {
      if (done) return;
      try {
        const img = await win.webContents.capturePage();
        if (img.isEmpty()) return finish(new Error("The site showed nothing to capture."));
        finish(null, img.toPNG());
      } catch (e) {
        finish(e);
      }
    };
    win.webContents.on("paint", () => (painted = true));
    win.webContents.on("did-finish-load", () => {
      clearTimeout(timer);
      timer = setTimeout(capture, SETTLE);
    });
    win.webContents.on("did-fail-load", (_e, code, desc, _u, isMainFrame) => {
      // -3 is a load replaced by a redirect or a newer load.
      if (isMainFrame && code !== -3) finish(new Error("The site did not load: " + desc + " (" + code + ")."));
    });
    timer = setTimeout(() => (painted ? capture() : finish(new Error("The site did not load in " + TIMEOUT / 1000 + " seconds."))), TIMEOUT);
    win.loadURL(url).catch(() => {});
  });
}

module.exports = { shoot, WIDTH, HEIGHT };
