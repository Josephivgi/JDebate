"use strict";

// JDebate as a JWorkspace app. JWorkspace reads jworkspace.json, loads the
// same window (renderer/ and preload.cjs) in its own view, and calls
// activate() in its main process with a context for that view: handlers,
// the app's session, the theme JWorkspace owns, and a way to send events.
// Battles and entries stay in ~/.jdebate, shared with the jdebate MCP server.

const { createBackend } = require("./backend.cjs");
const pkg = require("../package.json");

function activate(ctx) {
  const backend = createBackend({
    home: process.env.JDEBATE_TEST_HOME || undefined,
    smoke: ctx.smoke,
    handle: ctx.handle,
    theme: ctx.theme,
    session: ctx.session,
    updater: { packaged: false, version: pkg.version },
    onUpdate: (s) => ctx.send("app-update", s),
  });
  ctx.protocol.handle("jdebate-preview", backend.preview);
}

module.exports = { activate };
