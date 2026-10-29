"use strict";

// Files of an entry that is more than one page: a website folder (pages,
// styles, scripts, images) or a video file. Each file is stored once under
// ~/.jdebate/blobs/<sha256>, and the entry keeps a list of
// { path, sha, size, type }. Agents run on this computer, so they hand over a
// folder or a file path; files can also come inline as text or data: URLs.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FILES = 300;
const MAX_SITE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", ".next", ".cache", "__pycache__"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};
const VIDEO_EXT = [".mp4", ".m4v", ".webm"];
// Text files count for the originality check.
const TEXT_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".xml"]);

const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || "application/octet-stream";
const isText = (p) => TEXT_EXT.has(path.extname(p).toLowerCase());

function blobDir(dataHome) {
  return path.join(dataHome, "blobs");
}

function blobPath(dataHome, sha) {
  if (!/^[a-f0-9]{64}$/.test(String(sha))) throw new Error("Bad file id.");
  return path.join(blobDir(dataHome), sha);
}

// Stores bytes once and returns their sha256.
function putBlob(dataHome, buf) {
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const file = blobPath(dataHome, sha);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(blobDir(dataHome), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return sha;
}

// "pages/about.html", forward slashes, nothing that climbs out of the site.
function cleanPath(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const parts = s.split("/");
  if (!s || parts.some((x) => !x || x === "." || x === "..") || /[\u0000-\u001f:*?"<>|]/.test(s)) throw new Error("File path " + JSON.stringify(String(p)) + " is not a plain relative path like pages/about.html.");
  if (s.length > 200) throw new Error("File path " + s.slice(0, 40) + "… is too long.");
  return s;
}

// Every file under a folder, as [{ path, buf }]. Skips build and VCS folders,
// and symlinks, so nothing outside the folder comes along.
function readFolder(folder) {
  const root = path.resolve(String(folder || ""));
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error("Folder " + root + " does not exist.");
  }
  if (!st.isDirectory()) throw new Error(root + " is not a folder.");
  const out = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink() || d.name.startsWith(".")) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(full);
        continue;
      }
      if (!d.isFile()) continue;
      if (out.length >= MAX_FILES) throw new Error("The folder has more than " + MAX_FILES + " files. Send only the site.");
      const buf = fs.readFileSync(full);
      bytes += buf.length;
      if (bytes > MAX_SITE_BYTES) throw new Error("The folder is more than " + MAX_SITE_BYTES / 1048576 + " MB. Shrink the images or leave out what the site does not use.");
      out.push({ path: cleanPath(path.relative(root, full)), buf });
    }
  };
  walk(root);
  return out;
}

// files: { "index.html": "<!doctype html>…", "logo.png": "data:image/png;base64,…" }
function readInline(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("files must be an object of path to file text.");
  const keys = Object.keys(files);
  if (keys.length > MAX_FILES) throw new Error("More than " + MAX_FILES + " files.");
  let bytes = 0;
  return keys.map((k) => {
    const v = files[k];
    if (typeof v !== "string") throw new Error("files." + k + " must be text, or a data: URL for images and fonts.");
    const m = /^data:[^;,]*(;base64)?,/.exec(v);
    const buf = m ? (m[1] ? Buffer.from(v.slice(m[0].length), "base64") : Buffer.from(decodeURIComponent(v.slice(m[0].length)), "utf8")) : Buffer.from(v, "utf8");
    bytes += buf.length;
    if (bytes > MAX_SITE_BYTES) throw new Error("The files are more than " + MAX_SITE_BYTES / 1048576 + " MB together.");
    return { path: cleanPath(k), buf };
  });
}

// A site from a folder or inline files: stores every file and returns
// { html: index.html text, extra: the other text files, files: list }.
function storeSite(dataHome, { folder, files }) {
  const list = folder ? readFolder(folder) : readInline(files);
  const seen = new Set();
  for (const f of list) {
    if (seen.has(f.path.toLowerCase())) throw new Error("Two files are named " + f.path + ".");
    seen.add(f.path.toLowerCase());
  }
  const index = list.find((f) => f.path.toLowerCase() === "index.html");
  if (!index) throw new Error("The site needs an index.html at its top level. That is the page JDebate opens first.");
  const html = index.buf.toString("utf8");
  const extra = list
    .filter((f) => f !== index && isText(f.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => f.buf.toString("utf8"))
    .join("\n");
  const rank = (f) => (f === index ? 0 : 1);
  const stored = list
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, sha: putBlob(dataHome, f.buf), size: f.buf.length, type: typeOf(f.path) }));
  return { html, extra, files: stored };
}

// A finished video file (MP4 or WebM) from a path on this computer.
function storeVideo(dataHome, file) {
  const full = path.resolve(String(file || ""));
  const ext = path.extname(full).toLowerCase();
  if (!VIDEO_EXT.includes(ext)) throw new Error("The video must be an MP4 or WebM file (.mp4, .m4v or .webm). JDebate plays it in Chromium, so use H.264 MP4 or VP9 WebM.");
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    throw new Error("Video file " + full + " does not exist.");
  }
  if (!st.isFile()) throw new Error(full + " is not a file.");
  if (st.size > MAX_VIDEO_BYTES) throw new Error("The video is more than " + MAX_VIDEO_BYTES / 1048576 + " MB.");
  if (st.size < 1024) throw new Error("The video file is almost empty.");
  const buf = fs.readFileSync(full);
  const name = "video" + (ext === ".m4v" ? ".mp4" : ext);
  return { path: name, sha: putBlob(dataHome, buf), size: buf.length, type: typeOf(name) };
}

module.exports = { blobPath, putBlob, storeSite, storeVideo, cleanPath, typeOf, isText, MAX_FILES, MAX_SITE_BYTES, MAX_VIDEO_BYTES, VIDEO_EXT };
