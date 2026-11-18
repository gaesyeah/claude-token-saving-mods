# Install the token-saving mods (Linux and macOS)

Tested on Pop!_OS 24.04 (COSMIC, Wayland) with the Claude desktop app for Linux. The same
code still runs on a Mac.

## What you need

- Claude Code 2.1.287 or newer in the terminal, or 2.1.286 or newer in the desktop app.
- `python3` (cache-clock). It ships with every mainstream distro and with macOS.

Some mods use extra tools. They work without them; that part is just skipped.

| Mod | Tool | Debian / Ubuntu / Pop!_OS | Fedora | Arch | macOS |
| --- | --- | --- | --- | --- | --- |
| efficient-browser-use | an image tool: ImageMagick, libvips, ffmpeg or Pillow | `sudo apt install imagemagick` | `sudo dnf install ImageMagick` | `sudo pacman -S imagemagick` | `sips`, built in |
| handoff (Copy button) | a clipboard tool | `sudo apt install wl-clipboard` (Wayland) or `xclip` (X11) | `sudo dnf install wl-clipboard xclip` | `sudo pacman -S wl-clipboard xclip` | `pbcopy`, built in |
| handoff, savings-proof, model-router, research-router (open buttons) | `xdg-open` | `xdg-utils` (usually installed) | `xdg-utils` | `xdg-utils` | `open`, built in |
| input-router (PDFs) | `pdftotext`, `pdfinfo` | `sudo apt install poppler-utils` | `sudo dnf install poppler-utils` | `sudo pacman -S poppler` | `brew install poppler` |
| research-router (optional) | Firecrawl CLI | `npm i -g firecrawl-cli` | same | same | same |

handoff's "Start new chat" button opens a `claude://` link, which the Linux desktop app registers
for itself (`xdg-mime query default x-scheme-handler/claude` should print the Claude `.desktop` file).

## What changed for Linux

- efficient-browser-use: macOS `sips` replaced by the first image tool found (ImageMagick 7/6,
  `vipsthumbnail`, `ffmpeg`, Python Pillow, then `sips`). The picture size is read from the file
  header in the mod itself, and `base64 -D` became the portable `base64 -d`.
- handoff: `pbcopy` replaced by `wl-copy` / `xclip` / `xsel` / `pbcopy`, with the app's own copy as
  a last resort. `open` replaced by `xdg-open` / `gio open` / `open`.
- savings-proof, model-router, research-router: `open` replaced the same way.
- research-router: looks for Firecrawl in Linuxbrew, Volta and pnpm folders too, and asks your own
  login shell (`$SHELL`: bash, zsh or fish) instead of a hard-coded `/bin/zsh`.
- input-router: also looks for Poppler in Linuxbrew.

## Steps

Do not use the plugin upload button for this folder: it holds twelve mods and the button takes one.

From a terminal:

```bash
claude plugin marketplace add ~/Documents/token-saving-mods
for m in input-router effort-optimizer model-router cache-clock handoff research-router efficient-browser-use mods savings-proof coding-kit quota-meter tool-diet; do
  claude plugin install "$m@token-saving-mods"
done
```

Or inside Claude Code, type `/plugin marketplace add <folder>` and then
`/plugin install <mod>@token-saving-mods` for each mod.

Then start a new chat in the desktop app (or type `/reload-plugins` in the terminal). Type `/mods`
to open the Mods pane, and `/savings` to open the Savings Proof pane.

## Updating

```bash
claude plugin marketplace update token-saving-mods
```

Then start a new chat, or type `/reload-plugins`.

## If something goes wrong

- If `marketplace add` cannot find the folder, the folder you give must hold `.claude-plugin`.
- If a mod does not work, turn it off in the `/mods` pane. The other mods keep working.
- Logs are in `~/.claude/mods-logs/`.
