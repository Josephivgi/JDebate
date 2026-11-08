"use strict";

// What the app serves for an entry. Each entry has its own origin,
// jdebate-preview://<entry id>/, so a site's pages, styles, images and video
// load from it by relative path. The CSP allows the entry's inline code and
// its own files, and nothing from the network.

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const origin = (entryId) => "jdebate-preview://" + entryId;

function cspFor(entryId) {
  const o = origin(entryId);
  return "default-src 'none'; script-src 'unsafe-inline' " + o + "; style-src 'unsafe-inline' " + o + "; img-src data: blob: " + o + "; font-src data: " + o + "; media-src data: blob: " + o + "; connect-src 'none'; form-action 'none'; base-uri " + o;
}

const safeCss = (css) => String(css || "").replace(/<\/style/gi, "<\\/style");
const safeJs = (js) => String(js || "").replace(/<\/script/gi, "<\\/script");

function compose(entry) {
  const html = String(entry.html || "");
  const style = entry.css ? "<style>\n" + safeCss(entry.css) + "\n</style>\n" : "";
  const script = entry.js ? "<script>\n" + safeJs(entry.js) + "\n</script>\n" : "";
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html)) {
    return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' + style + "</head>\n<body>\n" + html + "\n" + script + "</body>\n</html>\n";
  }
  let out = html;
  if (style) out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => style + "</head>") : style + out;
  if (script) out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => script + "</body>") : out + script;
  return out;
}

// Added to every page the app serves (not to exported files): the network is
// blocked anyway, so a link to the web would only leave an error page in the
// frame. Such links do nothing instead.
const GUARD =
  "<script>addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');" +
  "if(a&&!/^jdebate-preview:/i.test(a.href)&&!/^\\s*javascript:/i.test(a.getAttribute('href')))e.preventDefault()},true)</script>";

function guard(html) {
  const s = String(html);
  const at = /<head\b[^>]*>/i.exec(s) || /<!doctype[^>]*>/i.exec(s);
  return at ? s.slice(0, at.index + at[0].length) + GUARD + s.slice(at.index + at[0].length) : GUARD + s;
}

// The page around a video entry's file: plays at once, muted, looping.
function videoPage(file) {
  const src = encodeURI(file);
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<style>html,body{margin:0;height:100%;background:#000}video{display:block;width:100%;height:100%;object-fit:contain}</style>\n</head>\n<body>\n<video src="' +
    src.replace(/"/g, "%22") + '" autoplay muted loop playsinline controls></video>\n</body>\n</html>\n';
}

module.exports = { compose, videoPage, guard, cspFor, origin, CSP };

// ---- 3D model entries ----

// A model entry's page: its .glb in a 3D viewer (three.js, served by the app
// from /__jdebate/three/), drag to turn, wheel to zoom. With no .glb, its
// renders in a row.
function modelCsp(entryOrigin) {
  const o = entryOrigin;
  return "default-src 'none'; script-src 'unsafe-inline' " + o + "; style-src 'unsafe-inline' " + o + "; img-src data: blob: " + o + "; connect-src " + o + " data: blob:; worker-src blob:; font-src data:; form-action 'none'; base-uri " + o;
}

function modelPage(glb, images) {
  const esc = (s) => JSON.stringify(String(s)).replace(/</g, "\u003c");
  if (!glb) {
    const imgs = (images || []).map((p) => '<figure><img src="' + encodeURI(p).replace(/"/g, "%22") + '" alt=""><figcaption></figcaption></figure>').join("");
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>html,body{margin:0;background:#2b2e34;color:#ddd;font:13px system-ui}main{display:flex;flex-wrap:wrap;gap:8px;padding:8px;justify-content:center}img{max-width:100%;max-height:92vh;display:block}figure{margin:0;flex:1 1 300px}p{padding:24px;text-align:center}</style></head><body><main>' +
      (imgs || "<p>No images.</p>") + "</main></body></html>";
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#2b2e34;font:12px system-ui,sans-serif;color:#e8e8e8}
canvas{display:block;width:100%;height:100%;touch-action:none}
#bar{position:fixed;left:8px;bottom:8px;display:flex;gap:6px;align-items:center}
#bar button{font:inherit;color:inherit;background:rgba(20,22,26,.72);border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:5px 9px;cursor:pointer}
#bar button[aria-pressed=true]{background:rgba(255,255,255,.2)}
#info{position:fixed;right:8px;bottom:8px;background:rgba(20,22,26,.72);padding:5px 8px;border-radius:7px}
#msg{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none}
</style>
<script>
// If three.js or a loader cannot load, the module below never runs. Say so
// at once, so Background load moves on instead of waiting out its timeout.
addEventListener("error", (e) => {
  if (!(e.target instanceof HTMLScriptElement) || window.__told) return;
  window.__told = true;
  document.getElementById("msg").textContent = "Could not load the 3D viewer.";
  try { parent.postMessage({ jdebate: "model-error" }, "*"); } catch {}
}, true);
</script>
<script type="importmap">{"imports":{"three":"/__jdebate/three/build/three.module.min.js","three/addons/":"/__jdebate/three/examples/jsm/"}}</script>
</head><body>
<div id="msg">Loading model…</div>
<div id="bar"><button id="spin" aria-pressed="true">Turn</button><button id="wire" aria-pressed="false">Wireframe</button><button id="reset">Reset view</button></div>
<div id="info"></div>
<script type="module">
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b2e34);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3128, 1.4));
const key = new THREE.DirectionalLight(0xfff2e0, 2.4); key.position.set(4, 8, 6); scene.add(key);
const rim = new THREE.DirectionalLight(0xc8d8ff, 1.2); rim.position.set(-6, 4, -5); scene.add(rim);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 1.2;
let home = null; let model = null;
function size() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener("resize", size); size();
function frameIt() {
  const box = new THREE.Box3().setFromObject(model); const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.length() / 2, 0.01); const d = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  camera.position.copy(c).add(new THREE.Vector3(0.7, 0.45, 1).normalize().multiplyScalar(d)); camera.near = d / 200; camera.far = d * 50; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update(); home = { p: camera.position.clone(), t: c.clone() };
  const grid = new THREE.GridHelper(Math.ceil(Math.max(s.x, s.z) * 1.6), 16, 0x666a72, 0x44474e); grid.position.set(c.x, box.min.y, c.z); scene.add(grid);
  let tris = 0; model.traverse((o) => { if (o.isMesh) { const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  document.getElementById("info").textContent = s.x.toFixed(1) + " × " + s.y.toFixed(1) + " × " + s.z.toFixed(1) + " studs · " + Math.round(tris).toLocaleString() + " triangles";
}
// Tells the app when the model is drawn, so Background load knows this frame
// is ready to show. Not from requestAnimationFrame: Chromium pauses that in
// frames parked off screen. One render while hidden uploads the buffers.
const tell = (state) => { try { parent.postMessage({ jdebate: state }, "*"); } catch {} };
new GLTFLoader().load(${esc(encodeURI(glb))}, (g) => { model = g.scene; scene.add(model); frameIt(); renderer.compile(scene, camera); renderer.render(scene, camera); document.getElementById("msg").remove(); setTimeout(() => tell("model-ready"), 0); },
  undefined, (e) => { document.getElementById("msg").textContent = "Could not load the model: " + (e && e.message || e); tell("model-error"); });
const spin = document.getElementById("spin"), wire = document.getElementById("wire");
spin.onclick = () => { controls.autoRotate = !controls.autoRotate; spin.setAttribute("aria-pressed", String(controls.autoRotate)); };
wire.onclick = () => { const on = wire.getAttribute("aria-pressed") !== "true"; wire.setAttribute("aria-pressed", String(on)); model && model.traverse((o) => { if (o.isMesh) [].concat(o.material).forEach((m) => { m.wireframe = on; }); }); };
document.getElementById("reset").onclick = () => { if (home) { camera.position.copy(home.p); controls.target.copy(home.t); controls.update(); } };
renderer.domElement.addEventListener("pointerdown", () => { controls.autoRotate = false; spin.setAttribute("aria-pressed", "false"); });
(function loop() { requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();
</script>
</body></html>
`;
}

module.exports.modelPage = modelPage;
module.exports.modelCsp = modelCsp;

// ---- App icon entries ----

// An icon entry's page, made by JDebate so every entry is shown the same way:
// large, at each Windows size on dark and light, 16 and 32 px blown up pixel
// by pixel, and in a taskbar, title bar and desktop shortcut. The SVG is only
// ever an <img>, so nothing in it runs.
function iconPage(svg, name) {
  const src = "data:image/svg+xml;base64," + Buffer.from(String(svg || ""), "utf8").toString("base64");
  const label = String(name || "App").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const img = (px, cls) => '<img src="' + src + '" width="' + px + '" height="' + px + '" alt=""' + (cls ? ' class="' + cls + '"' : "") + ">";
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const row = (cls) => '<div class="row ' + cls + '">' + sizes.map((s) => '<figure>' + img(s) + "<figcaption>" + s + "</figcaption></figure>").join("") + "</div>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}
html,body{margin:0;background:#16181d;color:#c9ccd3;font:12px/1.4 "Segoe UI",system-ui,sans-serif}
main{display:grid;gap:14px;padding:16px;max-width:1180px;margin:0 auto}
.top{display:grid;grid-template-columns:auto 1fr;gap:14px;align-items:stretch}
.hero{display:grid;place-items:center;padding:20px;border-radius:10px;background:#0f1115;border:1px solid #2a2e36}
.hero img{width:min(384px,70vw);height:auto}
.side{display:grid;gap:14px;align-content:start}
.box{border-radius:10px;border:1px solid #2a2e36;overflow:hidden}
.box h2{margin:0;padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:.04em;color:#8b909a;background:#1c1f25;border-bottom:1px solid #2a2e36}
.row{display:flex;align-items:flex-end;justify-content:space-around;gap:10px;padding:16px 12px 10px;flex-wrap:wrap}
.row.dark{background:#0d1117}.row.light{background:#f3f4f6;color:#555}
figure{margin:0;display:grid;justify-items:center;gap:6px}
figcaption{font-size:10px;opacity:.7}
.zoom{display:flex;gap:18px;padding:14px;justify-content:center;background:#0d1117;flex-wrap:wrap}
.zoom canvas{width:160px;height:160px;image-rendering:pixelated;border:1px solid #2a2e36;border-radius:6px;background:#202020}
.zoom canvas.l{background:#f3f4f6}
.win{background:linear-gradient(135deg,#1d3557,#2b4c6f 55%,#3d5a80);padding:14px 14px 0;display:grid;gap:12px}
.titlebar{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;background:#202020;color:#fff;border-radius:8px 8px 0 0;width:min(420px,100%)}
.titlebar span{font-size:12px}
.titlebar i{margin-left:auto;letter-spacing:14px;color:#aaa;font-style:normal}
.desk{display:flex;gap:6px}
.shortcut{width:76px;display:grid;justify-items:center;gap:4px;padding:6px 2px;color:#fff;text-align:center;font-size:11px;text-shadow:0 1px 2px #000;border-radius:4px}
.shortcut.sel{background:rgba(255,255,255,.18);outline:1px solid rgba(255,255,255,.35)}
.taskbar{display:flex;align-items:center;justify-content:center;gap:4px;height:48px;margin:0 -14px;background:rgba(32,32,32,.94);border-top:1px solid #3a3a3a}
.taskbar b{display:grid;place-items:center;width:40px;height:40px;border-radius:4px}
.taskbar b.on{background:rgba(255,255,255,.08);position:relative}
.taskbar b.on::after{content:"";position:absolute;bottom:2px;width:16px;height:3px;border-radius:2px;background:#60cdff}
.ghost{width:24px;height:24px;border-radius:4px;background:#5c6370}
.taskbar.light{background:rgba(243,243,243,.96);border-top-color:#ddd}
@media (max-width:760px){.top{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<div class="top">
<div class="hero">${img(384)}</div>
<div class="side">
<div class="box"><h2>16 AND 32 PX, PIXEL BY PIXEL</h2><div class="zoom"><canvas width="16" height="16" data-s="16"></canvas><canvas width="32" height="32" data-s="32"></canvas><canvas class="l" width="16" height="16" data-s="16"></canvas><canvas class="l" width="32" height="32" data-s="32"></canvas></div></div>
<div class="box"><h2>WINDOWS</h2><div class="win">
<div class="titlebar">${img(16)}<span>${label}</span><i>–▢✕</i></div>
<div class="desk"><div class="shortcut sel">${img(48)}<span>${label}</span></div><div class="shortcut">${img(48)}<span>${label}</span></div></div>
<div class="taskbar"><b><span class="ghost"></span></b><b><span class="ghost"></span></b><b class="on">${img(24)}</b><b><span class="ghost"></span></b></div>
<div class="taskbar light"><b><span class="ghost"></span></b><b class="on">${img(24)}</b><b><span class="ghost"></span></b></div>
</div></div>
</div>
</div>
<div class="box"><h2>SIZES ON DARK</h2>${row("dark")}</div>
<div class="box"><h2>SIZES ON LIGHT</h2>${row("light")}</div>
</main>
<script>
const im = new Image();
im.onload = () => { for (const c of document.querySelectorAll("canvas[data-s]")) { const s = +c.dataset.s; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(im, 0, 0, s, s); } };
im.src = ${JSON.stringify(src)};
</script>
</body>
</html>
`;
}

module.exports.iconPage = iconPage;
