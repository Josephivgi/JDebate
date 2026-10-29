"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("jdebate", {
  stamp: () => call("stamp"),
  battles: () => call("battles"),
  battle: (id) => call("battle", id),
  openBattle: (input) => call("battle-open", input),
  editBattle: (id, patch) => call("battle-edit", id, patch),
  closeBattle: (id) => call("battle-close", id),
  reopenBattle: (id) => call("battle-reopen", id),
  removeBattle: (id) => call("battle-remove", id),
  setWinner: (battleId, entryId) => call("winner", battleId, entryId),
  entry: (id) => call("entry", id),
  removeEntry: (id) => call("entry-remove", id),
  entryFolder: (id) => call("entry-folder", id),
  entryVideo: (id) => call("entry-video", id),
  installState: () => call("install-state"),
  install: (ids) => call("install", ids),
  uninstall: (ids) => call("uninstall", ids),
  startupUpdate: () => call("startup-update"),
  copy: (text) => call("copy", text),
  reveal: (file) => call("reveal", file),
  appUpdate: {
    state: () => call("app-update-state"),
    check: () => call("app-update-check"),
    download: () => call("app-update-download"),
    install: () => call("app-update-install"),
    releases: () => call("app-releases"),
    onChange: (fn) => ipcRenderer.on("app-update", (_e, s) => fn(s)),
  },
});
