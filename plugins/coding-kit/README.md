# Coding Kit

Better code for fewer tokens, in two parts.

## 1. Ponytail, always on in code projects

When a chat opens in a code project (a `.git` folder, `package.json`, `pom.xml`, `go.mod` and
similar), the mod adds the [Ponytail](rules/ponytail.md) rules to the system prompt: the smallest
change that fully solves the task, no speculative abstractions, a short reply.

- **Why the system prompt and not `/ponytail` per message:** a Skill call is one more API request,
  and each request re-reads the whole chat. In the system prompt the rules are about 800 tokens,
  written to the cache once per chat and read cheaply after that.
- **Who decides when it applies:** the model, for free. The rules say to apply them on coding
  tasks and to answer other questions normally.
- **Levels:** `off`, `lite`, `full` (default), `ultra`, in the pane or with
  `/coding-kit ponytail <level>`. A change applies from the next chat, so the current chat's
  prompt cache is not rewritten.

## 2. The Coding Kit pane

`/coding-kit` opens a side pane (it also opens by itself in code projects; turn that off in the
pane). Every entry has **Usar**, which puts its command in the prompt box for you to complete.

| Group | Entry | Kind |
| --- | --- | --- |
| Planejar | Interrogar o plano (`/coding-kit:grill-me`) | bundled skill |
| Construir | Testes primeiro (`/coding-kit:test-driven-development`) | bundled skill |
| Corrigir | Depurar a fundo (`/coding-kit:systematic-debugging`) | bundled skill |
| Revisar | `/code-review`, `/simplify`, `/security-review` | Claude Code built-ins |
| Ferramentas | Context7, Serena, codebase-memory, Graphify | installed from the pane |
| Suas skills | every skill in `~/.claude/skills`, the project's `.claude/skills` and other plugins | found on disk |

- Bundled skills carry `disable-model-invocation: true`: Claude never loads them by itself, so
  they cost no context until you click.
- A prompt that looks like a bug (a stack trace, "não funciona", "erro") marks *Depurar a fundo*
  as suggested and shows one toast. It is a regex: no model call.
- Tools install with one click and a confirm (`claude mcp add --scope user ...`, or `uv tool
  install` for Graphify) and apply to new chats. Serena, codebase-memory and Graphify do the same
  job, so the pane installs only one of them at a time.

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
3. Press **↻ Atualizar** in the pane, or open a new chat.

## Credits

- `grill-me` is the `grilling` skill from [mattpocock/skills](https://github.com/mattpocock/skills)
  (MIT, Copyright (c) 2026 Matt Pocock).
- `systematic-debugging` and `test-driven-development` are from
  [obra/superpowers](https://github.com/obra/superpowers) (MIT, Copyright (c) 2025 Jesse Vincent),
  with links to superpowers skills not included here rewritten.
- Ponytail rules: MIT, from the Ponytail skill.
