"use strict";

// JDebate window. Pages: Battles (a dashboard with every battle and the
// entries coming in live), one page per battle with its entries running, one
// page per entry with the preview and its code side by side, and Agents
// (install the jdebate MCP server).

window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

const api = window.jdebate;
const $main = document.getElementById("main");
const $dlg = document.getElementById("new-dlg");
const $toast = document.getElementById("toast");

// page: "battles" | "agents" | "battle:<id>" | "entry:<id>"
// --page battle-<id> in smoke runs (a colon in an argument reads as a URL to Electron).
let page = (new URLSearchParams(location.search).get("page") || "battles").replace(/^(battle|entry)-/, "$1:");
let battles = [];
let feed = { recent: [], today: 0, total: 0 }; // the newest entries in every battle
let inst = null; // install state
let stamp = -1;
let busy = false;
let flash = null; // {text}: an error, shown until dismissed
let theme = "system";

// Battles page view state.
let filter = "all";
let query = "";
// Battle page: card width in px.
let cardW = 300;

// ---- DOM helpers ----
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function icon(d, size, fill) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", fill ? "currentColor" : "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linejoin", "round");
  p.setAttribute("stroke-linecap", "round");
  svg.append(p);
  return svg;
}

const I = {
  battles: "M3 4h9v7H7l-3 3v-3H3zM12 8h5v7h-1v3l-3-3H9v-2",
  agents: "M4 4h12v9H4zM8 17h4M10 13v4",
  warn: "M10 3l8 14H2zM10 8v4M10 14.5v.5",
  left: "M12 4l-6 6 6 6",
  right: "M8 4l6 6-6 6",
  copy: "M7 7h9v10H7zM4 13V3h9",
  folder: "M3 5h5l2 2h7v9H3z",
  video: "M3 6h10v8H3zM13 9l4-2v6l-4-2",
  star: "M10 2.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.7z",
  plus: "M10 4v12M4 10h12",
  search: "M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM12.5 12.5L17 17",
  inbox: "M3 11h4l1.5 2.5h3L13 11h4M5 4h10l2 7v5H3v-5z",
  open: "M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10zM10 7.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z",
  reload: "M16.5 10A6.5 6.5 0 1 1 14.6 5.4M16.5 2.5v4h-4",
  cols: "M2.5 3.5h15v13h-15zM10 3.5v13",
  rows: "M2.5 3.5h15v13h-15zM2.5 10h15",
  full: "M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5",
  unfull: "M7.5 3v4.5H3M17 7.5h-4.5V3M12.5 17v-4.5H17M3 12.5h4.5V17",
  lock: "M4.5 9h11v8h-11zM7 9V6.5a3 3 0 0 1 6 0V9",
  sun: "M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4",
  moon: "M16.5 12A7 7 0 0 1 8 3.5a7 7 0 1 0 8.5 8.5z",
  auto: "M10 2.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zM10 2.5v15",
};

function focusLater(key) {
  queueMicrotask(() => {
    const el = [...document.querySelectorAll("[data-focus-key]")].find((x) => x.dataset.focusKey === key);
    if (el) el.focus();
  });
}

const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const hr = Math.round(m / 60);
  if (hr < 24) return hr + " h ago";
  const d = Math.round(hr / 24);
  if (d === 1) return "yesterday";
  return d < 7 ? d + " days ago" : when(t);
}
// "Claude Code (claude-opus-5-5)" -> "CC", "Droid-3 (GPT-6.1 Sol)" -> "D3".
function initials(name) {
  const words = String(name || "?").replace(/\(.*?\)/g, " ").split(/[\s\-_]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}

// ---- Messages ----

let toastTimer = 0;
// A short note at the bottom, with an optional action such as Undo or View.
function toast(text, action) {
  clearTimeout(toastTimer);
  $toast.replaceChildren(h("span", { text }), action ? h("button", { type: "button", onclick: () => { $toast.classList.remove("on"); action.fn(); } }, action.label) : null);
  $toast.classList.add("on");
  toastTimer = setTimeout(() => $toast.classList.remove("on"), action ? 6000 : 3500);
}

function flashView() {
  if (!flash) return null;
  return h("div", { class: "error-box", role: "alert" },
    icon(I.warn),
    h("span", { class: "grow", text: flash.text }),
    h("button", { class: "btn small quiet", onclick: () => { flash = null; render(); } }, "Dismiss"),
  );
}

// Runs one change. okText (or a function of the result) goes to a toast,
// with undo as its action when given; a failure stays on the page.
async function act(work, okText, undo) {
  if (busy) return;
  busy = true;
  flash = null;
  render();
  try {
    const out = await work();
    if (okText) toast(typeof okText === "function" ? okText(out) : okText, undo ? { label: "Undo", fn: () => act(undo) } : null);
  } catch (e) {
    flash = { text: e.message };
  }
  busy = false;
  await refresh(true);
}

function go(p) {
  page = p;
  flash = null;
  confirm = null;
  editing = null;
  mounted = null;
  render();
  $main.scrollTop = 0;
}

// ---- Sidebar ----

const presentAgents = () => (inst ? inst.agents.filter((a) => a.present) : []);
const readyAgents = () => (inst ? inst.agents.filter((a) => a.installed && a.enabled && !(a.errors && a.errors.length)) : []);

function renderSide() {
  const found = presentAgents().length || (inst ? inst.agents.length : 0);
  const items = [
    { id: "battles", label: "Battles", d: I.battles, count: String(battles.length) },
    { id: "agents", label: "Agents", d: I.agents, count: inst ? readyAgents().length + " of " + found : null },
  ];
  const onPage = (id) => page === id || (id === "battles" && /^(battle|entry):/.test(page) && !openBattles().some((b) => isBattlePage(b.id)));
  document.getElementById("nav-pages").replaceChildren(
    ...items.map((p) => h("button", { class: "nav-item" + (onPage(p.id) ? " on" : ""), "aria-current": onPage(p.id) ? "page" : null, onclick: () => go(p.id) }, icon(p.d), h("span", { class: "grow", text: p.label }), p.count !== null ? h("span", { class: "count", text: p.count }) : null)),
  );
  const open = openBattles();
  document.getElementById("nav-open-label").hidden = !open.length;
  document.getElementById("nav-battles").replaceChildren(
    ...open.map((b) => h("button", { class: "nav-item sub" + (isBattlePage(b.id) ? " on" : ""), "aria-current": isBattlePage(b.id) ? "page" : null, title: b.title, onclick: () => go("battle:" + b.id) }, h("span", { class: "grow", text: b.title }), h("span", { class: "count", text: String(b.entries) }))),
  );
  const foot = [themeButton()];
  if (inst) foot.push(h("div", { class: "side-line", text: "jdebate server v" + (inst.installed || inst.latest) + ", in " + plural(readyAgents().length, "agent", "agents") }));
  const upd = appUpdateView();
  if (upd) foot.push(upd);
  document.getElementById("side-foot").replaceChildren(...foot);
}

const THEMES = { system: [I.auto, "Theme: System"], light: [I.sun, "Theme: Light"], dark: [I.moon, "Theme: Dark"] };
function themeButton() {
  const [d, label] = THEMES[theme] || THEMES.system;
  return h("button", { class: "nav-item", title: "Switch between system, light and dark", onclick: async () => {
    const next = { system: "light", light: "dark", dark: "system" }[theme] || "system";
    try {
      theme = await api.setTheme(next);
    } catch (e) {
      flash = { text: e.message };
    }
    render();
  } }, icon(d), h("span", { class: "grow", text: label }));
}

// ---- JDebate updates (GitHub Releases) ----

let appUpd = null; // {status, version, latest, percent, error}
let appUpdErr = "";

function appUpdateAct(fn) {
  appUpdErr = "";
  fn().catch((e) => ((appUpdErr = e.message), renderSide()));
}

function appUpdateView() {
  const u = appUpd;
  if (!u) return null;
  const line = (text, cls) => h("div", { class: cls || "", text });
  const btn = (label, onclick, primary) => h("button", { class: "btn small" + (primary ? " primary" : ""), onclick }, label);
  const kids = [line("JDebate " + u.version, "side-ver")];
  if (u.status === "source") {
    kids.push(line("Running from source. Install JDebate from GitHub Releases to update here."));
    kids.push(btn("Releases", () => appUpdateAct(api.appUpdate.releases)));
  } else if (u.status === "checking") {
    kids.push(line("Checking for updates…"));
  } else if (u.status === "available") {
    kids.push(line("JDebate " + u.latest + " is out."));
    kids.push(btn("Update", () => appUpdateAct(api.appUpdate.download), true));
  } else if (u.status === "downloading") {
    kids.push(line("Downloading " + u.latest + ": " + u.percent + "%"));
  } else if (u.status === "ready") {
    kids.push(line("JDebate " + u.latest + " is ready. JDebate closes, updates and opens again."));
    kids.push(btn("Restart to update", () => appUpdateAct(api.appUpdate.install), true));
  } else if (u.status === "installing") {
    kids.push(line("Installing JDebate " + u.latest + ". JDebate closes now, a small window shows the install, then JDebate opens again by itself."));
  } else {
    if (u.status === "current") kids.push(line("Up to date."));
    if (u.status === "error") kids.push(line(u.error, "bad"));
    kids.push(btn(u.status === "error" ? "Try again" : "Check for updates", () => appUpdateAct(api.appUpdate.check)));
  }
  if (appUpdErr) kids.push(line(appUpdErr, "bad"));
  return h("div", { class: "side-upd", role: "status", "aria-label": "JDebate updates" }, kids);
}

api.appUpdate.onChange((s) => {
  appUpd = s;
  renderSide();
});

const openBattles = () => battles.filter((b) => b.status === "open");

function isBattlePage(bid) {
  if (page === "battle:" + bid) return true;
  return page.startsWith("entry:") && entryView && entryView.battle_id === bid;
}

// ---- Open a battle (dialog) ----

const blankDraft = () => ({ title: "", task: "", kind: "page", videoSeconds: "30", videoSize: "1280x720" });
let draft = blankDraft();
let draftErr = "";

// What each kind of battle asks agents for.
const KINDS = [
  { id: "page", label: "Page", hint: "One page in HTML, CSS and JS.", title: "Weather card", task: "Build a weather card for one city with a 5 day forecast. Plain HTML, CSS and JS. It should look good at 360 px and 1280 px wide." },
  { id: "website", label: "Website", hint: "A whole site with pages, styles, scripts and images. Agents build it in a folder and send the folder.", title: "Bakery website", task: "Make a website for a small bakery: a home page, a menu page and a contact page, with a shared header and footer. It must work on a phone and on a 1280 px screen." },
  { id: "video", label: "Video", hint: "A clip. Agents send an animation page that JDebate records, or a video file they made.", title: "30 second product demo", task: "Make a 30 second demo video for JVoice. Show what it does in three steps, with large readable text and a clear ending." },
];
const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
const SIZES = [["1280x720", "Wide (16:9)"], ["1080x1920", "Tall (9:16)"], ["1080x1080", "Square"]];
const sizeName = (s) => (SIZES.find((x) => x[0] === s) || [s, s])[1];
const kindLine = (b) => (b.kind === "website" ? "Website" : b.kind === "video" ? "Video, " + b.video_seconds + " s, " + sizeName(b.video_size).toLowerCase() : "Page");

function seg(items, value, onpick, label, role) {
  return h("div", { class: "seg", role: role || "group", "aria-label": label }, items.map(([k, text, aria]) =>
    h("button", { type: "button", "aria-pressed": role ? null : String(value === k), role: role ? "radio" : null, "aria-checked": role ? String(value === k) : null, "aria-label": aria || null, onclick: () => onpick(k) }, text)));
}

// The fields that go with a kind: length and shape for a video.
// v holds { videoSeconds, videoSize }.
function kindFields(kind, v, labels) {
  if (kind === "video") {
    return h("div", { class: "field-row" },
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Length in seconds" }),
        h("input", { type: "text", "aria-label": labels + "Length", inputmode: "numeric", class: "short", value: String(v.videoSeconds), oninput: (e) => { v.videoSeconds = e.target.value; } })),
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Shape" }),
        h("select", { "aria-label": labels + "Shape", onchange: (e) => { v.videoSize = e.target.value; } }, SIZES.map(([val, name]) => h("option", { value: val, selected: v.videoSize === val }, name + ", " + val.replace("x", " × "))))),
    );
  }
  return null;
}

function renderDialog() {
  const k = kindOf(draft.kind);
  $dlg.replaceChildren(h("form", { onsubmit: (e) => { e.preventDefault(); openBattle(); } },
    h("h2", { text: "Open a battle" }),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Kind" }), seg(KINDS.map((x) => [x.id, x.label]), draft.kind, (id) => { draft.kind = id; renderDialog(); }, "Kind of battle", "radiogroup"), h("span", { class: "hint", text: k.hint })),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Title" }),
      h("input", { type: "text", "aria-label": "Title", "data-focus-key": "new-title", maxlength: "200", placeholder: k.title, value: draft.title, oninput: (e) => { draft.title = e.target.value; } })),
    kindFields(draft.kind, draft, ""),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Task for the agents ", h("span", { class: "hint", text: "What every agent should build. Plain words work best." })),
      h("textarea", { "aria-label": "Task", rows: "6", placeholder: k.task, oninput: (e) => { draft.task = e.target.value; } }, draft.task)),
    draftErr ? h("p", { class: "err", role: "alert" }, icon(I.warn, 14), draftErr) : null,
    h("p", { class: "hint", text: "Agents see this task through the jdebate MCP server. Each one must build its own entry; copies are turned away." }),
    h("div", { class: "row-actions end" },
      h("button", { class: "btn quiet", type: "button", onclick: () => $dlg.close() }, "Cancel"),
      h("button", { class: "btn primary", type: "submit", disabled: busy }, busy ? "Working…" : "Open battle")),
  ));
}

function showNew() {
  draftErr = "";
  renderDialog();
  if (!$dlg.open) $dlg.showModal();
  focusLater("new-title");
}

function openBattle() {
  if (!draft.title.trim() || !draft.task.trim()) {
    draftErr = !draft.title.trim() ? "Add a title." : "Add a task so agents know what to build.";
    renderDialog();
    focusLater("new-title");
    return;
  }
  const d = { title: draft.title, task: draft.task, kind: draft.kind };
  if (draft.kind === "video") Object.assign(d, { videoSeconds: draft.videoSeconds, videoSize: draft.videoSize });
  busy = true;
  renderDialog();
  api.openBattle(d).then(async (b) => {
    busy = false;
    draft = blankDraft();
    $dlg.close();
    go("battle:" + b.id);
    toast("Battle " + b.num + " is open. Copy the agent prompt and give it to your agents.");
    await refresh(true);
  }, (e) => {
    busy = false;
    draftErr = e.message;
    renderDialog();
  });
}

// ---- Battles page ----

function installStrip() {
  if (!inst || inst.agents.some((a) => a.installed)) return null;
  return h("section", { class: "strip" },
    icon(I.warn),
    h("div", { class: "strip-text" }, h("strong", { text: "No agent has the jdebate MCP server yet." }), h("span", { class: "hint", text: "Agents need it to read battles and send entries." })),
    h("button", { class: "btn", onclick: () => go("agents") }, "Set up agents"),
  );
}

function head(title, sub, actions, crumb) {
  return h("div", { class: "page-head" },
    h("div", { class: "head-text" },
      crumb ? h("div", { class: "crumb" }, h("button", { class: "link", onclick: crumb.go }, crumb.label), icon(I.right, 12), h("span", { text: crumb.here })) : null,
      h("h1", { text: title }),
      sub ? h("p", { text: sub }) : null,
    ),
    actions ? h("div", { class: "actions" }, actions) : null,
  );
}

function battlesPage() {
  const open = openBattles();
  const found = presentAgents().length || (inst ? inst.agents.length : 0);
  const ready = readyAgents().length;
  const newest = feed.recent[0];
  const stat = (n, label, hint, onclick, disabled) => h("button", { class: "panel stat", type: "button", disabled, onclick }, h("span", { class: "n", text: n }), h("span", { class: "l", text: label }), h("span", { class: "hint", text: hint }));
  const stats = h("div", { class: "stats" },
    stat(String(open.length), "Open battles", open.length ? "Show open only" : "None open", () => { filter = "open"; render(); }),
    stat(String(feed.today), "Entries today", newest ? "Open the newest entry" : "No entries yet", () => newest && go("entry:" + newest.id), !newest),
    stat(inst ? ready + " of " + found : "…", "Agents ready", inst && ready < found ? "Set up the rest" : "All set", () => go("agents")),
  );

  const q = query.trim().toLowerCase();
  const list = battles.filter((b) => filter === "all" || b.status === filter).filter((b) => !q || (b.title + " " + b.task).toLowerCase().includes(q));
  const rows = list.map((b) =>
    h("button", { class: "brow", onclick: () => go("battle:" + b.id) },
      h("span", { class: "bnum", text: String(b.num) }),
      h("span", { class: "bmain" },
        h("span", { class: "btitle", text: b.title }),
        h("span", { class: "bdesc", text: b.winner ? "Winner: entry " + b.winner.num + ", " + b.winner.title + ", by " + b.winner.agent : b.task.replace(/\s+/g, " ").slice(0, 200) })),
      h("span", { class: "bmeta" },
        b.kind && b.kind !== "page" ? h("span", { text: kindOf(b.kind).label }) : null,
        b.agents && b.agents.length ? h("span", { class: "thumbs", title: b.agents.join(", ") }, b.agents.slice(0, 4).map((a) => h("i", { text: initials(a) }))) : null,
        h("span", { class: "tnum", text: plural(b.entries, "entry", "entries") }),
        h("span", { class: "st" + (b.status === "open" ? " open" : ""), text: b.status === "open" ? "Open" : "Closed" }),
        h("span", { class: "go" }, icon(I.right, 14))),
    ));
  const emptyList = battles.length
    ? h("div", { class: "empty" }, h("span", { class: "ico" }, icon(I.search, 20)), h("h3", { text: "No battles match" }), h("p", { text: q ? "Nothing matches \"" + query + "\"." : "There are no " + filter + " battles." }), h("button", { class: "btn", type: "button", onclick: () => { filter = "all"; query = ""; render(); } }, "Show all battles"))
    : h("div", { class: "empty" }, h("span", { class: "ico" }, icon(I.inbox, 20)), h("h3", { text: "No battles yet" }), h("p", { text: "Open one with a task, then tell your agents to join it." }), h("button", { class: "btn primary", type: "button", onclick: showNew }, icon(I.plus, 14), "Open battle"));

  let group = "";
  const tl = [];
  for (const e of feed.recent.slice(0, 14)) {
    const g = Date.now() - e.created_at < 86400000 ? "Today" : "Earlier";
    if (g !== group) tl.push(h("h4", { text: g }));
    group = g;
    tl.push(h("button", { class: "ti" + (fresh.has(e.id) ? " fresh" : ""), onclick: () => go("entry:" + e.id) },
      h("span", { class: "av", text: initials(e.agent) }),
      h("span", { class: "tt" }, h("b", { text: e.agent }), " sent entry " + e.num, h("small", { text: "Battle " + e.battle_num + ": " + e.battle_title + " · " + ago(e.created_at) }))));
  }

  return h("div", { class: "page" },
    head("Battles", plural(open.length, "open battle", "open battles") + " · " + plural(feed.total, "entry", "entries") + " in all", [
      h("button", { class: "btn primary", onclick: showNew }, icon(I.plus, 14), "Open battle"),
    ]),
    installStrip(),
    flashView(),
    stats,
    h("div", { class: "dash" },
      h("section", {},
        h("div", { class: "toolbar" },
          seg([["all", "All"], ["open", "Open"], ["closed", "Closed"]], filter, (f) => { filter = f; render(); }, "Filter"),
          h("label", { class: "search" }, icon(I.search, 15), h("input", { type: "text", "aria-label": "Search battles", placeholder: "Search battles", value: query, oninput: (e) => { query = e.target.value; render(); } }))),
        h("div", { class: "panel blist" }, rows.length ? rows : emptyList)),
      h("section", {},
        h("div", { class: "section-head" }, h("h2", { text: "Incoming entries" }), h("span", { class: "note", text: "Live" })),
        h("div", { class: "panel tl" }, tl.length ? tl : h("div", { class: "empty" }, h("span", { class: "ico" }, icon(I.inbox, 20)), h("h3", { text: "No entries yet" }), h("p", { text: "Entries show up here the moment agents send them." })))),
    ),
  );
}

// ---- Battle page ----
//
// Built once per battle, then patched: entry frames are only created for new
// entries, so an entry you are trying out does not reload when another one
// comes in.

let mounted = null; // {bid, root, parts, cards: Map(id -> {el, sig})}
let battleData = null; // {battle, entries}
let editing = null; // {title, task}
let confirm = null; // {kind: "battle"|"entry", id}
let showPrompt = false;

function agentPrompt(b) {
  const what = b.kind === "website"
    ? " It is a website: build it in a folder and send the folder."
    : b.kind === "video" ? " It is a " + b.video_seconds + " second video: send an animation page or a video file you made." : "";
  return "Join JDebate battle " + b.num + " (\"" + b.title + "\")." + what + " Use the jdebate MCP tools: read the task with battle_read " + b.num + ", build your entry yourself from scratch, then send it with prepare_submission and submit. Do not copy, fork or clone anyone else's work.";
}

// How entries are shown. page: a 1200 px wide page scaled down in cards, as
// is when big. website: a 1280 px wide screen scaled to fit. video: the
// battle's frame size, letterboxed.
function viewOf(b, opts) {
  const o = opts || {};
  if (b && b.kind === "website") return o.phone ? { mode: "phone", w: 390 } : { mode: "width", w: 1280, h: 800 };
  if (b && b.kind === "video") {
    const [w, hh] = b.video_size.split("x").map(Number);
    return { mode: "contain", w, h: hh };
  }
  if (o.card) return { mode: "width", w: 1200 };
  if (o.device === "tablet") return { mode: "phone", w: 768 };
  if (o.device === "phone") return { mode: "phone", w: 390 };
  return null;
}

function battleHead(b) {
  const open = b.status === "open";
  return head(b.title, (open ? "Open" : "Closed") + " · opened " + ago(b.created_at) + " · " + plural(b.entries, "entry", "entries") + " · " + kindLine(b), [
    open
      ? h("button", { class: "btn quiet", disabled: busy, onclick: () => act(() => api.closeBattle(b.id), "Battle closed. Agents can now read every entry's code with battle_results.", () => api.reopenBattle(b.id)) }, icon(I.lock, 14), "Close battle")
      : null,
    h("button", { class: "btn quiet", disabled: busy, onclick: () => { editing = { title: b.title, task: b.task, videoSeconds: b.video_seconds, videoSize: b.video_size }; render(); focusLater("edit-title"); } }, "Edit"),
    h("button", { class: "btn quiet danger", disabled: busy, onclick: () => { confirm = { kind: "battle", id: b.id }; render(); focusLater("confirm-cancel"); } }, "Delete"),
    open
      ? h("button", { class: "btn primary", disabled: busy, onclick: () => act(() => api.copy(agentPrompt(b)), "Agent prompt copied. Paste it into each agent you want in this battle.") }, icon(I.copy, 14), "Copy agent prompt")
      : h("button", { class: "btn primary", disabled: busy, onclick: () => act(() => api.reopenBattle(b.id), "Battle open again.") }, "Reopen battle"),
  ], { label: "Battles", here: "Battle " + b.num, go: () => go("battles") });
}

function taskPanel(b) {
  if (editing) {
    const save = () => {
      const patch = { title: editing.title, task: editing.task };
      if (b.kind === "video") Object.assign(patch, { videoSeconds: editing.videoSeconds, videoSize: editing.videoSize });
      return api.editBattle(b.id, patch);
    };
    return h("form", { class: "panel panel-pad", onsubmit: (e) => { e.preventDefault(); act(async () => { await save(); editing = null; }, "Saved."); } },
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Title" }), h("input", { type: "text", "aria-label": "Edit title", "data-focus-key": "edit-title", value: editing.title, oninput: (e) => { editing.title = e.target.value; } })),
      kindFields(b.kind, editing, "Edit "),
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Task" }), h("textarea", { "aria-label": "Edit task", rows: "6", oninput: (e) => { editing.task = e.target.value; } }, editing.task)),
      h("div", { class: "row-actions" }, h("button", { class: "btn primary", type: "submit", disabled: busy }, "Save"), h("button", { class: "btn", type: "button", onclick: () => { editing = null; render(); } }, "Cancel")),
    );
  }
  return h("section", { class: "panel task" },
    h("div", { class: "task-main" }, h("span", { class: "label", text: "Task" }), h("p", { class: "task-text", text: b.task })),
    h("button", { class: "btn small quiet", "aria-expanded": String(showPrompt), onclick: () => { showPrompt = !showPrompt; render(); } }, showPrompt ? "Hide prompt" : "Show prompt"),
    showPrompt ? h("div", { class: "prompt mono", text: agentPrompt(b) }) : null,
  );
}

function winnerBanner(b) {
  if (!b.winner) return null;
  const e = battleData.entries.find((x) => x.id === b.winner_id);
  return h("section", { class: "panel winner-bar" },
    icon(I.star, 16, true),
    h("span", { class: "grow" }, h("b", { text: b.winner.agent }), " won with entry " + b.winner.num + ", " + b.winner.title),
    e ? h("button", { class: "btn small", onclick: () => go("entry:" + e.id) }, "View entry") : null,
  );
}

function confirmView(b) {
  if (!confirm || confirm.kind !== "battle") return null;
  const back = () => { confirm = null; render(); };
  return h("div", { class: "warn-box", role: "alertdialog", "aria-label": "Delete battle", onkeydown: (e) => { if (e.key === "Escape") back(); } },
    icon(I.warn),
    h("p", { class: "grow", text: "Delete battle " + b.num + " and its " + plural(b.entries, "entry", "entries") + "? This cannot be undone." }),
    h("button", { class: "btn danger", disabled: busy, onclick: () => act(async () => { await api.removeBattle(b.id); confirm = null; page = "battles"; mounted = null; }, "Battle " + b.num + " deleted.") }, "Delete battle"),
    h("button", { class: "btn", "data-focus-key": "confirm-cancel", onclick: back }, "Cancel"),
  );
}

function matchNote(e, battleNum) {
  const m = e.matches && e.matches[0];
  if (!m) return null;
  return h("p", { class: "match", title: "Checked when the entry came in" }, icon(I.warn, 14), Math.round(m.score * 100) + "% like entry " + m.entry + " by " + m.agent + (m.battle !== battleNum ? " in battle " + m.battle : ""));
}

const pages = (e) => e.files.filter((f) => /\.html?$/i.test(f.path)).length;
const formatNote = (e) => (e.format === "site" ? " · " + plural(pages(e), "page", "pages") + ", " + plural(e.files.length, "file", "files") : e.format === "video" ? " · video file" : "");

function setWinner(b, e) {
  const prev = b.winner_id;
  const undo = () => api.setWinner(b.id, prev || null);
  if (b.winner_id === e.id) return act(() => api.setWinner(b.id, null), "Winner cleared.", undo);
  return act(() => api.setWinner(b.id, e.id), "Entry " + e.num + " is the winner.", undo);
}

function winButton(b, e, small) {
  const won = b.winner_id === e.id;
  return h("button", { class: "btn star" + (small ? " small" : won ? "" : " primary"), "aria-pressed": String(won), disabled: busy, title: won ? "Clear winner" : "Pick as winner", onclick: () => setWinner(b, e) },
    icon(I.star, 14, won), won ? "Winner" : small ? "Pick" : "Pick as winner");
}

function cardBody(e) {
  const b = battleData.battle;
  const asking = confirm && confirm.kind === "entry" && confirm.id === e.id;
  return h("div", { class: "ebody" },
    h("span", { class: "t", title: e.title, text: e.num + ". " + e.title }),
    h("span", { class: "m", text: e.agent + " · " + ago(e.created_at) + formatNote(e) }),
    matchNote(e, b.num),
    asking
      ? h("div", { class: "row-actions" },
          h("span", { class: "hint grow", text: "Remove this entry?" }),
          h("button", { class: "btn small danger", disabled: busy, onclick: () => act(async () => { await api.removeEntry(e.id); confirm = null; }, "Entry " + e.num + " removed.") }, "Remove"),
          h("button", { class: "btn small", "data-focus-key": "confirm-cancel", onclick: () => { confirm = null; render(); } }, "Cancel"))
      : h("div", { class: "row-actions" },
          winButton(b, e, true),
          h("button", { class: "btn small quiet", disabled: busy, title: "Open the folder with this entry's files", onclick: () => act(() => api.entryFolder(e.id)) }, icon(I.folder, 14), "Folder"),
          h("button", { class: "btn small quiet danger", "aria-label": "Remove entry " + e.num, disabled: busy, onclick: () => { confirm = { kind: "entry", id: e.id }; render(); focusLater("confirm-cancel"); } }, "Remove")),
  );
}

// Loads at once (frames are on screen, lazy only adds a wait). A frame that
// has not loaded in 3 seconds is loaded again; after two tries it says so
// and offers a reload instead of staying blank.
//
// view (from viewOf) renders the entry at a fixed size and scales it into
// the box: "width" fills the width and shows the top, "contain" fits all of
// it, "phone" is a fixed-width column.
//
// box.fullscreen() puts the running frame on the whole screen at its real
// size, no scaling, so sites that break when scaled down show as built.
function frame(id, label, view) {
  const src = "jdebate-preview://" + id + "/";
  const el = h("iframe", { class: "frame", src, sandbox: "allow-scripts", allow: "fullscreen", title: label, referrerpolicy: "no-referrer" });
  const note = h("div", { class: "frame-note", role: "status", hidden: true });
  const exit = h("button", { class: "btn small fs-exit", title: "Leave full screen (Esc)", onclick: () => document.exitFullscreen().catch(() => {}) }, icon(I.unfull, 14), "Exit full screen");
  const box = h("div", { class: "frame-box" + (view ? " " + view.mode : "") }, el, note, exit);
  if (view && view.mode !== "phone") {
    el.style.width = view.w + "px";
    const fit = () => {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      if (!bw || !bh) return;
      const s = view.mode === "contain" ? Math.min(bw / view.w, bh / view.h) : bw / view.w;
      const fh = view.mode === "contain" ? view.h : bh / s;
      el.style.height = fh + "px";
      el.style.transform = "translate(" + Math.max(0, (bw - view.w * s) / 2) + "px, " + Math.max(0, (bh - fh * s) / 2) + "px) scale(" + s + ")";
    };
    new ResizeObserver(fit).observe(box);
  } else if (view) el.style.width = view.w + "px";
  let tries = 0;
  let timer = 0;
  const load = () => {
    clearTimeout(timer);
    note.hidden = true;
    el.src = src + "?try=" + ++tries;
    watch();
  };
  const watch = () => {
    timer = setTimeout(() => {
      if (!el.isConnected) return;
      if (tries < 2) return load();
      note.hidden = false;
      note.replaceChildren(icon(I.warn, 14), h("span", { text: "This preview did not load." }), h("button", { class: "btn small", onclick: () => { tries = 0; load(); } }, "Reload"));
    }, 3000);
  };
  el.addEventListener("load", () => {
    clearTimeout(timer);
    note.hidden = true;
  });
  watch();
  box.reload = () => { tries = 0; load(); };
  box.fullscreen = () => box.requestFullscreen().then(() => el.focus(), (err) => { flash = { text: "Could not open full screen: " + err.message }; render(); });
  return box;
}

function card(e) {
  const b = battleData.battle;
  return h("article", { class: "panel ecard" + (b.winner_id === e.id ? " won" : ""), "data-entry": e.id },
    h("span", { class: "ribbon" }, icon(I.star, 13, true), "Winner"),
    h("div", { class: "thumb" + (b.kind === "video" ? " dark" : "") },
      frame(e.id, "Entry " + e.num + ": " + e.title, viewOf(b, { card: true })),
      h("button", { class: "over", "aria-label": "Open entry " + e.num, onclick: () => go("entry:" + e.id) }, h("span", {}, icon(I.open, 14), "Open entry"))),
    cardBody(e),
  );
}

function renderBattle() {
  const bid = page.slice("battle:".length);
  if (!battleData || battleData.battle.id !== bid) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: battleData === false ? "This battle is gone." : "Loading…" })));
    if (battleData !== false) loadPage();
    return;
  }
  const b = battleData.battle;
  if (!mounted || mounted.bid !== bid || !$main.contains(mounted.root)) {
    const parts = { head: h("div"), notes: h("div", { class: "stack" }), task: h("div"), winner: h("div"), entriesHead: h("div", { class: "section-head" }), grid: h("div", { class: "cards" }) };
    const root = h("div", { class: "page" }, parts.head, parts.notes, parts.task, parts.winner, h("section", { class: "section" }, parts.entriesHead, parts.grid));
    $main.replaceChildren(root);
    mounted = { bid, root, parts, cards: new Map() };
  }
  const p = mounted.parts;
  p.head.replaceChildren(battleHead(b));
  p.notes.replaceChildren(...[installStrip(), flashView(), confirmView(b)].filter(Boolean));
  if (!(editing && p.task.querySelector("form"))) p.task.replaceChildren(taskPanel(b));
  p.winner.replaceChildren(...[winnerBanner(b)].filter(Boolean));
  const n = battleData.entries.length;
  p.entriesHead.replaceChildren(
    h("h2", { text: "Entries" }),
    h("span", { class: "note grow", text: n ? plural(n, "entry", "entries") + ". Each runs in a sandbox with no network." + (b.status === "open" ? " New ones appear here as they arrive." : "") : "" }),
    n ? seg([[220, "S", "Card size small"], [300, "M", "Card size medium"], [420, "L", "Card size large"]], cardW, (v) => { cardW = v; render(); }, "Card size") : null,
  );
  p.grid.style.setProperty("--cardw", cardW + "px");
  // Keyed: keep each entry's frame, redraw only its text and buttons.
  const live = new Set(battleData.entries.map((e) => e.id));
  for (const [id, c] of mounted.cards) if (!live.has(id)) { c.el.remove(); mounted.cards.delete(id); }
  const empty = p.grid.querySelector(".cards-empty");
  if (empty && n) empty.remove();
  for (const e of battleData.entries) {
    const sig = JSON.stringify([e.title, e.agent, e.matches, b.winner_id === e.id, confirm && confirm.id === e.id, busy, ago(e.created_at)]);
    const have = mounted.cards.get(e.id);
    if (!have) {
      const el = card(e);
      if (fresh.has(e.id)) el.classList.add("fresh");
      p.grid.append(el);
      mounted.cards.set(e.id, { el, sig });
    } else if (have.sig !== sig) {
      have.el.classList.toggle("won", b.winner_id === e.id);
      have.el.querySelector(".ebody").replaceWith(cardBody(e));
      have.sig = sig;
    }
  }
  if (!n && !empty) {
    p.grid.append(h("div", { class: "panel empty cards-empty" },
      h("span", { class: "ico" }, icon(I.inbox, 20)),
      h("h3", { text: "No entries yet" }),
      h("p", { text: b.status === "open" ? "Copy the agent prompt and paste it into Claude Code, Codex, Cursor or any agent with jdebate installed. Entries show up here live." : "This battle closed with no entries." }),
      b.status === "open" ? h("div", { class: "row-actions center" }, h("button", { class: "btn", onclick: () => act(() => api.copy(agentPrompt(b)), "Agent prompt copied.") }, icon(I.copy, 14), "Copy agent prompt"), h("button", { class: "btn quiet", onclick: () => go("agents") }, "Check agents")) : null));
  }
}

// ---- Entry page ----

let entryView = null; // entry with code, or false when gone
let entryBattle = null; // {battle, entries} of its battle
let savingVideo = false;
let tab = "html";
let device = "fit"; // page: fit, tablet, phone. website: fit (desktop) or phone.
let stacked = false;
let split = 58;
let fileOpen = ""; // Files tab: the file shown
let fileText = null; // {eid, path, text}

const recordSeconds = (b) => (b && b.kind === "video" ? b.video_seconds : 30);
const recordHint = (b) => "Records the first " + recordSeconds(b) + " seconds to an MP4" + (b && b.kind === "video" ? " at " + b.video_size.replace("x", " × ") : "") + " you can upload to Reddit or YouTube";
const size = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
const lines = (s) => (s ? s.split("\n").length : 0);

function codeView(text) {
  return h("pre", { class: "code" }, h("code", {}, text.split("\n").map((l, i) => [h("span", { class: "ln", text: String(i + 1) }), l + "\n"])));
}

// A site's files on the left, the one picked on the right.
function filesView(e) {
  if (!fileOpen || !e.files.some((f) => f.path === fileOpen)) fileOpen = e.files[0].path;
  const f = e.files.find((x) => x.path === fileOpen);
  let body;
  if (fileText && fileText.eid === e.id && fileText.path === f.path) {
    body = fileText.text === null ? h("p", { class: "empty", text: f.path + " is not text (" + f.type + ", " + size(f.size) + ")." }) : codeView(fileText.text);
  } else {
    body = h("p", { class: "empty", text: "Loading…" });
    api.entryText(e.id, f.path).then((text) => { fileText = { eid: e.id, path: f.path, text }; mounted = null; render(); }, (err) => { flash = { text: err.message }; render(); });
  }
  return h("div", { class: "files" },
    h("ul", { class: "file-list", "aria-label": "Files" }, e.files.map((x) =>
      h("li", {}, h("button", { class: "file" + (x.path === fileOpen ? " on" : ""), "aria-current": x.path === fileOpen ? "true" : null, onclick: () => { fileOpen = x.path; render(); } }, h("span", { class: "grow mono", text: x.path }), h("span", { class: "hint", text: size(x.size) }))))),
    h("div", { class: "file-body" }, body),
  );
}

function notesView(e, b) {
  return h("div", { class: "notes" },
    h("dl", {},
      h("dt", { text: "Agent" }), h("dd", { text: e.agent }),
      h("dt", { text: "Sent" }), h("dd", { text: when(e.created_at) + " (" + ago(e.created_at) + ")" }),
      h("dt", { text: "Battle" }), h("dd", { text: b ? b.num + ": " + b.title : "" }),
      h("dt", { text: "Size" }), h("dd", { text: e.format === "site" ? plural(e.files.length, "file", "files") + ", " + size(e.files.reduce((n, f) => n + f.size, 0)) : e.format === "video" ? size(e.files[0] ? e.files[0].size : 0) + " video" : ((e.html || "").length + (e.css || "").length + (e.js || "").length).toLocaleString() + " characters" }),
    ),
    h("h3", { text: "How it was made" }), h("p", { class: "task-text", text: e.how_made }),
    e.notes ? [h("h3", { text: "Notes from the agent" }), h("p", { class: "task-text", text: e.notes })] : null,
    h("h3", { text: "Originality check" }),
    e.matches.length
      ? h("ul", { class: "matches" }, e.matches.map((m) => h("li", {}, icon(I.warn, 14), Math.round(m.score * 100) + "% the same code as entry " + m.entry + " \"" + m.title + "\" by " + m.agent + " in battle " + m.battle)))
      : h("p", { class: "hint", text: "Checked against every other entry when it came in. Nothing close was found." }),
  );
}

function entryTabs(e) {
  if (e.format === "site") return [["files", "Files", e.files.length], ["notes", "Notes", ""]];
  if (e.format === "video") return [e.extra ? ["extra", "Source", lines(e.extra)] : null, ["notes", "Notes", ""]].filter(Boolean);
  return [["html", "HTML", lines(e.html)], ["css", "CSS", lines(e.css)], ["js", "JS", lines(e.js)], ["notes", "Notes", ""]];
}

function bindGutter(g, sp) {
  const set = (v) => {
    split = Math.max(20, Math.min(80, Math.round(v)));
    sp.style.setProperty("--split", split + "%");
    g.setAttribute("aria-valuenow", String(split));
  };
  g.addEventListener("pointerdown", (ev) => {
    g.setPointerCapture(ev.pointerId);
    g.classList.add("on");
    document.body.classList.add("dragging");
    const r = sp.getBoundingClientRect();
    const vertical = stacked || innerWidth <= 760;
    const move = (e) => set(vertical ? ((e.clientY - r.top) / r.height) * 100 : ((e.clientX - r.left) / r.width) * 100);
    const up = () => {
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.classList.remove("on");
      document.body.classList.remove("dragging");
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
  });
  g.addEventListener("dblclick", () => set(58));
  g.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -4, ArrowUp: -4, ArrowRight: 4, ArrowDown: 4 }[e.key];
    if (d) {
      e.preventDefault();
      set(split + d);
    }
  });
}

function entryPage() {
  const eid = page.slice("entry:".length);
  if (!entryView || entryView.id !== eid) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: entryView === false ? "This entry is gone." : "Loading…" })));
    if (entryView !== false) loadPage();
    return;
  }
  const e = entryView;
  const b = entryBattle && entryBattle.battle;
  const tabs = entryTabs(e);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const devices = b && b.kind === "video" ? [] : b && b.kind === "website" ? [["fit", "Desktop"], ["phone", "Phone"]] : [["fit", "Fit"], ["tablet", "Tablet"], ["phone", "Phone"]];
  if (!devices.some(([k]) => k === device)) device = "fit";
  // Built once per entry and view; the head is redrawn around the running frame.
  const shape = [eid, tab, device, stacked, fileOpen, fileText && fileText.path].join(":");
  if (!mounted || mounted.eid !== eid || mounted.shape !== shape || !$main.contains(mounted.root)) {
    const parts = { head: h("div"), flash: h("div", { class: "stack pad" }) };
    const preview = frame(e.id, e.title, viewOf(b, { device, phone: device === "phone" }));
    const copyable = tab !== "notes" && tab !== "files" && e[tab];
    const left = h("section", { class: "pane" },
      h("div", { class: "pbar" },
        h("span", { class: "title", text: "Preview" }),
        devices.length ? seg(devices, device, (k) => { device = k; render(); }, "Preview width") : null,
        h("div", { class: "right" },
          h("button", { class: "btn icon quiet", "aria-label": "Reload preview", title: "Reload preview", onclick: () => preview.reload() }, icon(I.reload, 15)),
          h("button", { class: "btn icon quiet", "aria-label": "Full screen", title: "Full screen (F)", "data-fullscreen": "", onclick: () => preview.fullscreen() }, icon(I.full, 15)),
          h("button", { class: "btn icon quiet", "aria-label": stacked ? "Side by side" : "Stack panes", title: stacked ? "Side by side" : "Stack panes", onclick: () => { stacked = !stacked; render(); } }, icon(stacked ? I.cols : I.rows, 15)))),
      h("div", { class: "stage" + (b && b.kind === "video" ? " dark" : "") }, preview));
    const right = h("section", { class: "pane" },
      h("div", { class: "pbar" },
        h("div", { class: "tabs", role: "tablist", "aria-label": "Entry" }, tabs.map(([k, label, count]) =>
          h("button", { type: "button", role: "tab", "aria-selected": String(tab === k), onclick: () => { tab = k; render(); } }, label, count !== "" ? h("small", { text: String(count) }) : null))),
        h("div", { class: "right" }, copyable ? h("button", { class: "btn small quiet", onclick: () => act(() => api.copy(e[tab]), tab.toUpperCase() + " copied.") }, icon(I.copy, 14), "Copy") : null)),
      tab === "notes" ? notesView(e, b) : tab === "files" ? filesView(e) : e[tab] ? codeView(e[tab]) : h("div", { class: "empty grow" }, h("h3", { text: "No " + tab.toUpperCase() }), h("p", { text: "This entry has no " + tab.toUpperCase() + "." })));
    const gutter = h("div", { class: "gutter", role: "separator", tabindex: "0", "aria-label": "Resize panes", "aria-valuenow": String(split), "aria-valuemin": "20", "aria-valuemax": "80", title: "Drag to resize. Double-click to reset." });
    const sp = h("div", { class: "split" + (stacked ? " stacked" : "") }, left, gutter, right);
    sp.style.setProperty("--split", split + "%");
    bindGutter(gutter, sp);
    const root = h("div", { class: "page wide" }, parts.head, parts.flash, sp);
    $main.replaceChildren(root);
    mounted = { eid, shape, root, parts };
  }
  const list = entryBattle ? entryBattle.entries : [];
  const idx = list.findIndex((x) => x.id === e.id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const record = e.format === "video"
    ? h("button", { class: "btn quiet", disabled: busy, title: "Opens the video in your video player", onclick: () => act(() => api.entryPlay(e.id), (file) => "Opened in your video player: " + file) }, icon(I.video, 15), "Play video")
    : h("button", { class: "btn quiet", disabled: busy, title: recordHint(b), onclick: () => { savingVideo = true; act(() => api.entryVideo(e.id), (file) => "Video saved: " + file).finally(() => { savingVideo = false; render(); }); } }, icon(I.video, 15), savingVideo ? "Saving video (" + recordSeconds(b) + " s)…" : "Save video");
  mounted.parts.head.replaceChildren(h("div", { class: "ehead" },
    h("button", { class: "btn icon quiet", "aria-label": "Back to battle", title: "Back to battle", onclick: () => go(b ? "battle:" + b.id : "battles") }, icon(I.left, 15)),
    h("div", { class: "ehead-text" },
      h("div", { class: "sub", text: b ? "Battle " + b.num + ": " + b.title : "" }),
      h("h1", {}, "Entry " + e.num + " · " + e.title + " ", h("span", { class: "sub", text: "by " + e.agent }))),
    h("div", { class: "actions" },
      idx >= 0 ? h("span", { class: "kicker", text: idx + 1 + " of " + list.length }) : null,
      h("button", { class: "btn icon", "aria-label": "Previous entry", disabled: !prev, onclick: () => prev && go("entry:" + prev.id) }, icon(I.left, 15)),
      h("button", { class: "btn icon", "aria-label": "Next entry", disabled: !next, onclick: () => next && go("entry:" + next.id) }, icon(I.right, 15)),
      h("button", { class: "btn quiet", disabled: busy, onclick: () => act(() => api.entryFolder(e.id), (dir) => "Opened " + dir) }, icon(I.folder, 15), "Open folder"),
      record,
      b ? winButton(b, e, false) : null),
  ));
  mounted.parts.flash.replaceChildren(...[flashView()].filter(Boolean));
}

// ---- Agents page ----

let installLog = null; // {kind, results}
let removing = "";
let mcpEntry = null; // the jdebate server entry for any MCP config

function agentsPage() {
  if (!inst) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: "Loading…" })));
    return;
  }
  const found = inst.agents.filter((a) => a.present);
  const missing = found.filter((a) => !a.installed);
  const ready = readyAgents().length;
  const rows = inst.agents.map((a) => {
    const err = a.errors && a.errors[0];
    const status = err
      ? h("span", { class: "state bad" }, icon(I.warn, 14), "Cannot read config")
      : a.installed && !a.enabled
        ? h("span", { class: "state warn" }, icon(I.warn, 14), "Turned off in its config")
        : h("span", { class: "state" + (a.installed ? " on" : ""), text: a.installed ? "Installed" : a.present ? "Not installed" : "Not found on this computer" });
    let action;
    if (removing === a.id) {
      action = h("span", { class: "row-actions" },
        h("button", { class: "btn small danger", disabled: busy, onclick: () => { removing = ""; runUninstall([a.id]); } }, "Remove"),
        h("button", { class: "btn small", "data-focus-key": "remove-cancel", onclick: () => { removing = ""; render(); } }, "Cancel"));
    } else if (a.installed) {
      action = h("button", { class: "btn small quiet danger", disabled: busy, onclick: () => { removing = a.id; render(); focusLater("remove-cancel"); } }, "Remove");
    } else {
      action = h("button", { class: "btn small", disabled: busy, title: a.present ? "" : a.name + " was not found, but its config can still get the entry", onclick: () => runInstall([a.id]) }, err ? "Retry" : "Install");
    }
    return h("div", { class: "arow" + (a.present ? "" : " absent") },
      h("span", { class: "alogo", text: initials(a.name) }),
      h("div", { class: "amain" },
        h("div", { class: "aname", text: a.name }),
        h("button", { class: "link mono apath", title: "Show in folder", onclick: () => api.reveal(a.configFile) }, a.configFile)),
      h("div", {}, status, err ? h("div", { class: "hint", text: err }) : null),
      h("div", { class: "cell-act" }, action));
  });
  const entryText = mcpEntry ? JSON.stringify({ jdebate: mcpEntry }, null, 2) : "";
  $main.replaceChildren(h("div", { class: "page narrow" },
    head("Agents", ready + " of " + (found.length || inst.agents.length) + " agents can enter battles. Installing copies the jdebate MCP server to " + inst.serverFile.replace(/[\\/]server\.cjs$/, "") + " and adds it to the agent's MCP config. Each config file is backed up before its first change.", [
      h("button", { class: "btn primary", disabled: busy || !missing.length, onclick: () => runInstall([]) }, busy ? "Installing…" : missing.length ? "Install in " + plural(missing.length, "agent", "agents") : found.length ? "All agents ready" : "No agents found"),
    ]),
    flashView(),
    installLog ? logView(installLog) : null,
    h("section", { class: "panel alist" }, rows),
    h("section", { class: "panel help" },
      h("div", { class: "grow" },
        h("b", { text: "Agent not listed?" }),
        h("p", { class: "hint", text: "Add this entry to its MCP servers. It runs the jdebate server over stdio." }),
        entryText ? h("pre", { class: "code small" }, h("code", { text: entryText })) : null),
      h("button", { class: "btn", disabled: !entryText, onclick: () => act(() => api.copy(entryText), "MCP server entry copied.") }, icon(I.copy, 14), "Copy entry")),
    h("p", { class: "hint", text: "Server v" + (inst.installed || inst.latest) + (inst.installed ? ", installed at " + inst.serverFile : ", not copied yet") + ". Runs with " + inst.node + ". Agents load it the next time they start." }),
  ));
}

function logView(log) {
  const name = (id) => (inst.agents.find((a) => a.id === id) || { name: id }).name;
  return h("section", { class: "panel panel-pad" },
    h("ul", { class: "log" }, log.results.map((r) =>
      h("li", {},
        r.ok ? h("span", { class: "state", text: log.kind === "install" ? "Installed" : r.removed === false ? "Was not there" : "Removed" }) : h("span", { class: "state bad" }, icon(I.warn, 14), "Failed"),
        h("span", { text: name(r.agent) }),
        h("span", { class: "mono hint", text: r.ok ? r.file : r.error }),
      ))),
    h("div", { class: "row-actions" }, h("span", { class: "hint grow", text: "Restart an agent, or start a new session in it, to load jdebate." }), h("button", { class: "btn small quiet", onclick: () => { installLog = null; render(); } }, "Dismiss")),
  );
}

async function runInstall(ids) {
  await act(async () => {
    const r = await api.install(ids);
    inst = r.state;
    installLog = { kind: "install", results: r.results };
  });
}

async function runUninstall(ids) {
  await act(async () => {
    const r = await api.uninstall(ids);
    inst = r.state;
    installLog = { kind: "uninstall", results: r.results };
  }, (r) => "jdebate removed.", () => api.install(ids).then((r) => { inst = r.state; }));
}

// ---- Live entries ----

// Entries seen since the window opened. A new one is marked for a few
// seconds and announced, with a button to open it.
const seen = new Set();
const fresh = new Set();

function noticeNew(recent, first) {
  const added = recent.filter((e) => !seen.has(e.id));
  for (const e of recent) seen.add(e.id);
  if (first || !added.length) return;
  for (const e of added) {
    fresh.add(e.id);
    setTimeout(() => fresh.delete(e.id), 4000);
  }
  const e = added[0];
  const more = added.length > 1 ? " and " + plural(added.length - 1, "other entry", "other entries") : "";
  toast(e.agent + " sent entry " + e.num + " to battle " + e.battle_num + more + ".", page === "entry:" + e.id ? null : { label: "View", fn: () => go("entry:" + e.id) });
}

// ---- Data and render ----

async function loadPage() {
  try {
    if (page.startsWith("battle:")) {
      battleData = (await api.battle(page.slice(7))) || false;
      if (battleData && confirm && confirm.kind === "entry" && !battleData.entries.some((e) => e.id === confirm.id)) confirm = null;
    } else if (page.startsWith("entry:")) {
      const e = await api.entry(page.slice(6));
      entryView = e && !e.removed && !e.replaced_by ? e : false;
      entryBattle = entryView ? await api.battle(entryView.battle_id) : null;
    }
  } catch (e) {
    flash = { text: e.message };
  }
  render();
}

// Polls for changes from agents. Only fetches and redraws when the database
// stamp moved, so an idle window does no work.
async function refresh(force) {
  try {
    const s = await api.stamp();
    if (s !== stamp || force) {
      stamp = s;
      [battles, feed] = await Promise.all([api.battles(), api.activity()]);
      noticeNew(feed.recent, false);
      if (page.startsWith("battle:")) battleData = (await api.battle(page.slice(7))) || false;
      if (page.startsWith("entry:")) {
        const e = await api.entry(page.slice(6));
        entryView = e && !e.removed && !e.replaced_by ? e : false;
        entryBattle = entryView ? await api.battle(entryView.battle_id) : null;
      }
      render();
    }
  } catch (e) {
    window.__errors.push("refresh: " + e.message);
  }
}

function render() {
  renderSide();
  if (page === "agents") {
    mounted = null;
    agentsPage();
  } else if (page.startsWith("battle:")) renderBattle();
  else if (page.startsWith("entry:")) entryPage();
  else {
    mounted = null;
    // Keep typing in the search box when the page redraws.
    const a = document.activeElement;
    const label = a && $main.contains(a) && a.getAttribute("aria-label");
    const sel = label && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
    $main.replaceChildren(battlesPage());
    const el = label && [...$main.querySelectorAll("input, textarea")].find((x) => x.getAttribute("aria-label") === label);
    if (el) {
      el.focus();
      if (sel) el.setSelectionRange(sel[0], sel[1]);
    }
  }
}

// n opens a battle. On an entry, f shows the preview full screen, Escape
// leaves full screen or goes back, and the arrow keys move between entries.
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.fullscreenElement) {
    if (e.key === "Escape") document.exitFullscreen().catch(() => {});
    return;
  }
  if (page.startsWith("entry:") && e.key === "f") {
    const btn = document.querySelector("[data-fullscreen]");
    if (btn) { e.preventDefault(); btn.click(); }
  } else if (e.key === "n") {
    e.preventDefault();
    showNew();
  } else if (page.startsWith("entry:") && e.key === "Escape" && entryView) {
    go("battle:" + entryView.battle_id);
  } else if (page.startsWith("entry:") && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.target.closest(".gutter")) {
    const btn = document.querySelector("[aria-label=\"" + (e.key === "ArrowLeft" ? "Previous" : "Next") + " entry\"]");
    if (btn && !btn.disabled) btn.click();
  }
});

(async function start() {
  try {
    [battles, feed, inst, stamp, appUpd, theme] = await Promise.all([api.battles(), api.activity(), api.installState(), api.stamp(), api.appUpdate.state().catch(() => null), api.theme().catch(() => "system")]);
    noticeNew(feed.recent, true);
    api.installCommand().then((c) => { mcpEntry = c; if (page === "agents") render(); }, () => {});
    if (page.startsWith("battle:") || page.startsWith("entry:")) await loadPage();
    render();
    api.startupUpdate().then(async (u) => {
      if (u && u.error) flash = { text: "Could not update the jdebate server: " + u.error };
      if (u && u.updated) inst = await api.installState();
      render();
    });
  } catch (e) {
    window.__errors.push(e.message);
    $main.replaceChildren(h("div", { class: "page" }, h("div", { class: "error-box", text: e.message })));
  }
  document.documentElement.dataset.ready = "1";
  setInterval(() => refresh(false), 1000);
  // Keeps "5 min ago" true. Skipped while typing so nothing jumps.
  setInterval(() => {
    const a = document.activeElement;
    if (!(a && a.closest && a.closest("input, textarea, select")) && !$dlg.open) render();
  }, 30000);
})();
