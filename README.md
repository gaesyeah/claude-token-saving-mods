# token-saving-mods

Nine Claude Code mods (function-hook plugins) that cut token cost, ported from macOS to
**Linux**. They still run on a Mac. Tested on Pop!_OS 24.04 (COSMIC, Wayland) with the Claude
desktop app for Linux and Claude Code 2.1.325.

## The mods

| Mod | What it does | Command |
| --- | --- | --- |
| **input-router** | Big files, PDFs and connector results are read by Haiku first; Claude gets short notes and a path to the full thing. | `/input-router` |
| **effort-optimizer** | Reads each prompt and picks the reasoning effort it needs (low for simple questions). | `/effort-optimizer` |
| **model-router** | Haiku judges each **subagent** task and moves it to Haiku, Sonnet or Opus. Never changes the main chat's model. | `/model-router` |
| **cache-clock** | Countdown until the prompt cache goes cold, minimized to one line with an Expand button. Optional *Keep warm* pings. | `/cacheclock`, `/keepwarm` |
| **handoff** | At 250k tokens, offers *Refresh*: writes a handoff of the chat and starts a fresh chat with it. | `/handoff`, `/fresh` |
| **research-router** | Keeps web research out of the main chat: Haiku shortens big search results; a cheap worker reads pages and returns a brief. | `/research-router` |
| **efficient-browser-use** | Shrinks every browser screenshot before Claude reads it (about 60% fewer tokens), or has Haiku describe it. | `/efficient-browser` |
| **mods** | A switchboard pane to turn each mod on or off in every chat. | `/mods` |
| **savings-proof** | A pane with every token the other mods saved, today and in this chat. | `/savings` |

## Install

```bash
claude plugin marketplace add gaesyeah/token-saving-mods
for m in input-router effort-optimizer model-router cache-clock handoff research-router efficient-browser-use mods savings-proof; do
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
- Linux port by [gaesyeah](https://github.com/gaesyeah).
