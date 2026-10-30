# JDebate agent instructions

JDebate is an Electron app plus one stdio MCP server (`jdebate`). The user opens a battle with a task and a kind (page, website, video); coding agents read it through MCP, build an entry, and send it in: HTML/CSS/JS, a site folder, or a video file. Before an entry goes in, the agent is told the originality rule and the entry is checked against every other entry.

## Layout

- `app/`: Electron app. `backend.cjs` (every IPC handler and the preview scheme, shared by both hosts), `workspace.cjs` (JDebate as a JWorkspace app; `jworkspace.json` at the root points JWorkspace at the page, preload and this file), `main.cjs` (standalone window, IPC, the `jdebate-preview:` scheme: `jdebate-preview://<entry id>/<path>` serves an entry and its files with byte ranges, each entry its own origin and CSP), `video.cjs` (records an entry to MP4 at the battle's size), `preload.cjs`, `renderer/` (build DOM with `h()` and text nodes, never `innerHTML` with data).
- `server/`: the MCP server. `server.cjs` (tools), `lib/store.js` (SQLite, shared with the app; new columns are added in `setup()` with defaults so older server copies keep working), `lib/files.js` (site folders and video files, stored by sha256 in `~/.jdebate/blobs`), `lib/similarity.js` (copy check: html, css, js plus a site's other text files or a video's source; the same video file twice is an exact copy), `lib/rpc.js` (copied from JMCP).
- `core/agents.cjs`: copied from JMCP. Edits each agent's MCP config in place, `.jdebate-backup` on first change.
- `core/install.cjs`: copies `server/` to `~/.jdebate/server` and adds the `jdebate` entry to agents, like JMCP's catalog.
- `cli/jdebate.cjs`: `status | install [agent..] | uninstall [agent..] | update`.

## Rules

- Data lives in `~/.jdebate/jdebate.db` (`node:sqlite`, WAL). `JDEBATE_HOME` overrides it; tests use a scratch home.
- Check-then-write runs in one `BEGIN IMMEDIATE` transaction. Agents use battle and entry numbers, the app uses ids.
- Battle numbers are never reused.
- Entry code is hidden from agents while a battle is open.
- Change the server: bump `server/package.json` `version` so installed copies update when the app starts.
- Every child process starts hidden (`windowsHide: true`). UI checks use `--smoke` (offscreen, no window) or a VM, never the host desktop.
- The app updates itself from GitHub Releases of the public repo `Josephivgi/JDebate` (`app/updater.cjs`, electron-updater). Release with `npm version patch && git push --follow-tags`; `.github/workflows/release.yml` builds the installer and uploads it to a draft release. Write the user-facing notes, show them to the user, then publish the draft (`gh release edit <tag> --notes-file <file> --draft=false`). Installed apps only see published releases.
- Running Electron from an agent shell: unset `ELECTRON_RUN_AS_NODE` first.

## Tests

`npm test`. Smoke: `electron . --smoke --home <scratch> --page battles|agents|battle-<id>|entry-<id> --out file.png`.

# UI (app-specific layer)

## Product tokens

The JAgents OKLCH set from JMCP (`app/renderer/styles.css` `:root`): canvas, surface, ink, muted, line, accent (violet 285), ok, warn, danger. IBM Plex Sans. Control height 32 px, radius 10/7 px.

Before any UI change: read the token source and match exact values. No second palette.

## Screens to match

JMCP's JMCP servers and Rules pages.

## App UI rules

- One primary action per view; product button styles only.
- Problems get an icon and a label; healthy state is plain text, no colored dots.
- UI copy: plain short sentences, no em-dashes or marketing words.

## Verify

Layers 1 to 3 from `~/.cursor/agent-docs/ui/AGENTS.md` still apply. On violation, rewrite.
