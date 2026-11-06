"use strict";

// Everything the JDebate window calls, plus the jdebate-preview: scheme.
// Shared by the standalone app (main.cjs) and by JWorkspace, which loads
// JDebate as a plugin app (workspace.cjs). The caller passes how to register a
// handler, how to tell the window about update changes, and who owns the theme.

const path = require("node:path");
const fs = require("node:fs");
const { shell, clipboard, dialog, BrowserWindow, nativeImage } = require("electron");
const store = require("../server/lib/store.js");
const { isText } = require("../server/lib/files.js");
const install = require("../core/install.cjs");
const { Readable } = require("node:stream");
const { compose, videoPage, modelPage, modelCsp, guard, cspFor, origin, CSP } = require("../core/preview.cjs");
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
  // One open database connection for the life of the app (see store.keepOpen).
  store.keepOpen(true);

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
  handle("no-winner", (bid, reason) => store.setNoWinner(HOME, id(bid), typeof reason === "string" ? reason : null));
  handle("entry", (eid) => store.getEntry(HOME, id(eid)));
  // 3D model battles: approve or deny an entry, and set the current version.
  handle("review", (eid, status, note) => store.review(HOME, id(eid), status || "", note || ""));
  handle("battle-old-notes", (bid, notes) => store.setOld(HOME, id(bid), { notes: String(notes || "") }));
  handle("battle-old-folder", async (bid, folder) => {
    let dir = folder ? String(folder) : "";
    if (!dir) {
      if (SMOKE) throw new Error("No folder given.");
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, { title: "Folder with screenshots of the current version", properties: ["openDirectory"] });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    return store.setOld(HOME, id(bid), { folder: dir });
  });
  // Background load: makes every thumbnail of a battle and reads its models
  // once, so the OS has them cached. The window loads the 3D views itself.
  handle("battle-preload", async (bid) => {
    const b = store.getBattle(HOME, id(bid));
    if (!b) throw new Error("That battle is gone.");
    const t0 = Date.now();
    const jobs = [];
    // [file, thumbnail widths the pages use]: the current-version strip (240)
    // and compare column (960), each card's first image (480), entry images (960).
    for (const f of b.old_files) jobs.push([store.oldFile(HOME, b, f.path), [240, 960]]);
    for (const e of store.entries(HOME, b.id, { noCode: true })) {
      const first = e.files.find(isImage);
      for (const f of e.files) if (isImage(f) || isModel(f)) jobs.push([store.entryFile(HOME, e, f.path), f === first ? [480, 960] : [960]]);
    }
    let images = 0;
    let models = 0;
    for (const [f, widths] of jobs) {
      if (!f) continue;
      try {
        if (isImage(f)) {
          makeThumbs(HOME, f, widths);
          images++;
        } else if (isModel(f)) {
          await fs.promises.readFile(f.file);
          models++;
        }
      } catch {}
      await new Promise((r) => setImmediate(r));
    }
    return { images, models, ms: Date.now() - t0 };
  });
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
  if (!SMOKE) warmThumbs(HOME);
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

// three.js for the 3D viewer, from the app's own node_modules. Read once and
// kept in memory: every 3D frame asks for the same five files.
const THREE_DIR = path.join(__dirname, "..", "node_modules", "three");
const threeCache = new Map();
function threeResponse(p) {
  const rel = p.slice("__jdebate/three/".length);
  if (!/^(build|examples\/jsm)\/[A-Za-z0-9_\-./]+\.js$/.test(rel) || rel.includes("..")) return notFound();
  let body = threeCache.get(rel);
  if (!body) {
    const file = path.join(THREE_DIR, ...rel.split("/"));
    if (!fs.existsSync(file)) return notFound();
    body = fs.readFileSync(file);
    threeCache.set(rel, body);
  }
  return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400", "access-control-allow-origin": "*" } });
}

// ?w=<width> on an image: a smaller JPEG for thumbnails and side-by-side
// compares, made once and kept in ~/.jdebate/thumbs (blobs never change, so
// the blob name is the key). Renders are often 1-4 MB PNGs; dozens of them at
// full size made the Old and new tab slow to open. JPEG, because PNG encoding
// takes seconds per image; images with transparency keep their original.
const THUMB_WIDTHS = [240, 480, 960];
// Returns the file to serve for each width: a JPEG in thumbs/, or the original
// when it is already small enough or has transparency. Decodes the image once.
function makeThumbs(HOME, f, widths) {
  const dir = path.join(store.dataHome(HOME), "thumbs");
  const out = {};
  const todo = [];
  for (const width of widths) {
    const base = path.join(dir, path.basename(f.file) + "-" + width);
    if (fs.existsSync(base + ".jpg")) out[width] = base + ".jpg";
    else if (fs.existsSync(base + ".orig")) out[width] = f.file;
    else todo.push([width, base]);
  }
  if (!todo.length) return out;
  const mark = (base, ext, body) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(base + ext, body);
    } catch {}
  };
  // Most renders are already small enough: read a PNG's width from its header
  // and skip decoding when no width needs a smaller copy.
  const headWidth = pngWidth(f.file);
  if (headWidth && todo.every(([width]) => headWidth <= width * 1.25)) {
    for (const [width, base] of todo) {
      mark(base, ".orig", "");
      out[width] = f.file;
    }
    return out;
  }
  const img = nativeImage.createFromPath(f.file);
  const size = img.isEmpty() ? null : img.getSize();
  for (const [width, base] of todo) {
    if (!size || size.width <= width * 1.25) {
      mark(base, ".orig", "");
      out[width] = f.file;
      continue;
    }
    const small = img.resize({ width, quality: "good" });
    const px = small.toBitmap();
    let opaque = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) {
        opaque = false;
        break;
      }
    }
    if (!opaque) {
      mark(base, ".orig", "");
      out[width] = f.file;
      continue;
    }
    mark(base, ".jpg", small.toJPEG(85));
    out[width] = base + ".jpg";
  }
  return out;
}
function pngWidth(file) {
  try {
    const fd = fs.openSync(file, "r");
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    fs.closeSync(fd);
    return b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR" ? b.readUInt32BE(16) : 0;
  } catch {
    return 0;
  }
}
const makeThumb = (HOME, f, width) => makeThumbs(HOME, f, [width])[width];
function thumbWidth(req) {
  const w = Number(new URL(req.url).searchParams.get("w"));
  return w ? THUMB_WIDTHS.find((x) => x >= w) || THUMB_WIDTHS[THUMB_WIDTHS.length - 1] : 0;
}
function thumbResponse(HOME, req, f, headers) {
  const width = thumbWidth(req);
  if (!width || !/^image\/(png|jpeg|webp)/.test(f.type)) return null;
  const file = makeThumb(HOME, f, width);
  if (file === f.file) return fileResponse(req, f, Object.assign({ "cache-control": "max-age=86400" }, headers));
  return new Response(fs.readFileSync(file), { headers: Object.assign({ "content-type": "image/jpeg", "cache-control": "max-age=86400", "access-control-allow-origin": "*" }, headers) });
}

// Makes the thumbnails of open model battles in the background, one image at
// a time with a pause between, so opening a battle finds them ready.
function warmThumbs(HOME) {
  const jobs = [];
  try {
    for (const b of store.listBattles(HOME)) {
      if (b.status !== "open" || b.kind !== "model") continue;
      for (const f of b.old_files.filter(isImage)) jobs.push([store.oldFile(HOME, b, f.path), 240]);
      for (const e of store.entries(HOME, b.id, { noCode: true })) {
        const imgs = e.files.filter(isImage);
        if (imgs[0]) jobs.push([store.entryFile(HOME, e, imgs[0].path), 480]);
        for (const f of imgs) jobs.push([store.entryFile(HOME, e, f.path), 960]);
      }
      for (const f of b.old_files.filter(isImage)) jobs.push([store.oldFile(HOME, b, f.path), 960]);
    }
  } catch {
    return;
  }
  const next = () => {
    const j = jobs.shift();
    if (!j) return;
    try {
      if (j[0]) makeThumb(HOME, j[0], j[1]);
    } catch {}
    setTimeout(next, 60);
  };
  setTimeout(next, 4000);
}
const serveFile = (HOME, req, f, headers) => thumbResponse(HOME, req, f, headers) || fileResponse(req, f, headers);

const isModel = (f) => /\.(glb|gltf)$/i.test(f.path);
const isImage = (f) => /\.(png|jpe?g|webp)$/i.test(f.path);

// jdebate-preview://old-<battle id>/: a model battle's current version.
function oldResponse(HOME, req, bid, p) {
  const b = store.getBattle(HOME, bid);
  if (!b) return notFound();
  const o = origin("old-" + bid);
  if (p.startsWith("__jdebate/three/")) return threeResponse(p);
  if (p === "index.html") {
    const glb = b.old_files.find(isModel);
    return new Response(guard(modelPage(glb ? glb.path : null, b.old_files.filter(isImage).map((f) => f.path))), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": modelCsp(o), "cache-control": "no-store" } });
  }
  const f = store.oldFile(HOME, b, p);
  return f ? serveFile(HOME, req, f, { "content-security-policy": modelCsp(o) }) : notFound();
}

function previewResponse(HOME, req) {
  const u = new URL(req.url);
  if (u.hostname.startsWith("old-")) {
    let op = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    if (!op || op.endsWith("/")) op += "index.html";
    return oldResponse(HOME, req, u.hostname.slice(4), op);
  }
  // jdebate-preview://entry/<id>: links from before entries had their own origin.
  const legacy = u.hostname === "entry";
  const entry = store.getEntry(HOME, legacy ? u.pathname.slice(1) : u.hostname);
  if (!entry) return notFound();
  const page = (html) => new Response(guard(html), { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": legacy ? CSP : cspFor(entry.id), "cache-control": "no-store" } });
  let p = legacy ? "" : decodeURIComponent(u.pathname).replace(/^\/+/, "");
  if (!p || p.endsWith("/")) p += "index.html";
  if (entry.format === "model") {
    const csp = { "content-security-policy": modelCsp(origin(entry.id)) };
    if (p.startsWith("__jdebate/three/")) return threeResponse(p);
    if (p === "index.html" && !store.entryFile(HOME, entry, p)) {
      const glb = entry.files.find(isModel);
      return new Response(guard(modelPage(glb ? glb.path : null, entry.files.filter(isImage).map((f) => f.path))), { headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, csp) });
    }
    const mf = store.entryFile(HOME, entry, p);
    return mf ? serveFile(HOME, req, mf, csp) : notFound();
  }
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
