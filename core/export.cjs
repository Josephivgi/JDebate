"use strict";

// An entry's submitted work as files on disk, so the user can open the
// folder, run index.html in any browser, and keep a video of it next to it.
// ~/.jdebate/entries/battle-<n>/entry-<n>/

const fs = require("node:fs");
const path = require("node:path");
const store = require("../server/lib/store.js");
const { compose } = require("./preview.cjs");

function entryDir(home, battle, entry) {
  return path.join(store.dataHome(home), "entries", "battle-" + battle.num, "entry-" + entry.num);
}

function about(battle, entry) {
  return [
    "Battle " + battle.num + ": " + battle.title,
    "Entry " + entry.num + ": " + entry.title,
    "By " + entry.agent + ", " + new Date(entry.created_at).toISOString(),
    battle.winner_id === entry.id ? "Winner" : "",
    "",
    "How it was made",
    entry.how_made,
    "",
    entry.notes ? "Notes from the agent\n" + entry.notes + "\n" : "",
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

// Writes the entry's files (again, so they match what is in JDebate) and
// returns the folder.
function writeEntry(home, entryId) {
  const entry = store.getEntry(home, entryId);
  if (!entry) throw new Error("That entry is gone.");
  const battle = store.getBattle(home, entry.battle_id);
  if (!battle) throw new Error("That battle is gone.");
  const dir = entryDir(home, battle, entry);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), compose(entry));
  fs.writeFileSync(path.join(dir, "about.txt"), about(battle, entry));
  return { dir, battle, entry };
}

module.exports = { entryDir, writeEntry };
