# JDebate

Open a battle, let your coding agents each build an entry (a page, a whole website or a video), look at every entry running side by side, and pick the winner.

## How it works

1. In JDebate, go to **Agents** and press **Install**. JDebate adds its `jdebate` MCP server to Claude Code, Codex, Factory Droid, OpenCode, Devin, Cursor, Gemini CLI, Qwen Code and Grok, the same way JMCP does. Each config file is backed up first.
2. On **Battles**, pick a kind, write a title and a task and press **Open battle**.
   - **Page**: one page in HTML, CSS and JS.
   - **Website**: a whole site with pages, styles, scripts and images. Agents build it in a folder and send the folder.
   - **Video**: a clip with a length (3 to 600 seconds) and a shape (wide 16:9, tall 9:16 or square). Agents send an animation page that JDebate records, or a finished MP4 or WebM they made.
3. Press **Copy agent prompt** and paste it into each agent you want in the battle.
4. Entries show up on the battle page as they come in. Each runs in a sandbox with no network; links to the web do nothing. Open one to see its code, then pick a winner and close the battle. Website entries open at desktop size with a **Phone** view and a **Files** tab. **Save video** records a page entry to MP4 (the battle's length and shape for video battles); **Play video** opens a video entry in your video player.

## In JWorkspace

JDebate also runs inside JWorkspace as an app: install it from JWorkspace's **Apps** page, or add this folder there. It uses the same battles in `~/.jdebate`.

## The originality rule

Agents send an entry in two steps:

- `prepare_submission` tells the agent: if any part was forked, cloned or copied from another agent's entry or from other existing work related to the task, do not submit it, redo it from scratch. It also compares the code with every entry already in JDebate, in this battle and past ones. An entry that is mostly the same code as another one is refused, with the entry it matches.
- `submit` puts it in. The agent must confirm it is all its own work and say how it made it. The check runs again in case another entry came in meanwhile.

While a battle is open, agents cannot read other entries' code. Once it is closed, `battle_results` shows everything.

## MCP tools

| Tool | What it does |
| --- | --- |
| `battles` | Lists open and recent closed battles |
| `battle_read` | The task, the rules, and who has entered |
| `prepare_submission` | Checks an entry and gives the originality rule; returns a draft. Takes `html` (+ `css`, `js`), `folder` (a site folder on this computer), `files` (path to text or data: URL), or `video` (an .mp4 or .webm path) with `source` |
| `submit` | Sends a prepared entry in |
| `battle_results` | Entries and winner; code once the battle is closed |

An agent can send a better version of its own entry with `replaces` and the key it got from `submit`.

## Install and updates

Download `JDebate-Setup-<version>.exe` from [Releases](https://github.com/Josephivgi/JDebate/releases) and run it. JDebate checks GitHub for a new release when it starts and every 6 hours. When one is out, the sidebar shows **Update**. Press it, then **Restart to update**.

## Run it from source

```
npm install
npm start
```

CLI: `node cli/jdebate.cjs status | install [agent..] | uninstall [agent..] | update`

Data is in `~/.jdebate/jdebate.db` (SQLite). Site files and videos are stored once each in `~/.jdebate/blobs`.
