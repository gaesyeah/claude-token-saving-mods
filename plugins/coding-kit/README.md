# Coding Kit

Better code for fewer tokens, in two parts.

## 1. Ponytail, always on in code projects

When a chat opens in a code project (a `.git` folder, `package.json`, `pom.xml`, `go.mod` and
similar), the mod adds the [Ponytail](skills/ponytail/SKILL.md) rules to the system prompt: the smallest
change that fully solves the task, no speculative abstractions, a short reply.

- **Why the system prompt and not `/ponytail` per message:** a Skill call is one more API request,
  and each request re-reads the whole chat. In the system prompt the rules are about 800 tokens,
  written to the cache once per chat and read cheaply after that.
- **Who decides when it applies:** the model, for free. The rules say to apply them on coding
  tasks and to answer other questions normally.
- **A project started from zero:** in a folder with no project marker yet, the first prompt that
  reads like code work (a regex, no model call: "crie um app", "implemente", a language or
  framework name, a code block) carries the rules as hidden context, once per chat. The system
  prompt is not touched mid-chat, so the prompt cache is never rewritten; the cost is the same
  ~800 tokens.
- **The desktop app's spare chats:** the app starts a chat early in an empty folder and moves it
  into the project afterwards, so the check is redone whenever the chat's folder changes.
- **Levels:** `off`, `lite`, `full` (default), `ultra`, in the pane or with
  `/coding-kit ponytail <level>`. A change applies from the next chat, so the current chat's
  prompt cache is not rewritten.

## 2. The Coding Kit pane

`/coding-kit` opens a side pane (it also opens by itself at the first prompt about code in a code project; turn that off in the
pane). Every entry has **Usar**, which puts its command in the prompt box for you to complete.

| Group | Entry | Kind |
| --- | --- | --- |
| — | `/coding-kit:ponytail [lite\|full\|ultra]`, the same rules as a command, for any folder | bundled skill |
| Planejar | Interrogar o plano (`/coding-kit:grill-me`), Escrever o plano (`/coding-kit:writing-plans`) | bundled skills |
| Construir | Testes primeiro (`/coding-kit:test-driven-development`), Design de interface (`/coding-kit:frontend-design`) | bundled skills |
| Corrigir | Depurar a fundo (`/coding-kit:systematic-debugging`) | bundled skill |
| Revisar | Verificar antes de dar como pronto (`/coding-kit:verification-before-completion`), Melhorar a arquitetura (`/coding-kit:improve-codebase-architecture`) | bundled skills |
| Revisar | `/code-review`, `/simplify`, `/security-review` | Claude Code built-ins |
| Ferramentas | Context7, Serena, codebase-memory, Graphify | installed from the pane |
| Suas skills | every skill in `~/.claude/skills`, the project's `.claude/skills` and other plugins | found on disk |

- Bundled skills carry `disable-model-invocation: true`: Claude never loads them by itself, so
  they cost no context until you click.
- A prompt that looks like a bug (a stack trace, "não funciona", "erro") marks *Depurar a fundo*
  as suggested and shows one toast. It is a regex: no model call.
- Tools install with one click and a confirm (`claude mcp add --scope user ...`, or `uv tool
  install` for Graphify) and apply to new chats. codebase-memory and Graphify are both code graphs,
  so the pane installs only one of them at a time; Serena goes with either.
- Typing a skill's command at the start of the prompt (`/coding-kit:grill-me`, `/grill-me`, or one of
  your own skills) paints it orange and shows a one-line band with its description. **▾** opens the
  same card as in the pane (without Usar: the command is already typed); **✕** takes only the command
  out of the prompt and keeps the rest of what you typed.
- Serena starts with no project and no dashboard: it activates a project (and creates its `.serena/`
  folder) only when it is used. The first time it does in a chat, a band above the prompt offers to
  open that chat's Serena dashboard.

## Keeping the bundled skills current

The four bundled skills come from GitHub (`skills` in `catalog.json`, the commit of each in
`skills/upstream.lock.json`). The mod checks for changes **at most once a week**, in the
background, with one GitHub request per skill and no model call; a failed check also waits a week.

When one changed, the pane shows *Atualização para N skills* (and one toast), with **Ver mudanças**
for the diff on GitHub. Nothing changes until you press **Atualizar** and **Confirmar**: a skill's
text becomes instructions for Claude, so a third party's change waits for you. The update fits the
upstream text to this mod (frontmatter overrides such as `disable-model-invocation: true`, a credit
line, link rewrites) and applies from the next chat. *↻ Verificar atualizações* checks now.

## Adding a skill or tool

Everything in the pane comes from [catalog.json](catalog.json):

1. Put the skill in `skills/<name>/SKILL.md` with `disable-model-invocation: true` in its
   frontmatter.
2. Add an item to `catalog.json`:

   ```json
   { "id": "my-skill", "kind": "skill", "group": "build", "label": "My skill",
     "command": "/coding-kit:my-skill", "description": "When to use it." }
   ```

   `kind` is `skill`, `builtin` (a Claude Code command), `mcp` (with `server`, `install`,
   `uninstall`) or `tool` (with `check`, `install`, `uninstall` as argv steps). Optional: `fill`
   (text put in the prompt instead of `command`), `hint` (regex that marks it suggested),
   `exclusive` (a group of which only one can be installed), `needs` (binaries required first),
   `source`. New groups go in `groups`.
3. Press **↻ Reler instalados e skills do disco** in the pane, or open a new chat.

## Credits

- `grill-me` (the `grilling` skill) and `improve-codebase-architecture` are from
  [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, Copyright (c) 2026 Matt Pocock);
  its links to skills not included here are rewritten.
- `frontend-design` is from [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0, see its `LICENSE.txt`).
- `systematic-debugging`, `test-driven-development`, `writing-plans` and `verification-before-completion` are from
  [obra/superpowers](https://github.com/obra/superpowers) (MIT, Copyright (c) 2025 Jesse Vincent),
  with links to superpowers skills not included here rewritten.
- `ponytail` is from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT);
  the system-prompt rules are read from this one copy.
