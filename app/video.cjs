"use strict";

// Records an entry to an MP4: the entry runs in a hidden offscreen window
// (never on the desktop) and its frames go to ffmpeg at a steady frame rate.
// Pages only paint when something changes, so each tick sends the latest
// frame again until a new one comes.

const { spawn } = require("node:child_process");
const { BrowserWindow } = require("electron");

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

function ffmpegArgs(out, seconds) {
  return [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "bgra", "-s", WIDTH + "x" + HEIGHT, "-r", String(FPS), "-i", "-",
    "-t", String(seconds), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ];
}

function record({ url, out, seconds = 30, ffmpeg = process.env.JDEBATE_FFMPEG || "ffmpeg" }) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setAudioMuted(true);

    const proc = spawn(ffmpeg, ffmpegArgs(out, seconds), { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let done = false;
    let frame = null;
    let timer = null;
    proc.stderr.on("data", (d) => (stderr += d));

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      if (err) {
        proc.kill();
        reject(err);
      } else proc.stdin.end();
    };
    proc.on("error", (e) => finish(e.code === "ENOENT" ? new Error("Saving a video needs ffmpeg. Install it (winget install Gyan.FFmpeg), then restart JDebate.") : e));
    proc.on("close", (code) => {
      if (!done) return finish(new Error("ffmpeg stopped: " + (stderr.trim() || "exit " + code)));
      if (code === 0) resolve({ out, seconds });
      else reject(new Error("ffmpeg could not write the video: " + (stderr.trim() || "exit " + code)));
    });

    const bitmap = (image) => {
      const s = image.getSize();
      return (s.width === WIDTH && s.height === HEIGHT ? image : image.resize({ width: WIDTH, height: HEIGHT })).toBitmap();
    };
    win.webContents.setFrameRate(FPS);
    win.webContents.on("paint", (_e, _dirty, image) => {
      if (!image.isEmpty()) frame = bitmap(image);
    });

    // Starts at the first frame after load, which is when the entry starts.
    let start = 0;
    let sent = 0;
    const total = Math.round(seconds * FPS);
    const tick = async () => {
      if (done) return;
      if (frame) {
        if (!start) start = Date.now();
        const due = Math.min(total, Math.floor(((Date.now() - start) / 1000) * FPS) + 1);
        while (sent < due && !done) {
          sent++;
          if (!proc.stdin.write(frame)) await new Promise((r) => proc.stdin.once("drain", r));
        }
        if (sent >= total) return finish();
      }
      timer = setTimeout(tick, 1000 / FPS / 2);
    };
    win.webContents.once("did-finish-load", tick);
    win.webContents.once("did-fail-load", (_e, code, desc) => finish(new Error("The entry did not load: " + desc + " (" + code + ")")));
    win.loadURL(url).catch(() => {});
  });
}

module.exports = { record, ffmpegArgs, WIDTH, HEIGHT, FPS };
