"use strict";

// JDebate window. Pages: Battles (open one, see all), one page per battle
// with its entries running live, one page per entry with its code, and
// Agents (install the jdebate MCP server).

window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

const api = window.jdebate;
const $main = document.getElementById("main");

// page: "battles" | "agents" | "battle:<id>" | "entry:<id>"
// --page battle-<id> in smoke runs (a colon in an argument reads as a URL to Electron).
let page = (new URLSearchParams(location.search).get("page") || "battles").replace(/^(battle|entry)-/, "$1:");
let battles = [];
let inst = null; // install state
let stamp = -1;
let busy = false;
let flash = null; // {kind: "ok"|"bad", text}

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

function icon(d, size) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
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
  check: "M5 10.5l3.2 3.2L15 7",
  warn: "M10 3l8 14H2zM10 8v4M10 14.5v.5",
  back: "M12 4l-6 6 6 6",
  copy: "M7 7h9v10H7zM4 13V3h9",
  folder: "M3 5h5l2 2h7v9H3z",
  video: "M3 6h10v8H3zM13 9l4-2v6l-4-2",
  trophy: "M6 3h8v4a4 4 0 0 1-8 0zM6 5H3v1a3 3 0 0 0 3 3M14 5h3v1a3 3 0 0 1-3 3M10 11v3M7 17h6M8 14h4v3H8z",
};

function head(title, sub, actions, back) {
  return h("div", { class: "page-head" },
    h("div", { class: "head-text" },
      back ? h("button", { class: "btn quiet small back", onclick: back.go }, icon(I.back, 14), back.label) : null,
      h("h1", { text: title }),
      sub ? h("p", { text: sub }) : null,
    ),
    actions ? h("div", { class: "actions" }, actions) : null,
  );
}

function focusLater(key) {
  queueMicrotask(() => {
    const el = [...document.querySelectorAll("[data-focus-key]")].find((x) => x.dataset.focusKey === key);
    if (el) el.focus();
  });
}

const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

function flashView() {
  if (!flash) return null;
  return h("div", { class: flash.kind === "bad" ? "error-box" : "ok-box", role: flash.kind === "bad" ? "alert" : "status" },
    flash.kind === "bad" ? icon(I.warn) : null,
    h("span", { class: "grow", text: flash.text }),
    h("button", { class: "btn small quiet", onclick: () => { flash = null; render(); } }, "Dismiss"),
  );
}

async function act(work, okText) {
  if (busy) return;
  busy = true;
  flash = null;
  render();
  try {
    const out = await work();
    if (okText) flash = { kind: "ok", text: typeof okText === "function" ? okText(out) : okText };
  } catch (e) {
    flash = { kind: "bad", text: e.message };
  }
  busy = false;
  await refresh(true);
}

function go(p) {
  page = p;
  flash = null;
  mounted = null;
  render();
  $main.scrollTop = 0;
}

// ---- Sidebar ----

function renderSide() {
  const items = [
    { id: "battles", label: "Battles", d: I.battles, count: battles.length },
    { id: "agents", label: "Agents", d: I.agents, count: inst ? inst.agents.filter((a) => a.installed).length : null },
  ];
  const onPage = (id) => page === id || (id === "battles" && /^(battle|entry):/.test(page) && !openBattles().some((b) => isBattlePage(b.id)));
  document.getElementById("nav-pages").replaceChildren(
    ...items.map((p) => h("button", { class: "nav-item" + (onPage(p.id) ? " on" : ""), "aria-current": onPage(p.id) ? "page" : null, onclick: () => go(p.id) }, icon(p.d), h("span", { class: "grow", text: p.label }), p.count !== null ? h("span", { class: "count", text: String(p.count) }) : null)),
  );
  const open = openBattles();
  document.getElementById("nav-open-label").hidden = !open.length;
  document.getElementById("nav-battles").replaceChildren(
    ...open.map((b) => h("button", { class: "nav-item" + (isBattlePage(b.id) ? " on" : ""), title: b.title, onclick: () => go("battle:" + b.id) }, h("span", { class: "num", text: String(b.num) }), h("span", { class: "grow", text: b.title }), h("span", { class: "count", text: String(b.entries) }))),
  );
  const foot = [];
  if (inst) {
    const n = inst.agents.filter((a) => a.installed).length;
    foot.push(h("div", { text: n ? "jdebate is in " + plural(n, "agent", "agents") : "jdebate is not in any agent yet" }));
  }
  const upd = appUpdateView();
  if (upd) foot.push(upd);
  document.getElementById("side-foot").replaceChildren(...foot);
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

// ---- Battles page ----

const blankDraft = () => ({ title: "", task: "", kind: "page", site: "", videoSeconds: "30", videoSize: "1280x720" });
let draft = blankDraft();

// What each kind of battle asks agents for.
const KINDS = [
  { id: "page", label: "Page", hint: "One page in HTML, CSS and JS.", title: "Weather card", task: "Build a weather card for one city with a 5 day forecast. Plain HTML, CSS and JS. It should look good at 360 px and 1280 px wide." },
  { id: "website", label: "Website", hint: "A whole site with pages and images. Give a site to redesign, or leave it blank for a new one.", title: "Redesign of our home page", task: "Redesign this site. Keep what it says and who it is for, and make it clearer and better looking. Include the home page and at least one inner page. It must work on a phone and on a 1280 px screen." },
  { id: "video", label: "Video", hint: "A clip. Agents send an animation page that JDebate records, or a video file they made.", title: "30 second product demo", task: "Make a 30 second demo video for JVoice. Show what it does in three steps, with large readable text and a clear ending." },
];
const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];
const SIZES = [["1280x720", "Wide (16:9)"], ["1080x1920", "Tall (9:16)"], ["1080x1080", "Square"]];
const sizeName = (s) => (SIZES.find((x) => x[0] === s) || [s, s])[1];
const kindLine = (b) => (b.kind === "website" ? (b.site_url ? "Website redesign of " + b.site_url : "Website") : b.kind === "video" ? "Video, " + b.video_seconds + " s, " + sizeName(b.video_size).toLowerCase() : "Page");

function kindPicker(value, onpick) {
  return h("div", { class: "tabs", role: "radiogroup", "aria-label": "Kind of battle" }, KINDS.map((k) =>
    h("button", { type: "button", class: "tab" + (value === k.id ? " on" : ""), role: "radio", "aria-checked": value === k.id ? "true" : "false", onclick: () => onpick(k.id) }, k.label)));
}

// The fields that go with a kind: the site for a website, length and shape
// for a video. v holds { site, videoSeconds, videoSize }.
function kindFields(kind, v, labels) {
  if (kind === "website") {
    return h("label", { class: "field" }, h("span", { class: "field-label", text: "Site to redesign (optional)" }),
      h("input", { type: "text", "aria-label": labels + "Site", inputmode: "url", placeholder: "https://example.com", value: v.site, oninput: (e) => { v.site = e.target.value; } }));
  }
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

function battlesPage() {
  const ready = draft.title.trim() && draft.task.trim();
  const k = kindOf(draft.kind);
  const form = h("form", { class: "panel panel-pad open-form", onsubmit: (e) => { e.preventDefault(); openBattle(); } },
    h("h2", { text: "Open a battle" }),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Kind" }), kindPicker(draft.kind, (id) => { draft.kind = id; render(); }), h("span", { class: "hint", text: k.hint })),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Title" }),
      h("input", { type: "text", "aria-label": "Title", "data-focus-key": "new-title", maxlength: "200", placeholder: k.title, value: draft.title, oninput: (e) => { draft.title = e.target.value; syncOpen(); } })),
    kindFields(draft.kind, draft, ""),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Task for the agents" }),
      h("textarea", { "aria-label": "Task", rows: "5", placeholder: k.task, oninput: (e) => { draft.task = e.target.value; syncOpen(); } }, draft.task)),
    h("div", { class: "form-foot" },
      h("span", { class: "hint", text: "Agents see this task through the jdebate MCP server. Each one must build its own entry; copies are turned away." }),
      h("button", { class: "btn primary", type: "submit", id: "open-btn", disabled: busy || !ready }, busy ? "Working…" : "Open battle"),
    ),
  );
  const list = battles.length
    ? h("div", { class: "panel list" }, battles.map((b) =>
        h("button", { class: "list-row", onclick: () => go("battle:" + b.id) },
          h("span", { class: "num big", text: String(b.num) }),
          h("span", { class: "list-main" }, h("span", { class: "list-title", text: b.title }), h("span", { class: "list-sub", text: b.task.replace(/\s+/g, " ").slice(0, 160) })),
          h("span", { class: "list-meta" }, h("span", { class: "state" + (b.status === "open" ? " on" : ""), text: b.status === "open" ? "Open" : "Closed" }), h("span", { class: "hint", text: (b.kind && b.kind !== "page" ? kindOf(b.kind).label + ", " : "") + plural(b.entries, "entry", "entries") + ", " + when(b.created_at) })),
        ),
      ))
    : h("div", { class: "panel empty", text: "No battles yet. Open one above, then tell your agents to join it." });
  return h("div", { class: "page" },
    head("Battles", "Open a battle with a task: a page, a website or a video. Agents build an entry and send it through MCP. You look at each one running and pick the winner."),
    installStrip(),
    flashView(),
    form,
    h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", { text: "All battles" })), list),
  );
}

function syncOpen() {
  const b = document.getElementById("open-btn");
  if (b) b.disabled = busy || !(draft.title.trim() && draft.task.trim());
}

function openBattle() {
  act(async () => {
    const d = { title: draft.title, task: draft.task, kind: draft.kind };
    if (draft.kind === "website") d.site = draft.site;
    if (draft.kind === "video") Object.assign(d, { videoSeconds: draft.videoSeconds, videoSize: draft.videoSize });
    const b = await api.openBattle(d);
    draft = blankDraft();
    page = "battle:" + b.id;
    mounted = null;
    return b;
  }, (b) => "Battle " + b.num + " is open. Copy the agent prompt and give it to your agents.");
}

function installStrip() {
  if (!inst || inst.agents.some((a) => a.installed)) return null;
  return h("section", { class: "strip" },
    icon(I.warn),
    h("div", { class: "strip-text" }, h("strong", { text: "No agent has the jdebate MCP server yet." }), h("span", { class: "hint", text: "Agents need it to read battles and send entries." })),
    h("button", { class: "btn", onclick: () => go("agents") }, "Set up agents"),
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

function agentPrompt(b) {
  const what = b.kind === "website"
    ? (b.site_url ? " It is a website redesign of " + b.site_url + ": build the new site in a folder and send the folder." : " It is a website: build it in a folder and send the folder.")
    : b.kind === "video" ? " It is a " + b.video_seconds + " second video: send an animation page or a video file you made." : "";
  return "Join JDebate battle " + b.num + " (\"" + b.title + "\")." + what + " Use the jdebate MCP tools: read the task with battle_read " + b.num + ", build your entry yourself from scratch, then send it with prepare_submission and submit. Do not copy, fork or clone anyone else's work.";
}

// How entries of a battle are shown. page: as is. website: a 1280 px wide
// screen scaled to fit. video: the battle's frame size, letterboxed.
function viewOf(b, phone) {
  if (b && b.kind === "website") return phone ? { mode: "phone", w: 390 } : { mode: "width", w: 1280, h: 800 };
  if (b && b.kind === "video") {
    const [w, hh] = b.video_size.split("x").map(Number);
    return { mode: "contain", w, h: hh };
  }
  return null;
}

function battleHead(b) {
  const open = b.status === "open";
  return head("Battle " + b.num + ": " + b.title, (open ? "Open, taking entries. " : "Closed. ") + "Opened " + when(b.created_at) + ".", [
    open ? h("button", { class: "btn primary", disabled: busy, onclick: () => act(() => api.copy(agentPrompt(b)), "Agent prompt copied. Paste it into each agent you want in this battle.") }, icon(I.copy), "Copy agent prompt") : null,
    h("button", { class: "btn", disabled: busy, onclick: () => act(() => (open ? api.closeBattle(b.id) : api.reopenBattle(b.id)), open ? "Battle closed. Agents can now read every entry's code with battle_results." : "Battle open again.") }, open ? "Close battle" : "Reopen"),
    h("button", { class: "btn quiet", disabled: busy, onclick: () => { editing = { title: b.title, task: b.task, site: b.site_url, videoSeconds: b.video_seconds, videoSize: b.video_size }; render(); focusLater("edit-title"); } }, "Edit"),
    h("button", { class: "btn quiet danger", disabled: busy, onclick: () => { confirm = { kind: "battle", id: b.id }; render(); focusLater("confirm-cancel"); } }, "Delete"),
  ], { label: "Battles", go: () => go("battles") });
}

function taskPanel(b) {
  if (editing) {
    const save = () => {
      const patch = { title: editing.title, task: editing.task };
      if (b.kind === "website") patch.site = editing.site;
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
  return h("section", { class: "panel panel-pad task" },
    h("div", { class: "section-head" }, h("h2", { text: "Task" }), h("span", { class: "note", text: kindLine(b) })),
    h("p", { class: "task-text", text: b.task }));
}

// The site a website battle redesigns, as it looks now. Not an entry.
function beforeCard(b) {
  const shooting = battleData.shooting;
  let view;
  if (b.before_sha) view = h("img", { class: "shot", src: "jdebate-preview://before/" + b.id + "?t=" + b.before_at, alt: "The current site, " + b.site_url });
  else if (b.before_error) view = h("div", { class: "frame-note", role: "status" }, icon(I.warn, 14), h("span", { text: "No screenshot. " + b.before_error }));
  else view = h("div", { class: "frame-note", role: "status" }, h("span", { text: "Taking a screenshot of the site…" }));
  return h("article", { class: "panel card before", "aria-label": "Current site" },
    h("div", { class: "frame-wrap" }, h("div", { class: "frame-box" }, view)),
    h("div", { class: "card-body" },
      h("div", { class: "card-top" }, h("span", { class: "card-title", text: "Current site" })),
      h("p", { class: "hint", title: b.site_url, text: b.site_url }),
      h("div", { class: "row-actions" },
        h("button", { class: "btn small", disabled: busy, onclick: () => act(() => api.openSite(b.id)) }, "Open site"),
        h("button", { class: "btn small quiet", disabled: busy || shooting, onclick: () => act(() => api.shootSite(b.id)) }, shooting && b.before_sha ? "Taking screenshot…" : "Take again")),
    ),
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

function matchNote(e) {
  const m = e.matches && e.matches[0];
  if (!m) return null;
  return h("p", { class: "match", title: "Checked when the entry came in" }, icon(I.warn, 14), Math.round(m.score * 100) + "% like entry " + m.entry + " by " + m.agent + (m.battle !== battleData.battle.num ? " in battle " + m.battle : ""));
}

const pages = (e) => e.files.filter((f) => /\.html?$/i.test(f.path)).length;
const formatNote = (e) => (e.format === "site" ? ". " + plural(pages(e), "page", "pages") + ", " + plural(e.files.length, "file", "files") : e.format === "video" ? ". Video file" : "");

function cardBody(e) {
  const b = battleData.battle;
  const win = b.winner_id === e.id;
  const asking = confirm && confirm.kind === "entry" && confirm.id === e.id;
  return h("div", { class: "card-body" },
    h("div", { class: "card-top" },
      h("span", { class: "num", text: String(e.num) }),
      h("span", { class: "card-title", title: e.title, text: e.title }),
      win ? h("span", { class: "winner" }, icon(I.trophy, 14), "Winner") : null,
    ),
    h("p", { class: "hint", text: e.agent + ", " + when(e.created_at) + formatNote(e) }),
    matchNote(e),
    asking
      ? h("div", { class: "row-actions" },
          h("span", { class: "hint grow", text: "Remove this entry?" }),
          h("button", { class: "btn small danger", disabled: busy, onclick: () => act(async () => { await api.removeEntry(e.id); confirm = null; }, "Entry " + e.num + " removed.") }, "Remove"),
          h("button", { class: "btn small", "data-focus-key": "confirm-cancel", onclick: () => { confirm = null; render(); } }, "Cancel"))
      : h("div", { class: "row-actions" },
          h("button", { class: "btn small", onclick: () => go("entry:" + e.id) }, "Open"),
          h("button", { class: "btn small quiet", disabled: busy, title: "Open the folder with this entry's files", onclick: () => act(() => api.entryFolder(e.id)) }, icon(I.folder, 14), "Folder"),
          win
            ? h("button", { class: "btn small quiet", disabled: busy, onclick: () => act(() => api.setWinner(b.id, null), "Winner cleared.") }, "Clear winner")
            : h("button", { class: "btn small", disabled: busy, onclick: () => act(() => api.setWinner(b.id, e.id), "Entry " + e.num + " is the winner.") }, icon(I.trophy, 14), "Pick as winner"),
          h("button", { class: "btn small quiet danger", "aria-label": "Remove entry " + e.num, disabled: busy, onclick: () => { confirm = { kind: "entry", id: e.id }; render(); focusLater("confirm-cancel"); } }, "Remove")),
  );
}

// Loads at once (frames are on screen, lazy only adds a wait). A frame that
// has not loaded in 3 seconds is loaded again; after two tries it says so
// and offers a reload instead of staying blank.
//
// view (from viewOf) renders the entry at a fixed size and scales it into
// the box: "width" fills the width and shows the top, "contain" fits all of
// it, "phone" is a 390 px wide column.
function frame(id, label, view) {
  const src = "jdebate-preview://" + id + "/";
  const el = h("iframe", { class: "frame", src, sandbox: "allow-scripts", title: label, referrerpolicy: "no-referrer" });
  const note = h("div", { class: "frame-note", role: "status", hidden: true });
  const box = h("div", { class: "frame-box" + (view ? " " + view.mode : "") }, el, note);
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
  return box;
}

function card(e) {
  return h("article", { class: "panel card" + (battleData.battle.winner_id === e.id ? " won" : ""), "data-entry": e.id },
    h("div", { class: "frame-wrap" }, frame(e.id, "Entry " + e.num + ": " + e.title, viewOf(battleData.battle))),
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
    const parts = { head: h("div"), notes: h("div", { class: "stack" }), task: h("div"), entriesHead: h("div", { class: "section-head" }), grid: h("div", { class: "cards" }) };
    const root = h("div", { class: "page" }, parts.head, parts.notes, parts.task, h("section", { class: "section" }, parts.entriesHead, parts.grid));
    $main.replaceChildren(root);
    mounted = { bid, root, parts, cards: new Map() };
  }
  const p = mounted.parts;
  p.head.replaceChildren(battleHead(b));
  p.notes.replaceChildren(...[installStrip(), flashView(), confirmView(b)].filter(Boolean));
  if (!(editing && p.task.querySelector("form"))) p.task.replaceChildren(taskPanel(b));
  p.entriesHead.replaceChildren(h("h2", { text: "Entries" }), h("span", { class: "note", text: battleData.entries.length ? plural(battleData.entries.length, "entry", "entries") + ". Each one runs in a sandbox with no network." : "" }));
  // Keyed: keep each entry's frame, redraw only its text and buttons.
  const live = new Set(battleData.entries.map((e) => e.id));
  for (const [id, c] of mounted.cards) if (!live.has(id)) { c.el.remove(); mounted.cards.delete(id); }
  // The current site comes first, kept apart from the entry cards.
  const beforeSig = b.kind === "website" && b.site_url ? JSON.stringify([b.site_url, b.before_sha, b.before_error, b.before_at, battleData.shooting, busy]) : "";
  if (mounted.beforeSig !== beforeSig) {
    if (mounted.before) mounted.before.remove();
    mounted.before = beforeSig ? beforeCard(b) : null;
    if (mounted.before) p.grid.prepend(mounted.before);
    mounted.beforeSig = beforeSig;
  }
  const empty = p.grid.querySelector(".cards-empty");
  if (empty && battleData.entries.length) empty.remove();
  for (const e of battleData.entries) {
    const sig = JSON.stringify([e.title, e.agent, e.matches, b.winner_id === e.id, confirm && confirm.id === e.id, busy]);
    const have = mounted.cards.get(e.id);
    if (!have) {
      const el = card(e);
      p.grid.append(el);
      mounted.cards.set(e.id, { el, sig });
    } else if (have.sig !== sig) {
      have.el.classList.toggle("won", b.winner_id === e.id);
      have.el.querySelector(".card-body").replaceWith(cardBody(e));
      have.sig = sig;
    }
  }
  if (!battleData.entries.length && !empty) {
    p.grid.append(h("div", { class: "panel empty cards-empty" }, b.status === "open" ? "No entries yet. Copy the agent prompt above and paste it into Claude Code, Codex, Cursor or any agent with jdebate installed. Entries show up here as they come in." : "This battle closed with no entries."));
  }
}

// ---- Entry page ----

let entryView = null; // entry with code, or false when gone
let savingVideo = false;
let tab = "preview";
let phone = false; // website entries: phone width instead of desktop
let fileOpen = ""; // Files tab: the file shown
let fileText = null; // {eid, path, text}

const recordSeconds = (b) => (b && b.kind === "video" ? b.video_seconds : 30);
const recordHint = (b) => "Records the first " + recordSeconds(b) + " seconds to an MP4" + (b && b.kind === "video" ? " at " + b.video_size.replace("x", " × ") : "") + " you can upload to Reddit or YouTube";
const size = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");

// A site's files on the left, the one picked on the right.
function filesView(e) {
  if (!fileOpen || !e.files.some((f) => f.path === fileOpen)) fileOpen = e.files[0].path;
  const f = e.files.find((x) => x.path === fileOpen);
  let body;
  if (fileText && fileText.eid === e.id && fileText.path === f.path) {
    body = fileText.text === null ? h("p", { class: "empty", text: f.path + " is not text (" + f.type + ", " + size(f.size) + ")." }) : h("pre", { class: "code" }, h("code", { text: fileText.text }));
  } else {
    body = h("p", { class: "empty", text: "Loading…" });
    api.entryText(e.id, f.path).then((text) => { fileText = { eid: e.id, path: f.path, text }; mounted = null; render(); }, (err) => { flash = { kind: "bad", text: err.message }; render(); });
  }
  return h("div", { class: "panel files" },
    h("ul", { class: "file-list", "aria-label": "Files" }, e.files.map((x) =>
      h("li", {}, h("button", { class: "file" + (x.path === fileOpen ? " on" : ""), "aria-current": x.path === fileOpen ? "true" : null, onclick: () => { fileOpen = x.path; render(); } }, h("span", { class: "grow mono", text: x.path }), h("span", { class: "hint", text: size(x.size) }))))),
    h("div", { class: "file-body" }, body),
  );
}

function entryPage() {
  const eid = page.slice("entry:".length);
  if (!entryView || entryView.id !== eid) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: entryView === false ? "This entry is gone." : "Loading…" })));
    if (entryView !== false) loadPage();
    return;
  }
  const e = entryView;
  const b = battles.find((x) => x.id === e.battle_id);
  // Built once per entry, tab and view; the rest is redrawn around the running frame.
  const shape = tab + ":" + phone + ":" + fileOpen;
  if (!mounted || mounted.eid !== eid || mounted.shape !== shape || !$main.contains(mounted.root)) {
    const parts = { head: h("div"), flash: h("div", { class: "stack" }), tabs: h("div", { class: "tab-row" }), body: h("div"), facts: h("div") };
    const tabs = e.format === "site" ? [["preview", "Preview"], ["files", "Files"]]
      : e.format === "video" ? [["preview", "Preview"], ["extra", "Source"]]
      : [["preview", "Preview"], ["html", "HTML"], ["css", "CSS"], ["js", "JS"]].filter(([k]) => k === "preview" || k === "html" || e[k]);
    if (!tabs.some(([k]) => k === tab)) tab = "preview";
    const group = (items, on, pick, label) => h("div", { class: "tabs", role: "tablist", "aria-label": label }, items.map(([k, text]) => h("button", { class: "tab" + (on === k ? " on" : ""), role: "tab", "aria-selected": on === k ? "true" : "false", onclick: () => pick(k) }, text)));
    parts.tabs.replaceChildren(...[
      group(tabs, tab, (k) => { tab = k; render(); }, "Entry"),
      tab === "preview" && b && b.kind === "website" ? group([["desk", "Desktop"], ["phone", "Phone"]], phone ? "phone" : "desk", (k) => { phone = k === "phone"; render(); }, "Screen size") : null,
    ].filter(Boolean));
    parts.body.replaceChildren(
      tab === "preview" ? h("div", { class: "panel big-frame" + (b && b.kind === "video" ? " dark" : "") }, frame(e.id, e.title, viewOf(b, phone)))
        : tab === "files" ? filesView(e)
        : h("pre", { class: "panel code" }, h("code", { text: e[tab] || "" })),
    );
    parts.facts.replaceChildren(factsPanel(e));
    const root = h("div", { class: "page" }, parts.head, parts.flash, parts.tabs, parts.body, parts.facts);
    $main.replaceChildren(root);
    mounted = { eid, shape, root, parts };
  }
  const record = e.format === "video"
    ? h("button", { class: "btn", disabled: busy, title: "Opens the video in your video player", onclick: () => act(() => api.entryPlay(e.id), (file) => "Opened in your video player: " + file) }, icon(I.video), "Play video")
    : h("button", { class: "btn", disabled: busy, title: recordHint(b), onclick: () => { savingVideo = true; act(() => api.entryVideo(e.id), (file) => "Video saved: " + file).finally(() => { savingVideo = false; render(); }); } }, icon(I.video), savingVideo ? "Saving video (" + recordSeconds(b) + " s)…" : "Save video");
  mounted.parts.head.replaceChildren(
    head("Entry " + e.num + ": " + e.title, "By " + e.agent + ", " + when(e.created_at) + (b ? ". Battle " + b.num + ": " + b.title : ""), [
      h("button", { class: "btn", disabled: busy, onclick: () => act(() => api.entryFolder(e.id), (dir) => "Opened " + dir) }, icon(I.folder), "Open folder"),
      record,
      b ? (b.winner_id === e.id
        ? h("span", { class: "winner big" }, icon(I.trophy), "Winner")
        : h("button", { class: "btn primary", disabled: busy, onclick: () => act(() => api.setWinner(b.id, e.id), "Entry " + e.num + " is the winner.") }, icon(I.trophy), "Pick as winner")) : null,
    ], { label: b ? "Battle " + b.num : "Battles", go: () => go(b ? "battle:" + b.id : "battles") }),
  );
  mounted.parts.flash.replaceChildren(...[flashView()].filter(Boolean));
}

function factsPanel(e) {
  return h("section", { class: "panel panel-pad facts" },
    h("div", {}, h("h2", { text: "How it was made" }), h("p", { class: "task-text", text: e.how_made })),
    e.notes ? h("div", {}, h("h2", { text: "Notes from the agent" }), h("p", { class: "task-text", text: e.notes })) : null,
    h("div", {}, h("h2", { text: "Originality check" }),
      e.matches.length
        ? h("ul", { class: "matches" }, e.matches.map((m) => h("li", {}, icon(I.warn, 14), Math.round(m.score * 100) + "% the same code as entry " + m.entry + " \"" + m.title + "\" by " + m.agent + " in battle " + m.battle)))
        : h("p", { class: "hint", text: "Checked against every other entry when it came in. Nothing close was found." })),
  );
}

// ---- Agents page ----

let installLog = null; // {kind, results}
let removing = "";

function agentsPage() {
  if (!inst) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: "Loading…" })));
    return;
  }
  const found = inst.agents.filter((a) => a.present);
  const missing = found.filter((a) => !a.installed);
  const have = inst.agents.filter((a) => a.installed).length;
  const hero = h("section", { class: "panel hero" },
    h("div", { class: "hero-text" },
      h("h2", { text: missing.length ? "Add jdebate to your agents" : found.length ? "jdebate is in every agent found" : "No agents found" }),
      h("p", { text: found.length
        ? "JDebate copies its MCP server to " + inst.serverFile.replace(/[\\/]server\.cjs$/, "") + " and adds a jdebate entry to each agent's MCP config, like JMCP does. Each config file is backed up before its first change. Agents load it the next time they start."
        : "JDebate looks for Claude Code, Codex, Factory Droid, OpenCode, Devin, Cursor, Gemini CLI, Qwen Code and Grok. Install one, then come back." }),
    ),
    missing.length
      ? h("button", { class: "btn primary big", disabled: busy, onclick: () => runInstall([]) }, busy ? "Installing…" : "Install in " + plural(missing.length, "agent", "agents"))
      : null,
  );
  const rows = inst.agents.map((a) => {
    const err = a.errors && a.errors[0];
    const status = err
      ? h("span", { class: "state bad" }, icon(I.warn, 14), "Cannot read config")
      : a.installed && !a.enabled
        ? h("span", { class: "state warn" }, icon(I.warn, 14), "Turned off in its config")
        : h("span", { class: "state", text: a.installed ? "Installed" : a.present ? "Not installed" : "Not found on this computer" });
    let action;
    if (removing === a.id) {
      action = h("span", { class: "row-actions" },
        h("button", { class: "btn small danger", disabled: busy, onclick: () => { removing = ""; runUninstall([a.id]); } }, "Remove"),
        h("button", { class: "btn small", "data-focus-key": "remove-cancel", onclick: () => { removing = ""; render(); } }, "Cancel"));
    } else if (a.installed) {
      action = h("button", { class: "btn small quiet danger", disabled: busy, onclick: () => { removing = a.id; render(); focusLater("remove-cancel"); } }, "Remove");
    } else {
      action = h("button", { class: "btn small", disabled: busy, title: a.present ? "" : a.name + " was not found, but its config can still get the entry", onclick: () => runInstall([a.id]) }, "Install");
    }
    return h("tr", { class: a.present ? "" : "absent" },
      h("td", { class: "agent-name", text: a.name }),
      h("td", {}, status, err ? h("div", { class: "hint", text: err }) : null),
      h("td", {}, h("button", { class: "link mono", title: "Show in folder", onclick: () => api.reveal(a.configFile) }, a.configFile)),
      h("td", { class: "cell-act" }, action),
    );
  });
  $main.replaceChildren(h("div", { class: "page" },
    head("Agents", "The jdebate MCP server gives agents five tools: battles, battle_read, prepare_submission, submit and battle_results.", null),
    hero,
    flashView(),
    installLog ? logView(installLog) : null,
    h("section", { class: "panel" },
      h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", { text: "Agent" }), h("th", { text: "jdebate" }), h("th", { text: "MCP config" }), h("th", {}))),
        h("tbody", {}, rows),
      ),
    ),
    h("p", { class: "hint", text: "Server v" + (inst.installed || inst.latest) + (inst.installed ? ", installed at " + inst.serverFile : ", not copied yet") + ". Runs with " + inst.node + ". " + have + " of " + inst.agents.length + " agents have it." }),
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
  });
}

// ---- Data and render ----

async function loadPage() {
  try {
    if (page.startsWith("battle:")) {
      battleData = (await api.battle(page.slice(7))) || false;
      if (battleData && confirm && confirm.kind === "entry" && !battleData.entries.some((e) => e.id === confirm.id)) confirm = null;
    } else if (page.startsWith("entry:")) {
      entryView = (await api.entry(page.slice(6))) || false;
      if (entryView && (entryView.removed || entryView.replaced_by)) entryView = false;
    }
  } catch (e) {
    flash = { kind: "bad", text: e.message };
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
      battles = await api.battles();
      if (page.startsWith("battle:")) battleData = (await api.battle(page.slice(7))) || false;
      if (page.startsWith("entry:")) {
        const e = await api.entry(page.slice(6));
        entryView = e && !e.removed && !e.replaced_by ? e : false;
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
    // Keep typing in the form when the page redraws.
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

(async function start() {
  try {
    [battles, inst, stamp, appUpd] = await Promise.all([api.battles(), api.installState(), api.stamp(), api.appUpdate.state().catch(() => null)]);
    if (page.startsWith("battle:") || page.startsWith("entry:")) await loadPage();
    render();
    api.startupUpdate().then(async (u) => {
      if (u && u.error) flash = { kind: "bad", text: "Could not update the jdebate server: " + u.error };
      if (u && u.updated) inst = await api.installState();
      render();
    });
  } catch (e) {
    window.__errors.push(e.message);
    $main.replaceChildren(h("div", { class: "page" }, h("div", { class: "error-box", text: e.message })));
  }
  document.documentElement.dataset.ready = "1";
  setInterval(() => refresh(false), 1000);
})();
