"use strict";

// Runs the real server as a child process over stdio, the way agents do.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const store = require("../server/lib/store.js");
const { scratch, CLOCK, FLIP } = require("./fixtures.cjs");

function start(home, clientName) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "server.cjs")], { env: Object.assign({}, process.env, { JDEBATE_HOME: path.join(home, ".jdebate") }), windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const tool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { text: r.result.content[0].text, isError: r.result.isError };
  };
  return {
    rpc,
    tool,
    init: () => rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } }),
    stop: () => child.stdin.end(),
  };
}

test("an agent reads a battle, is told the rule, and submits", async () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a live clock." });
  const s = start(home, "claude-code");
  try {
    const init = await s.init();
    assert.equal(init.result.serverInfo.name, "jdebate");
    assert.match(init.result.instructions, /Battle 1: Clock/);
    assert.match(init.result.instructions, /do not submit it/);
    const tools = (await s.rpc("tools/list", {})).result.tools.map((t) => t.name);
    assert.deepEqual(tools, ["battles", "battle_read", "prepare_submission", "submit", "battle_results"]);
    assert.match((await s.tool("battles", {})).text, /Battle 1: Clock \(open, 0 entries\)/);
    const read = await s.tool("battle_read", { battle: 1 });
    assert.match(read.text, /Build a live clock/);
    assert.match(read.text, /forked, cloned or copied/);
    const prep = await s.tool("prepare_submission", Object.assign({ battle: 1, agent: "Claude Code (test)" }, CLOCK));
    assert.equal(prep.isError, false, prep.text);
    assert.match(prep.text, /^Before you submit, read this\./);
    assert.match(prep.text, /do not submit it/);
    const draft = /draft "([^"]+)"/.exec(prep.text)[1];
    const bad = await s.tool("submit", { draft, originality: "copied", how_made: "Wrote it by hand from the task." });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /originality must be one of all my own work/);
    const ok = await s.tool("submit", { draft, originality: "all my own work", how_made: "Wrote the SVG ring first, then the tick loop." });
    assert.equal(ok.isError, false, ok.text);
    assert.match(ok.text, /Entry 1 is in battle 1/);
    const e = store.entries(home, store.listBattles(home)[0].id)[0];
    assert.equal(e.agent, "Claude Code (test)");
    assert.equal(e.client, "claude-code");
  } finally {
    s.stop();
  }
});

test("a second agent sending a copy is told to redo it", async () => {
  const home = scratch();
  store.openBattle(home, { title: "Clock", task: "Build a live clock." });
  const a = start(home, "claude-code");
  const b = start(home, "codex");
  try {
    await a.init();
    await b.init();
    const p = await a.tool("prepare_submission", Object.assign({ battle: 1, agent: "A" }, CLOCK));
    await a.tool("submit", { draft: /draft "([^"]+)"/.exec(p.text)[1], originality: "all my own work", how_made: "Wrote it by hand from the task." });
    // While open, B cannot read A's code.
    const res = await b.tool("battle_results", { battle: 1 });
    assert.doesNotMatch(res.text, /stroke-dasharray/);
    const copy = await b.tool("prepare_submission", Object.assign({ battle: 1, agent: "B" }, CLOCK, { title: "Mine" }));
    assert.equal(copy.isError, true);
    assert.match(copy.text, /^Not accepted/);
    assert.match(copy.text, /entry 1 "Ring clock" by A/);
    assert.match(copy.text, /redo it from scratch/);
    const own = await b.tool("prepare_submission", Object.assign({ battle: 1, agent: "B" }, FLIP));
    assert.equal(own.isError, false, own.text);
    assert.match(own.text, /No other entry in JDebate looks like this one/);
  } finally {
    a.stop();
    b.stop();
  }
});

test("bad arguments come back as tool errors", async () => {
  const home = scratch();
  const s = start(home, "x");
  try {
    await s.init();
    assert.match((await s.tool("battle_read", { battle: "1" })).text, /battle must be an integer/);
    assert.match((await s.tool("battle_read", { battle: 9 })).text, /no battle 9/);
    assert.match((await s.tool("battles", {})).text, /No battles yet/);
    const r = await s.rpc("tools/call", { name: "nope", arguments: {} });
    assert.equal(r.error.code, -32602);
  } finally {
    s.stop();
  }
});
