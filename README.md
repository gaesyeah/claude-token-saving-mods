# token-saving-mods

Eleven Claude Code mods (function-hook plugins) that cut token cost, ported from macOS to
**Linux**, plus a **Coding Kit** for better code at lower cost. They still run on a Mac. Tested on Pop!_OS 24.04 (COSMIC, Wayland) with the Claude
desktop app for Linux and Claude Code 2.1.325.

## The mods

| Mod | What it does | Command |
| --- | --- | --- |
| **mods-core** | What the other mods share, installed first: one layout for their rows above the prompt (a subtle rule between two rows, never above the first, the same spacing), and the helpers they used to copy, on `$.mods` (paths, /mods switches, logs, the savings ledger, opening files, qmd and its daemon, the local judge). Every other mod lists it under `dependencies`. Nothing to switch on or off. | none |
| **input-router** | Big files, PDFs and connector results are read by Haiku first; Claude gets short notes and a path to the full thing. | `/input-router` |
| **effort-optimizer** | Reads each prompt and picks the reasoning effort it needs (low for simple questions; bug diagnosis and diff review at least medium, architecture, security and migrations high). If a level change ever rewrites the prompt cache, it stops changing levels in that chat. With qmd up (Local Models), a local judge answers prompts much like ones Sonnet already judged, without calling it; 1 in 5 of those is still asked of Sonnet and compared, and too little agreement stops the local judge (status in `/effort-optimizer`). | `/effort-optimizer` |
| **model-router** | Haiku judges each **subagent** task and moves it to Haiku, Sonnet or Opus. Never changes the main chat's model. With qmd up (Local Models), a local judge answers prompts much like ones Haiku already judged, without calling it; 1 in 5 of those is still asked of Haiku and compared, and too little agreement stops the local judge (status in `/model-router`). | `/model-router` |
| **cache-clock** | Countdown until the prompt cache goes cold, minimized to one line with an Expand button. Optional *Keep warm* pings. | `/cacheclock`, `/keepwarm` |
| **handoff** | At 250k tokens, offers *Refresh*: writes a handoff of the chat and starts a fresh chat with it. | `/handoff`, `/fresh` |
| **research-router** | Keeps web research out of the main chat: Haiku shortens big search results; a cheap worker reads pages and returns a brief. | `/research-router` |
| **efficient-browser-use** | Shrinks every browser screenshot before Claude reads it (about 60% fewer tokens), or has Haiku describe it. | `/efficient-browser` |
| **mods** | A switchboard pane to turn each mod on or off in every chat. | `/mods` |
| **savings-proof** | A pane with every token the other mods saved, today and in this chat. | `/savings` |
| **coding-kit** | Ponytail rules always on in code projects (cached system prompt, no per-message skill calls) and a side pane of one-click coding skills (Matt Pocock's 31 among them) and tools (Context7, Serena, codebase-memory, Graphify, rtk, lean-ctx, context-mode, Modern Web Guidance), each install showing what it changes first. See [its README](plugins/coding-kit/README.md). | `/coding-kit` |
| **quota-meter** | Status line with the 5-hour and weekly limits used, and the average points each turn spends (the limits move in whole points, so it averages the last 40 turns). Read only. | `/quota` |
| **tool-diet** | Big tools a project has not used in its last chats move behind ToolSearch, only when that saves 5k tokens or more. Bash, Read, Edit, Write, Grep, Glob, Agent and Skill never move. Decided when a chat starts, so the cache is never broken. | `/tool-diet` |
| **vault** | A second brain in an Obsidian vault, as plain Markdown (Obsidian can stay closed). Sets itself up on the first chat, or on `/vault` in a chat already open (a vault Obsidian knows, else `~/Documents/Vault`; a PARA or Zettelkasten pick in the band when empty, your own structure when it has notes) and says so in a purple band; `/vault use` and `/vault setup para`, `zettel` or `existing` change it. It copies handoffs and research briefs in with links to their project, keeps a daily note, and hints the notes that match each prompt (path and one line, never the whole note). Search is ripgrep for words plus [qmd](https://github.com/tobi/qmd) vectors and reranker through its local daemon when installed (about 0.3-0.7 s a prompt). `/vault save`, `ask`, `inbox`, `review`; ask, inbox and review come with what the mod already found (search hits, orphans, broken links, stale projects), so Claude opens fewer notes. `/vault` shows how many hinted notes Claude opened and the reranker scores of the last 20 meaning hints. To calibrate: find hints unrelated to their prompt in `~/.claude/mods-logs/vault/vault.log` (lines `hint:` with `qmd 0.xx`) and raise the cut above their scores with `/vault corte 0.5` (default 0.4). With a qmd other than 2.x, or something other than qmd on port 8181, hints use ripgrep only; turning the mod off in `/mods` stops the daemon it started, never one it did not. `/vault` opens a side pane with its state, a button per command and the last hints; a prompt qmd searched shows one low purple line above the chat (time and notes found). | `/vault` |
| **local-models** | Keeps qmd's local models (embedding and reranker) running on your CPU for vault's search and the local judges of Effort Optimizer and Model Router: no tokens. With no qmd, an orange band offers to install it, and Node 22 through Volta when Node is missing or older (no sudo); each chat start brings its daemon up. | `/local-models` |

## Install

```bash
claude plugin marketplace add gaesyeah/claude-token-saving-mods
for m in mods-core input-router effort-optimizer model-router cache-clock handoff research-router efficient-browser-use mods savings-proof coding-kit quota-meter tool-diet vault local-models; do
  claude plugin install "$m@token-saving-mods"
done
```

Then open a **new chat** (mods load when a chat starts) and type `/mods`.

From a local clone, use `claude plugin marketplace add /path/to/token-saving-mods` instead.

### Optional tools

Each mod works without these; only the feature that needs the tool is skipped.

```bash
# Debian / Ubuntu / Pop!_OS
sudo apt install imagemagick wl-clipboard xclip poppler-utils
# Fedora
sudo dnf install ImageMagick wl-clipboard xclip poppler-utils
# Arch
sudo pacman -S imagemagick wl-clipboard xclip poppler
```

- **ImageMagick** (or libvips, ffmpeg, Pillow): efficient-browser-use resizes screenshots.
- **wl-clipboard / xclip**: handoff's *Copy* button.
- **poppler**: input-router reads PDFs.
- **xdg-utils**: the *Open* buttons (installed on most desktops).
- **ripgrep**: vault's search without qmd. **qmd** (`npm install -g @tobilu/qmd`, Node 22+, ~2 GB of local models on first index): vault's search by meaning: two local models (embedding and reranker, no Claude tokens) that find notes said in other words and drop unrelated hints; optional, the vault works on words without it; the Local Models mod offers to install it (and Node 22 through Volta, no sudo). Then `/vault index`; [INSTALL.md](INSTALL.md) has a one-line install. The mod starts `qmd mcp --http --daemon` on localhost:8181; it holds ~1 GB of RAM while its models are loaded and unloads them after 5 idle minutes.

See [INSTALL.md](INSTALL.md) for the full table, macOS notes and troubleshooting.

## What changed from the macOS version

- **efficient-browser-use**: `sips` replaced by the first image tool found (ImageMagick 7/6,
  `vipsthumbnail`, `ffmpeg`, Pillow, then `sips`). Image size is read from the file header in
  the mod itself; `base64 -D` became the portable `base64 -d`.
- **handoff**: `pbcopy` replaced by `wl-copy` / `xclip` / `xsel` / `pbcopy`, with the app's own
  copy as a fallback. `open` replaced by `xdg-open` / `gio open` / `open`.
- **savings-proof, model-router, research-router**: `open` replaced the same way.
- **research-router**: finds Firecrawl in Linuxbrew, Volta and pnpm folders, and asks the
  login shell from `$SHELL` (bash, zsh or fish) instead of a fixed `/bin/zsh`.
- **input-router**: also looks for Poppler in Linuxbrew.
- **cache-clock**: the band starts minimized (clock and progress bar only) with an
  *Expand / Minimize* button; expanded, the buttons sit beside the clock and the text below it.

## Logs

Everything the mods write goes to `~/.claude/mods-logs/`. If a mod misbehaves, turn it off in
`/mods`; the others keep working.

## Credits

- Original mod pack by **Ben AI** ([benai.co](https://www.benai.co)).
- **model-router** is based on the Jev Model Router from
  [claude-code-templates](https://github.com/davila7/claude-code-templates) (MIT, see
  [plugins/model-router/LICENSE](plugins/model-router/LICENSE)).
- Coding Kit bundles skills from [mattpocock/skills](https://github.com/mattpocock/skills),
  [obra/superpowers](https://github.com/obra/superpowers) (both MIT) and
  [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0).
- Linux port and Coding Kit by [gaesyeah](https://github.com/gaesyeah).
