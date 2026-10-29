#!/usr/bin/env node
"use strict";

// JDebate MCP server. The user opens battles in the JDebate app; agents read
// the task and send an entry: one page (HTML, CSS and JS), a website folder,
// or for video battles a finished video file. Sending is two steps:
// prepare_submission tells the agent the originality rule and checks the
// entry against every other entry, then submit puts it in. Reads and writes
// ~/.jdebate/jdebate.db on each call.

const store = require("./lib/store.js");
const { rpcError, serve, checkArgs } = require("./lib/rpc.js");
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = require("./package.json").version;

const ORIGINAL = "all my own work";

const RULE =
  "JDebate battles are for original work. If any part of your entry was forked, cloned or copied from another agent's entry, " +
  "or from other existing work related to this battle's task (a template, a tutorial, a CodePen, a repo, a past battle, " +
  "something another agent made for you), do not submit it. Throw it away, redo it from scratch yourself, then call " +
  "prepare_submission again. Libraries are not allowed either: entry pages run with no network, so everything must be in your HTML, CSS and JS.";

const KIND_NAME = { page: "Page", website: "Website", video: "Video" };

function sizeText(s) {
  const [w, h] = s.split("x").map(Number);
  return w + "x" + h + " (" + (w > h ? "wide 16:9" : w < h ? "tall 9:16" : "square") + ")";
}

// What to build and how to send it, for each kind of battle.
function kindText(b) {
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
    inputSchema: { type: "object", properties: { battle: num("Battle number, e.g. 3") }, required: ["battle"], additionalProperties: false },
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
        battle: num("Battle number"),
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
    name: "battle_results",
    description: "Entries of a battle and the winner. The code of each entry is shown once the battle is closed.",
    inputSchema: { type: "object", properties: { battle: num("Battle number") }, required: ["battle"], additionalProperties: false },
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
  return "- Battle " + b.num + ": " + b.title + " (" + kind + b.status + ", " + b.entries + (b.entries === 1 ? " entry" : " entries") + ")";
}

function matchLine(m) {
  return "- " + pct(m.score) + (m.exact ? " (identical)" : "") + " the same as entry " + m.entry + " \"" + m.title + "\" by " + m.agent + " in battle " + m.battle;
}

function readBattle(n) {
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
      "# Battle " + b.num + ": " + b.title,
      "Status: " + b.status + (b.status === "open" ? ", taking entries" : ", no more entries"),
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
      entries.length ? entries.map((e) => "- Entry " + e.num + ": " + e.title + " by " + e.agent).join("\n") : "None yet.",
    ].join("\n");
  }
  if (name === "prepare_submission") {
    const r = store.prepare(undefined, Object.assign({}, a, { client }));
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
    const head = "# Battle " + b.num + ": " + b.title + " (" + b.status + ")\n" + (b.winner_id ? "Winner: entry " + (entries.find((e) => e.id === b.winner_id) || {}).num : "No winner picked yet.");
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
        "JDebate runs battles: the user opens one in the JDebate app with a task, and agents each build an entry: a page (HTML, CSS, JS), a website (a folder of pages and images) or a video. " +
        "Read the task with battle_read, build it yourself, then send it with prepare_submission and submit.\n\n" + RULE +
        (open.length ? "\n\nOpen battles:\n" + open.map(battleLine).join("\n") : "\n\nNo battle is open right now."),
    };
  },
  ping: () => ({}),
  "tools/list": () => ({ tools: TOOLS }),
  "tools/call"(params) {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) throw rpcError(-32602, "Unknown tool " + params.name);
    const wrong = checkArgs(tool.inputSchema, params.arguments);
    if (wrong) return { content: [{ type: "text", text: "Invalid arguments: " + wrong }], isError: true };
    try {
      return { content: [{ type: "text", text: call(params.name, params.arguments) }], isError: false };
    } catch (e) {
      return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

if (require.main === module) serve(methods);

module.exports = { methods, TOOLS, RULE, ORIGINAL };
