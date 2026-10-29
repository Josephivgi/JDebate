"use strict";

// An entry's submitted work as files on disk, so the user can open the
// folder, run index.html in any browser, and keep a video of it next to it.
// A site comes out as its folder; a video entry as its video and source.
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
  let video = null;
  if (entry.format === "site" || entry.format === "video") {
    // Each stored file at its path in the site; the folder runs as is.
    for (const f of entry.files) {
      const out = path.join(dir, ...f.path.split("/"));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(store.blobFile(home, f.sha), out);
    }
    if (entry.format === "video") {
      video = path.join(dir, entry.files[0].path);
      fs.writeFileSync(path.join(dir, "source.txt"), entry.extra);
    }
  } else {
    fs.writeFileSync(path.join(dir, "index.html"), compose(entry));
  }
  // A site may have its own about.txt.
  const taken = entry.files.some((f) => f.path.toLowerCase() === "about.txt");
  fs.writeFileSync(path.join(dir, taken ? "jdebate-about.txt" : "about.txt"), about(battle, entry));
  return { dir, battle, entry, video };
}

module.exports = { entryDir, writeEntry };
