"use strict";

// Installs the jdebate MCP server into coding agents, the way JMCP installs
// its servers: the server is copied to ~/.jdebate/server first, so agents
// keep working if the app moves or updates, then each agent's own config
// gets an entry that runs it with the system Node.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const agents = require("./agents.cjs");

const NAME = "jdebate";
const SOURCE = path.join(__dirname, "..", "server");
const ENTRY = "server.cjs";

function homeDir(home) {
  return path.join(home || os.homedir(), ".jdebate");
}

function serverDir(home) {
  return path.join(homeDir(home), "server");
}

function nodeCommand() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  // In Electron, process.execPath is the app, not Node.
  if (!process.versions.electron) return { command: process.execPath, env: {} };
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const f = path.join(dir, exe);
    try {
      if (fs.statSync(f).isFile()) return { command: f, env: {} };
    } catch {
      /* next */
    }
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function readVersion(dir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version || "");
  } catch {
    return "";
  }
}

// 1 when a is newer than b, -1 when older, 0 when the same (x.y.z only).
function compareVersions(a, b) {
  const x = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

function restoreOld(dest) {
  try {
    if (!fs.existsSync(dest) && fs.existsSync(dest + ".old")) fs.renameSync(dest + ".old", dest);
  } catch {
    /* next copy tries again */
  }
}

// Copy beside the old copy, then swap, so agents never run a half-done copy.
async function copyDir(src, dest) {
  const next = dest + ".new";
  const old = dest + ".old";
  restoreOld(dest);
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
  await fs.promises.cp(src, next, { recursive: true, filter: (p) => !/[\\/](test|\.git)([\\/]|$)/.test(p.slice(src.length)) });
  if (fs.existsSync(dest)) {
    try {
      await fs.promises.rename(dest, old);
    } catch (e) {
      await fs.promises.rm(next, { recursive: true, force: true }).catch(() => {});
      throw new Error("Could not replace " + dest + " (" + e.code + "). Close the agents using it and try again.");
    }
  }
  try {
    await fs.promises.rename(next, dest);
  } catch (e) {
    if (!fs.existsSync(dest) && fs.existsSync(old)) await fs.promises.rename(old, dest).catch(() => {});
    await fs.promises.rm(next, { recursive: true, force: true }).catch(() => {});
    throw new Error("Could not replace " + dest + " (" + e.code + "). Close the agents using it and try again.");
  }
  await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
}

function versions(home) {
  restoreOld(serverDir(home));
  const latest = readVersion(SOURCE);
  const installed = readVersion(serverDir(home));
  return { latest, installed, updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0) };
}

async function prepare(home) {
  await copyDir(SOURCE, serverDir(home));
  const node = nodeCommand();
  // A scratch home (tests) keeps its battles there too.
  const env = Object.assign({}, node.env, home ? { JDEBATE_HOME: homeDir(home) } : {});
  return { command: node.command, args: [path.join(serverDir(home), ENTRY)], env };
}

// Each agent and whether jdebate is in its config.
function status(home) {
  const list = agents.scan(home);
  return {
    name: NAME,
    serverFile: path.join(serverDir(home), ENTRY),
    node: nodeCommand().command,
    ...versions(home),
    agents: list.map((a) => {
      const s = a.servers.find((x) => x.name === NAME);
      return { id: a.id, name: a.name, present: a.present, configFile: a.configFile, errors: a.errors, installed: Boolean(s), enabled: s ? s.enabled : false };
    }),
  };
}

// Into the given agents, or every agent found on this computer that does
// not have it yet.
async function install(agentIds, home) {
  const list = agents.scan(home);
  const targets = agentIds && agentIds.length ? agentIds : list.filter((a) => a.present && !a.servers.some((s) => s.name === NAME)).map((a) => a.id);
  if (!targets.length) return { results: [] };
  const def = await prepare(home);
  const results = [];
  for (const id of targets) {
    try {
      results.push(Object.assign({ ok: true }, agents.install(id, NAME, def, home)));
    } catch (e) {
      results.push({ ok: false, agent: id, error: String(e.message || e) });
    }
  }
  return { command: def.command, args: def.args, results };
}

function uninstall(agentIds, home) {
  const targets = agentIds && agentIds.length ? agentIds : agents.AGENTS.map((a) => a.id);
  return {
    results: targets.map((id) => {
      try {
        return Object.assign({ ok: true }, agents.uninstall(id, NAME, home));
      } catch (e) {
        return { ok: false, agent: id, error: String(e.message || e) };
      }
    }),
  };
}

// The copy in ~/.jdebate is older than this app: replace it and rewrite the
// entry in every agent that has it (the Node path may have moved). The app
// runs this when it starts.
async function update(home, opts) {
  const v = versions(home);
  if (!v.installed || (!v.updateAvailable && !(opts && opts.force))) return { updated: false, ...v, results: [] };
  const def = await prepare(home);
  const results = [];
  for (const a of agents.scan(home).filter((x) => x.servers.some((s) => s.name === NAME))) {
    try {
      results.push(Object.assign({ ok: true }, agents.install(a.id, NAME, def, home)));
    } catch (e) {
      results.push({ ok: false, agent: a.id, error: String(e.message || e) });
    }
  }
  return { updated: true, from: v.installed, to: readVersion(serverDir(home)), results };
}

module.exports = { NAME, SOURCE, status, install, uninstall, update, nodeCommand, compareVersions, serverDir };
