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
new GLTFLoader().load(${esc(encodeURI(glb))}, (g) => { model = g.scene; scene.add(model); frameIt(); document.getElementById("msg").remove(); },
  undefined, (e) => { document.getElementById("msg").textContent = "Could not load the model: " + (e && e.message || e); });
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
