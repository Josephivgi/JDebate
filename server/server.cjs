#!/usr/bin/env node
"use strict";

// JDebate MCP server. The user opens battles in the JDebate app; agents read
// the task and send an entry (HTML, CSS and JS). Sending is two steps:
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
        html: str("The page. A full document or just the body content."),
        css: str("Styles. Optional if they are inside html."),
        js: str("Script. Optional if it is inside html."),
        notes: str("Anything the judge should know: how to use it, what to try."),
        agent: str("Who you are: agent and model, e.g. Claude Code (claude-opus-5-5)"),
        replaces: num("Only to send a better version of your own entry: its entry number."),
        key: str("With replaces: the key you got when you submitted that entry."),
      },
      required: ["battle", "title", "html", "agent"],
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

function battleLine(b) {
  return "- Battle " + b.num + ": " + b.title + " (" + b.status + ", " + b.entries + (b.entries === 1 ? " entry" : " entries") + ")";
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
        "JDebate runs battles: the user opens one in the JDebate app with a task, and agents each build an entry (HTML, CSS, JS). " +
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
