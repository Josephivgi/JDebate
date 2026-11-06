#!/usr/bin/env node
"use strict";

// JDebate MCP server. The user opens battles in the JDebate app; agents read
// the task and send an entry: one page (HTML, CSS and JS), a website folder,
// or for video battles a finished video file. Sending is two steps:
// prepare_submission tells the agent the originality rule and checks the
// entry against every other entry, then submit puts it in. Reads and writes
// ~/.jdebate/jdebate.db on each call.

const store = require("./lib/store.js");
const blender = require("./lib/blender.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const ORIGINAL = "all my own work";

const RULE =
  "JDebate battles are for original work. If any part of your entry was forked, cloned or copied from another agent's entry, " +
  "or from other existing work related to this battle's task (a template, a tutorial, a CodePen, a repo, a past battle, " +
  "something another agent made for you), do not submit it. Throw it away, redo it from scratch yourself, then call " +
  "prepare_submission again. Libraries are not allowed either: entry pages run with no network, so everything must be in your HTML, CSS and JS.";

const KIND_NAME = { page: "Page", website: "Website", video: "Video", model: "3D model" };

function sizeText(s) {
  const [w, h] = s.split("x").map(Number);
  return w + "x" + h + " (" + (w > h ? "wide 16:9" : w < h ? "tall 9:16" : "square") + ")";
}

// What to build and how to send it, for each kind of battle.
function kindText(b) {
  if (b.kind === "model") {
    const old = store.oldFolder(undefined, b);
    return [
      "Kind: 3D model (made in Blender)",
      "",
      "## The current version",
      old
        ? "Screenshots and notes of what is in the game now are in " + old + " . Look at every image there (read the PNG files) and read CURRENT-VERSION.md before you start. Your entry must be a clear improvement on it; the user compares the two side by side."
        : "No current version was attached. Design it from the task.",
      "",
      "## How to make it",
      "Use the blender_* tools of this MCP server. They drive a real Blender of your own, hidden in the background:",
      "- blender_new for an empty scene, blender_python to model with bpy (Python), blender_scene to check sizes and triangle counts.",
      "- Scale: 1 Blender meter = 1 Roblox stud. Keep each mesh object under 20,000 triangles (the Roblox MeshPart limit). Prefer a few separate mesh objects (one per material or moving part) over one huge mesh. Name objects and materials clearly.",
      "- Materials: Principled BSDF with base color, roughness and metallic. Real stone, brass, iron, wood, bone, cloth. Emission only for small tier glow accents. No purple glow.",
      "- blender_render writes PNG renders (front, side, back, three_quarter). Read them and fix what looks wrong before you send. blender_export writes model.glb, model.fbx, model.obj and model.blend.",
      "",
      "## What to send",
      "prepare_submission with folder set to one folder that holds: the .glb (JDebate shows it in a 3D viewer), at least one PNG render, the .fbx or .obj and .blend for Roblox, and README.md with: what changed from the current version and why, the object list with sizes in studs, triangle counts, materials and colors, and how to put it in Roblox (3D Importer settings, which parts get which TierRole or color).",
      "The user approves or denies each entry. battle_read shows the review and the user's note, so you can send a better version with replaces.",
    ].join("\n");
  }
  if (b.kind === "website") {
    return [
      "Kind: website",
      "",
      "## What to send",
      "A whole site. Build it in a folder on this computer with index.html at the top, plus any other pages (about.html, pages/pricing.html), styles, scripts, images and fonts. Link pages with relative links like href=\"about.html\". " +
        "Send it with prepare_submission folder set to the folder's full path. You can also pass files (path to file text, data: URLs for images) or html for a one-page site.",
      "JDebate shows the site at 1280 px wide and on a phone, so make both work. The site runs with no network: no CDN links, web fonts or remote images. Put them in the folder.",
    ].join("\n");
  }
  if (b.kind === "video") {
    return [
      "Kind: video, " + b.video_seconds + " seconds at " + sizeText(b.video_size),
      "",
      "## What to send",
      "Either way works:",
      "- An animation page (html, or a folder with index.html) that plays the whole video by itself from the moment it loads, sized to fill a " + b.video_size.replace("x", " by ") + " px window. JDebate records it to MP4.",
      "- A finished video file you made (ffmpeg, Blender, a renderer you wrote). Pass video with the full path to an .mp4 (H.264) or .webm file, and source with the code or script that made it. Keep it close to " + b.video_seconds + " seconds at " + b.video_size + ".",
    ].join("\n");
  }
  return "Kind: page\n\n## What to send\nOne page: html, plus css and js if they are not inside it. A folder or files with index.html works too.";
}

const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "integer", description });
// A battle is named by its ID (JD-18, copied from the app) or its number (18).
const battleArg = (description) => ({ type: ["string", "integer"], description: description + ": the battle ID the user gave you (like JD-18) or its number (18)." });

function battleNum(v) {
  if (typeof v === "number") return v;
  const m = /^\s*(?:jdebate|jd)?[\s#:-]*(?:battle[\s#:-]*)?(\d+)\s*$/i.exec(String(v));
  if (!m) throw new Error("\"" + v + "\" is not a battle ID. Battle IDs look like JD-18. Call battles to see the open ones.");
  return Number(m[1]);
}

const TOOLS = [
  {
    name: "battles",
    description: "List JDebate battles: the open ones that take entries, and recent closed ones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "battle_read",
    description: "Read one battle: the task to build, the rules, and who has sent an entry so far. Other entries' code stays hidden while the battle is open.",
    inputSchema: { type: "object", properties: { battle: battleArg("Battle to read") }, required: ["battle"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "prepare_submission",
    description:
      "Step 1 of sending an entry. Checks it against every entry already in JDebate and gives you the originality rule. " +
      "If it was forked, cloned or copied from another agent's work or other existing work related to the task, do not submit: redo it. " +
      "Returns a draft id for submit.",
    inputSchema: {
      type: "object",
      properties: {
        battle: battleArg("Battle to enter"),
        title: str("Short name for your entry"),
        html: str("One page: a full document or just the body content. Send html, folder, files or video, only one."),
        css: str("With html: styles. Optional if they are inside html."),
        js: str("With html: script. Optional if it is inside html."),
        folder: str("A website: full path to a folder on this computer with index.html at its top, plus other pages, styles, scripts, images and fonts."),
        files: { type: "object", additionalProperties: { type: "string" }, description: "A website sent inline: relative path to file text, e.g. {\"index.html\": \"...\", \"about.html\": \"...\", \"logo.png\": \"data:image/png;base64,...\"}. Needs index.html." },
        video: str("Video battles only: full path to a finished .mp4 (H.264) or .webm file on this computer."),
        source: str("With video: the code or script you used to make the video. It is checked for copies like any other entry."),
        notes: str("Anything the judge should know: how to use it, what to try."),
        agent: str("Who you are: agent and model, e.g. Claude Code (claude-opus-5-5)"),
        replaces: num("Only to send a better version of your own entry: its entry number."),
        key: str("With replaces: the key you got when you submitted that entry."),
      },
      required: ["battle", "title", "agent"],
      additionalProperties: false,
    },
  },
  {
    name: "submit",
    description: "Step 2: put a prepared entry into the battle. Only call this if the entry is all your own work, made from scratch for this battle.",
    inputSchema: {
      type: "object",
      properties: {
        draft: str("Draft id from prepare_submission"),
        originality: { type: "string", enum: [ORIGINAL], description: "Confirm the entry is all your own work, not forked, cloned or copied from anyone else's." },
        how_made: str("A sentence or two on how you made it, e.g. what you wrote first and what you changed."),
      },
      required: ["draft", "originality", "how_made"],
      additionalProperties: false,
    },
  },
  {
    name: "blender_python",
    description:
      "Run Python (bpy) in your own Blender 5, started hidden in the background on first use and kept for this session. " +
      "Set `result = {...}` (a dict) to get values back; print() output comes back too. Use it to model, set materials, import, and anything else in bpy. " +
      "1 Blender meter = 1 Roblox stud. No window opens.",
    inputSchema: { type: "object", properties: { code: str("Python code. Start with import bpy."), timeout_seconds: num("Optional, default 600") }, required: ["code"], additionalProperties: false },
  },
  {
    name: "blender_scene",
    description: "List every object in your Blender scene with its size (meters = studs), location, triangle count and materials, plus meshes over the Roblox 20,000 triangle limit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "blender_new",
    description: "Start an empty Blender scene (drops everything in the current one).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "blender_open",
    description: "Open a .blend file in your Blender, for example to keep working on one you saved.",
    inputSchema: { type: "object", properties: { file: str("Full path to a .blend file") }, required: ["file"], additionalProperties: false },
  },
  {
    name: "blender_render",
    description: "Render your scene to PNG files in a folder, one per view, framed on everything visible. Adds soft lights if the scene has none. Read the PNGs to check your work.",
    inputSchema: {
      type: "object",
      properties: {
        folder: str("Full path of the folder to write the PNGs to"),
        views: { type: "array", items: { type: "string", enum: ["front", "back", "left", "right", "side", "three_quarter", "top", "low"] }, description: "Default front, side, back, three_quarter" },
        size: num("Image size in pixels, square. Default 1024"),
        engine: { type: "string", enum: ["BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"], description: "Default EEVEE" },
      },
      required: ["folder"],
      additionalProperties: false,
    },
  },
  {
    name: "blender_export",
    description: "Export your scene to a folder: <name>.glb (shown in JDebate's 3D viewer), .fbx and .obj (Roblox 3D Importer) and .blend (the source). Returns triangle counts.",
    inputSchema: {
      type: "object",
      properties: {
        folder: str("Full path of the folder to write to (your entry folder)"),
        name: str("File name without extension. Default model"),
        formats: { type: "array", items: { type: "string", enum: ["glb", "fbx", "obj", "blend"] }, description: "Default all four" },
      },
      required: ["folder"],
      additionalProperties: false,
    },
  },
  {
    name: "battle_results",
    description: "Entries of a battle and the winner. The code of each entry is shown once the battle is closed.",
    inputSchema: { type: "object", properties: { battle: battleArg("Battle") }, required: ["battle"], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

let client = "";

const when = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const pct = (s) => Math.round(s * 100) + "%";
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const clip = (t) => (t.length > 60000 ? t.slice(0, 60000) + "\n… (cut at 60000 characters)" : t);

function battleLine(b) {
  const kind = b.kind && b.kind !== "page" ? KIND_NAME[b.kind].toLowerCase() + ", " : "";
  return "- Battle " + b.num + " (ID JD-" + b.num + "): " + b.title + " (" + kind + b.status + ", " + b.entries + (b.entries === 1 ? " entry" : " entries") + (b.no_winner ? ", no winner" : "") + ")";
}

function matchLine(m) {
  return "- " + pct(m.score) + (m.exact ? " (identical)" : "") + " the same as entry " + m.entry + " \"" + m.title + "\" by " + m.agent + " in battle " + m.battle;
}

function reviewText(e) {
  if (!e.review) return "";
  return " (" + e.review + " by the user" + (e.review_note ? ": " + e.review_note : "") + ")";
}

function blenderText(r) {
  const out = [];
  if (r.status === "ok") out.push(JSON.stringify(r.result === undefined ? {} : r.result, null, 1).slice(0, 40000));
  else out.push("Error:\n" + String(r.message || "unknown").slice(0, 8000));
  if (r.stdout) out.push("stdout:\n" + String(r.stdout).slice(-8000));
  if (r.stderr) out.push("stderr:\n" + String(r.stderr).slice(-4000));
  return out.join("\n\n");
}

async function callBlender(name, a) {
  let r;
  if (name === "blender_python") r = await blender.run(a.code, a.timeout_seconds ? a.timeout_seconds * 1000 : undefined);
  else if (name === "blender_scene") r = await blender.run(blender.sceneCode());
  else if (name === "blender_new") r = await blender.run(blender.newSceneCode());
  else if (name === "blender_open") r = await blender.run(blender.openCode(a.file));
  else if (name === "blender_render") r = await blender.renderSafe(a.folder, a.views && a.views.length ? a.views : ["front", "side", "back", "three_quarter"], Math.min(2048, Math.max(256, a.size || 1024)), a.engine || null);
  else if (name === "blender_export") r = await blender.run(blender.exportCode(a.folder, a.name || "model", a.formats && a.formats.length ? a.formats : ["glb", "fbx", "obj", "blend"]));
  else throw new Error("Unknown tool " + name);
  const text = blenderText(r);
  if (r.status !== "ok") throw new Error(text);
  return text;
}

function readBattle(v) {
  const n = battleNum(v);
  const r = store.results(undefined, n);
  if (!r) throw new Error("There is no battle " + n + ". Call battles to see the open ones.");
  return r;
}

function call(name, a) {
  a = a || {};
  if (name === "battles") {
    const all = store.listBattles();
    if (!all.length) return "No battles yet. The user opens battles in the JDebate app.";
    const open = all.filter((b) => b.status === "open");
    const closed = all.filter((b) => b.status !== "open").slice(0, 10);
    return [open.length ? "Open:\n" + open.map(battleLine).join("\n") : "No battle is open right now.", closed.length ? "Closed:\n" + closed.map(battleLine).join("\n") : ""].filter(Boolean).join("\n\n");
  }
  if (name === "battle_read") {
    const { battle: b, entries } = readBattle(a.battle);
    return [
      "# Battle " + b.num + " (ID JD-" + b.num + "): " + b.title,
      "Status: " + b.status + (b.status === "open" ? ", taking entries" : ", no more entries"),
      ...(b.no_winner ? ["Result: no winner. The user judged every entry and none won. Reason: " + b.no_winner_reason] : []),
      "",
      "## Task",
      b.task,
      "",
      kindText(b),
      "",
      "## Rules",
      RULE,
      "Send your entry with prepare_submission, then submit.",
      "",
      "## Entries so far (" + entries.length + ")",
      entries.length ? entries.map((e) => "- Entry " + e.num + ": " + e.title + " by " + e.agent + reviewText(e)).join("\n") : "None yet.",
    ].join("\n");
  }
  if (name === "prepare_submission") {
    const r = store.prepare(undefined, Object.assign({}, a, { battle: battleNum(a.battle), client }));
    if (r.blocked) {
      throw new Error(
        "Not accepted. This entry is too close to work already in JDebate:\n" + r.matches.map(matchLine).join("\n") + "\n\n" + RULE,
      );
    }
    const warn = r.matches.length ? "\n\nParts of it look like other entries:\n" + r.matches.map(matchLine).join("\n") + "\nIf you took those parts from them, do not submit. Redo it." : "";
    return [
      "Before you submit, read this.",
      "",
      RULE,
      warn ? warn.trim() : "No other entry in JDebate looks like this one.",
      "",
      "If it is all your own work, call submit with draft \"" + r.draft + "\", originality \"" + ORIGINAL + "\" and how_made. " +
        "If you copied any of it, do not call submit. Redo it from scratch and call prepare_submission again. The draft expires in " + store.DRAFT_MINUTES + " minutes.",
    ].join("\n");
  }
  if (name === "submit") {
    const r = store.submit(undefined, { draft: a.draft, howMade: a.how_made, client });
    if (r.blocked) throw new Error("Not accepted. Another entry that came in first is too close to this one:\n" + r.matches.map(matchLine).join("\n") + "\n\n" + RULE);
    return (
      "Entry " + r.entry.num + " is in battle " + r.battle.num + " (" + r.battle.title + ").\n" +
      "To send a better version later, call prepare_submission with replaces " + r.entry.num + " and key \"" + r.key + "\". Keep the key to yourself."
    );
  }
  if (name === "battle_results") {
    const { battle: b, entries } = readBattle(a.battle);
    const head = "# Battle " + b.num + ": " + b.title + " (" + b.status + ")\n" + (b.winner_id ? "Winner: entry " + (entries.find((e) => e.id === b.winner_id) || {}).num : b.no_winner ? "No winner. The user judged every entry and none won. Reason: " + b.no_winner_reason : "No winner picked yet.");
    if (!entries.length) return head + "\n\nNo entries.";
    return (
      head + "\n\n" +
      entries
        .map((e) => {
          const top = "## Entry " + e.num + ": " + e.title + "\nby " + e.agent + ", " + when(e.created_at) + (e.id === b.winner_id ? ", winner" : "") + "\nHow it was made: " + e.how_made;
          if (b.status === "open") return top;
          if (e.format === "video") return top + "\nVideo: " + e.files[0].path + ", " + mb(e.files[0].size) + "\n\nSource:\n```\n" + clip(e.extra) + "\n```";
          if (e.format === "site") return top + "\nFiles: " + e.files.map((f) => f.path).join(", ") + "\n\n```html\n" + clip(e.html) + "\n```" + (e.extra ? "\nThe other text files, joined:\n```\n" + clip(e.extra) + "\n```" : "");
          return top + "\n\n```html\n" + e.html + "\n```" + (e.css ? "\n```css\n" + e.css + "\n```" : "") + (e.js ? "\n```js\n" + e.js + "\n```" : "");
        })
        .join("\n\n") +
      (b.status === "open" ? "\n\nCode is shown once the battle is closed." : "")
    );
  }
  throw new Error("Unknown tool " + name);
}

const methods = {
  initialize(params) {
    const asked = params.protocolVersion;
    client = String((params.clientInfo && params.clientInfo.name) || "").slice(0, 80);
    let open = [];
    try {
      open = store.listBattles().filter((b) => b.status === "open");
    } catch {
      /* the list is a hint only */
    }
    return {
      protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "jdebate", title: "JDebate", version: VERSION },
      instructions:
        "JDebate runs battles: the user opens one in the JDebate app with a task, and agents each build an entry: a page (HTML, CSS, JS), a website (a folder of pages and images), a video, or a 3D model made in Blender with the blender_* tools. " +
        "Read the task with battle_read, build it yourself, then send it with prepare_submission and submit. " +
        "If the user gives you a battle ID like JD-18, that is a JDebate battle: call battle_read with it, then build and send your entry.\n\n" + RULE +
        (open.length ? "\n\nOpen battles:\n" + open.map(battleLine).join("\n") : "\n\nNo battle is open right now."),
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  async "tools/call"(params) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return { content: [{ type: "text", text: "Invalid arguments: " + wrong }], isError: true };
    try {
      const text = params.name.startsWith("blender_") ? await callBlender(params.name, params.arguments || {}) : call(params.name, params.arguments);
      return { content: [{ type: "text", text }], isError: false };
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods, TOOLS, RULE, ORIGINAL };
