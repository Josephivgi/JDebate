"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jdebate-test-"));
}

// Two entries for the same task, written separately.
const CLOCK = {
  title: "Ring clock",
  html: '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Clock</title>\n</head>\n<body>\n<main class="wrap"><svg id="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="track"/><circle cx="50" cy="50" r="44" class="sec" id="sec"/></svg><p id="time">00:00:00</p></main>\n</body>\n</html>',
  css: ".wrap { display: grid; place-items: center; min-height: 100vh; background: #10131a; color: #e8ecf3; font: 600 40px/1 system-ui; }\n.track { fill: none; stroke: #2a3040; stroke-width: 6; }\n.sec { fill: none; stroke: #7aa2ff; stroke-width: 6; stroke-dasharray: 276.46; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.3s; }\n#ring { width: 220px; }",
  js: "const sec = document.getElementById('sec');\nconst label = document.getElementById('time');\nfunction tick() {\n  const now = new Date();\n  const s = now.getSeconds();\n  sec.style.strokeDashoffset = String(276.46 * (1 - s / 60));\n  label.textContent = now.toLocaleTimeString([], { hour12: false });\n}\ntick();\nsetInterval(tick, 1000);",
};

const FLIP = {
  title: "Flip digits",
  html: '<div class="board"><span class="d" data-i="0"></span><span class="d" data-i="1"></span><b>:</b><span class="d" data-i="2"></span><span class="d" data-i="3"></span><b>:</b><span class="d" data-i="4"></span><span class="d" data-i="5"></span></div>',
  css: "body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(#222, #111); }\n.board { display: flex; gap: 6px; align-items: center; color: #fafafa; font-family: monospace; font-size: 64px; }\n.d { width: 56px; padding: 8px 0; text-align: center; background: #333; border-radius: 8px; box-shadow: inset 0 -2px #000; }\nb { opacity: 0.6; }",
  js: "var cells = Array.prototype.slice.call(document.querySelectorAll('.d'));\nfunction pad(n) { return n < 10 ? '0' + n : '' + n; }\nfunction draw() {\n  var t = new Date();\n  var str = pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds());\n  for (var i = 0; i < cells.length; i++) { if (cells[i].textContent !== str[i]) cells[i].textContent = str[i]; }\n  requestAnimationFrame(draw);\n}\ndraw();",
};

module.exports = { scratch, CLOCK, FLIP };
