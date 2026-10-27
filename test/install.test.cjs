"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const install = require("../core/install.cjs");
const { compose } = require("../core/preview.cjs");
const { scratch } = require("./fixtures.cjs");

test("installs jdebate into the agents found, keeps their other servers, and removes it", async () => {
  const home = scratch();
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, theme: "dark" }, null, 2));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const before = install.status(home);
  assert.deepEqual(before.agents.filter((a) => a.present).map((a) => a.id), ["claude-code", "codex"]);
  const r = await install.install([], home);
  assert.deepEqual(r.results.map((x) => [x.agent, x.ok]), [["claude-code", true], ["codex", true]]);
  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
  assert.equal(claude.theme, "dark");
  assert.ok(claude.mcpServers.other);
  assert.equal(claude.mcpServers.jdebate.args[0], path.join(home, ".jdebate", "server", "server.cjs"));
  assert.equal(claude.mcpServers.jdebate.env.JDEBATE_HOME, path.join(home, ".jdebate"));
  assert.ok(fs.existsSync(path.join(home, ".claude.json.jdebate-backup")));
  const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.jdebate\]/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.equal(install.status(home).agents.filter((a) => a.installed).length, 2);

  // The installed copy is a working server.
  const def = claude.mcpServers.jdebate;
  const run = spawnSync(def.command, def.args, { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t" } } }) + "\n", env: Object.assign({}, process.env, def.env), windowsHide: true, encoding: "utf8", timeout: 20000 });
  assert.equal(JSON.parse(run.stdout.split("\n")[0]).result.serverInfo.name, "jdebate");

  // Nothing left to add.
  assert.equal((await install.install([], home)).results.length, 0);
  const u = install.uninstall(["claude-code", "codex"], home);
  assert.ok(u.results.every((x) => x.ok && x.removed));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.jdebate, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /jdebate/);
});

test("update replaces an older copy and leaves a current one alone", async () => {
  const home = scratch();
  fs.mkdirSync(path.join(home, ".claude"));
  await install.install(["claude-code"], home);
  assert.equal((await install.update(home)).updated, false);
  const pkg = path.join(install.serverDir(home), "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ version: "0.0.1" }));
  assert.equal(install.status(home).updateAvailable, true);
  const r = await install.update(home);
  assert.equal(r.updated, true);
  assert.equal(r.results[0].agent, "claude-code");
  assert.equal(install.status(home).updateAvailable, false);
});

test("compose wraps a fragment and fills a full page", () => {
  const frag = compose({ html: "<p>hi</p>", css: "p{color:red}", js: "console.log(1)" });
  assert.match(frag, /^<!doctype html>/);
  assert.match(frag, /<style>\np\{color:red\}\n<\/style>\n<\/head>/);
  assert.match(frag, /<script>\nconsole.log\(1\)\n<\/script>\n<\/body>/);
  const full = compose({ html: "<html><head><title>x</title></head><body><p>a</p></body></html>", css: "a{}", js: "x()" });
  assert.match(full, /<style>\na\{\}\n<\/style>\n<\/head>/);
  assert.match(full, /x\(\)\n<\/script>\n<\/body><\/html>$/);
  // Code cannot close its own tag early.
  assert.doesNotMatch(compose({ html: "<p></p>", css: "</style><script>alert(1)</script>", js: "" }), /<\/style><script>alert/);
  assert.match(compose({ html: "<p></p>", js: "s='</script>'" }), /<\\\/script>/);
});
