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
| vault (search by words) | ripgrep | `sudo apt install ripgrep` | `sudo dnf install ripgrep` | `sudo pacman -S ripgrep` | `brew install ripgrep` |
| vault (search by meaning, optional) | qmd, Node 22+ | `npm install -g @tobilu/qmd` | same | same | same |

vault searches the notes by words with ripgrep. qmd adds search by meaning: two small local models
(an embedding model and a reranker, ~2 GB downloaded on the first `/vault index`) find a note that says
the same thing in other words and drop the hints that have nothing to do with the prompt. They run on
your CPU, not on Claude, so they cost no tokens; the daemon holds ~1 GB of RAM and unloads after 5
idle minutes. Without qmd the vault works on words alone. With no qmd, the Local Models mod's orange band offers an
*Instalar qmd* button: it installs Node 22 through [Volta](https://volta.sh) in `~/.volta` when Node is
missing or older (no sudo, the system Node is left alone), then qmd, then starts the daemon (the vault indexes its notes on the next chat).
By hand, one command checks Node and installs qmd (if
npm has no write access to its global folder, it moves that folder to `~/.npm-global`, where the mod
also looks):

```bash
bash -c 'node -v | grep -qE "^v(2[2-9]|[3-9][0-9])" || { echo "Node 22+ needed (have $(node -v 2>/dev/null || echo none))"; exit 1; }; npm install -g @tobilu/qmd || { npm config set prefix ~/.npm-global && npm install -g @tobilu/qmd; }'
```

Then run `/vault index` in a chat. If a proxy blocks the model download, stay on ripgrep. With qmd installed
but its daemon down or failing, word matches need a rare word in a note's name (common words of pasted
text would hint unrelated notes), so hints are fewer while it is down. The mod asks it again on each prompt, so hints come back as
soon as it answers; a daemon that is not running comes back with a new chat or `/vault index`.

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

Do not use the plugin upload button for this folder: it holds fourteen mods and the button takes one.

From a terminal:

```bash
claude plugin marketplace add ~/Documents/token-saving-mods
for m in input-router effort-optimizer model-router cache-clock handoff research-router efficient-browser-use mods savings-proof coding-kit quota-meter tool-diet vault local-models; do
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

## If you change the mods

`claude plugin update` installs a mod only when its version number changed. Turn on the repo's git
hooks once per clone:

```bash
git config core.hooksPath .githooks
```

- **pre-commit** bumps the patch version (0.3.2 → 0.3.3) of every mod the commit changes and copies
  it into `.claude-plugin/marketplace.json`. Changes to `*.test.tsx` alone bump nothing. A version
  you set yourself is kept. It refuses a commit where a marketplace version differs from its
  `plugin.json`.
- **post-commit** runs `claude plugin update` for the changed mods that are installed, in the
  background (log in `~/.claude/mods-logs/post-commit.log`). Skip it with `SKIP_MOD_UPDATE=1`.

Tests:

```bash
claude plugin test plugins/coding-kit
```

```bash
python3 -m unittest discover -s tests
```

The first runs a mod's own tests (the other mods with tests work the same way); the second checks the
Coding Kit's catalog entries.

## If something goes wrong

- If `marketplace add` cannot find the folder, the folder you give must hold `.claude-plugin`.
- If a mod does not work, turn it off in the `/mods` pane. The other mods keep working.
- Logs are in `~/.claude/mods-logs/`.
