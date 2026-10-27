#!/usr/bin/env node
"use strict";

// node cli/jdebate.cjs status | install [agent..] | uninstall [agent..] | update
// Agent ids: claude-code, codex, factory-droid, opencode, devin, cursor,
// gemini, qwen, grok. install with no ids adds jdebate to every agent found
// on this computer that does not have it yet.

const install = require("../core/install.cjs");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const home = process.env.JDEBATE_TEST_HOME || undefined;
  let out;
  if (cmd === "status" || !cmd) {
    const s = install.status(home);
    const lines = ["jdebate " + (s.installed ? "v" + s.installed + " installed" : "not copied yet") + (s.updateAvailable ? ", v" + s.latest + " available" : "")];
    for (const a of s.agents) lines.push((a.installed ? "  yes  " : "  no   ") + a.name + (a.present ? "" : " (not found)") + "  " + a.configFile);
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  if (cmd === "install") out = await install.install(rest, home);
  else if (cmd === "uninstall") out = install.uninstall(rest, home);
  else if (cmd === "update") out = await install.update(home, { force: true });
  else throw new Error("Unknown command " + cmd + ". Use status, install, uninstall or update.");
  for (const r of out.results) process.stdout.write((r.ok ? "ok    " : "fail  ") + r.agent + "  " + (r.ok ? r.file : r.error) + "\n");
  if (!out.results.length) process.stdout.write("Nothing to do.\n");
  if (out.results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(String(e.message || e) + "\n");
  process.exit(1);
});
