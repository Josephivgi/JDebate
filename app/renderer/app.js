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

let draft = { title: "", task: "" };

function battlesPage() {
  const ready = draft.title.trim() && draft.task.trim();
  const form = h("form", { class: "panel panel-pad open-form", onsubmit: (e) => { e.preventDefault(); openBattle(); } },
    h("h2", { text: "Open a battle" }),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Title" }),
      h("input", { type: "text", "aria-label": "Title", "data-focus-key": "new-title", maxlength: "200", placeholder: "Weather card", value: draft.title, oninput: (e) => { draft.title = e.target.value; syncOpen(); } })),
    h("label", { class: "field" }, h("span", { class: "field-label", text: "Task for the agents" }),
      h("textarea", { "aria-label": "Task", rows: "5", placeholder: "Build a weather card for one city with a 5 day forecast. Plain HTML, CSS and JS. It should look good at 360 px and 1280 px wide.", oninput: (e) => { draft.task = e.target.value; syncOpen(); } }, draft.task)),
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
          h("span", { class: "list-meta" }, h("span", { class: "state" + (b.status === "open" ? " on" : ""), text: b.status === "open" ? "Open" : "Closed" }), h("span", { class: "hint", text: plural(b.entries, "entry", "entries") + ", " + when(b.created_at) })),
        ),
      ))
    : h("div", { class: "panel empty", text: "No battles yet. Open one above, then tell your agents to join it." });
  return h("div", { class: "page" },
    head("Battles", "Open a battle with a task. Agents build an entry in HTML, CSS and JS and send it through MCP. You look at each one running and pick the winner."),
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
    const b = await api.openBattle(draft);
    draft = { title: "", task: "" };
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
  return "Join JDebate battle " + b.num + " (\"" + b.title + "\"). Use the jdebate MCP tools: read the task with battle_read " + b.num + ", build your entry yourself from scratch, then send it with prepare_submission and submit. Do not copy, fork or clone anyone else's work.";
}

function battleHead(b) {
  const open = b.status === "open";
  return head("Battle " + b.num + ": " + b.title, (open ? "Open, taking entries. " : "Closed. ") + "Opened " + when(b.created_at) + ".", [
    open ? h("button", { class: "btn primary", disabled: busy, onclick: () => act(() => api.copy(agentPrompt(b)), "Agent prompt copied. Paste it into each agent you want in this battle.") }, icon(I.copy), "Copy agent prompt") : null,
    h("button", { class: "btn", disabled: busy, onclick: () => act(() => (open ? api.closeBattle(b.id) : api.reopenBattle(b.id)), open ? "Battle closed. Agents can now read every entry's code with battle_results." : "Battle open again.") }, open ? "Close battle" : "Reopen"),
    h("button", { class: "btn quiet", disabled: busy, onclick: () => { editing = { title: b.title, task: b.task }; render(); focusLater("edit-title"); } }, "Edit"),
    h("button", { class: "btn quiet danger", disabled: busy, onclick: () => { confirm = { kind: "battle", id: b.id }; render(); focusLater("confirm-cancel"); } }, "Delete"),
  ], { label: "Battles", go: () => go("battles") });
}

function taskPanel(b) {
  if (editing) {
    return h("form", { class: "panel panel-pad", onsubmit: (e) => { e.preventDefault(); act(async () => { await api.editBattle(b.id, editing); editing = null; }, "Saved."); } },
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Title" }), h("input", { type: "text", "aria-label": "Edit title", "data-focus-key": "edit-title", value: editing.title, oninput: (e) => { editing.title = e.target.value; } })),
      h("label", { class: "field" }, h("span", { class: "field-label", text: "Task" }), h("textarea", { "aria-label": "Edit task", rows: "6", oninput: (e) => { editing.task = e.target.value; } }, editing.task)),
      h("div", { class: "row-actions" }, h("button", { class: "btn primary", type: "submit", disabled: busy }, "Save"), h("button", { class: "btn", type: "button", onclick: () => { editing = null; render(); } }, "Cancel")),
    );
  }
  return h("section", { class: "panel panel-pad task" }, h("h2", { text: "Task" }), h("p", { class: "task-text", text: b.task }));
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
    h("p", { class: "hint", text: e.agent + ", " + when(e.created_at) }),
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
function frame(id, label) {
  const src = "jdebate-preview://entry/" + id;
  const el = h("iframe", { class: "frame", src, sandbox: "allow-scripts", title: label, referrerpolicy: "no-referrer" });
  const note = h("div", { class: "frame-note", role: "status", hidden: true });
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
  return h("div", { class: "frame-box" }, el, note);
}

function card(e) {
  return h("article", { class: "panel card" + (battleData.battle.winner_id === e.id ? " won" : ""), "data-entry": e.id },
    h("div", { class: "frame-wrap" }, frame(e.id, "Entry " + e.num + ": " + e.title)),
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

function entryPage() {
  const eid = page.slice("entry:".length);
  if (!entryView || entryView.id !== eid) {
    $main.replaceChildren(h("div", { class: "page" }, h("p", { class: "empty", text: entryView === false ? "This entry is gone." : "Loading…" })));
    if (entryView !== false) loadPage();
    return;
  }
  const e = entryView;
  const b = battles.find((x) => x.id === e.battle_id);
  // Built once per entry and tab; the rest is redrawn around the running frame.
  if (!mounted || mounted.eid !== eid || mounted.tab !== tab || !$main.contains(mounted.root)) {
    const parts = { head: h("div"), flash: h("div", { class: "stack" }), tabs: h("div"), body: h("div"), facts: h("div") };
    const tabs = [["preview", "Preview"], ["html", "HTML"], ["css", "CSS"], ["js", "JS"]].filter(([k]) => k === "preview" || k === "html" || e[k]);
    parts.tabs.replaceChildren(h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) => h("button", { class: "tab" + (tab === k ? " on" : ""), role: "tab", "aria-selected": tab === k ? "true" : "false", onclick: () => { tab = k; render(); } }, label))));
    parts.body.replaceChildren(tab === "preview" ? h("div", { class: "panel big-frame" }, frame(e.id, e.title)) : h("pre", { class: "panel code" }, h("code", { text: e[tab] || "" })));
    parts.facts.replaceChildren(factsPanel(e));
    const root = h("div", { class: "page" }, parts.head, parts.flash, parts.tabs, parts.body, parts.facts);
    $main.replaceChildren(root);
    mounted = { eid, tab, root, parts };
  }
  mounted.parts.head.replaceChildren(
    head("Entry " + e.num + ": " + e.title, "By " + e.agent + ", " + when(e.created_at) + (b ? ". Battle " + b.num + ": " + b.title : ""), [
      h("button", { class: "btn", disabled: busy, onclick: () => act(() => api.entryFolder(e.id), (dir) => "Opened " + dir) }, icon(I.folder), "Open folder"),
      h("button", { class: "btn", disabled: busy, title: "Records the first 30 seconds to an MP4 you can upload to Reddit or YouTube", onclick: () => { savingVideo = true; act(() => api.entryVideo(e.id), (file) => "Video saved: " + file).finally(() => { savingVideo = false; render(); }); } }, icon(I.video), savingVideo ? "Saving video (30 s)…" : "Save video"),
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
