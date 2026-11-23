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
pane). Every section starts hidden: **▸ Mostrar** opens it. **Usar** puts an entry's command in the prompt box for you to complete.

| Section | Entries | Kind |
| --- | --- | --- |
| — | `/coding-kit:ponytail [lite\|full\|ultra]`, the same rules as a command, for any folder | bundled skill |
| Planejar | Escrever o plano (`/coding-kit:writing-plans`) | bundled skill |
| Construir | Testes primeiro (`/coding-kit:test-driven-development`), Design de interface (`/coding-kit:frontend-design`), Modern Web Guidance | bundled skills, a plugin |
| Corrigir | Depurar a fundo (`/coding-kit:systematic-debugging`) | bundled skill |
| Revisar | Verificar antes de dar como pronto (`/coding-kit:verification-before-completion`), `/code-review`, `/simplify`, `/security-review` | bundled skill, Claude Code built-ins |
| Matt Pocock | all 31 skills of [mattpocock/skills](https://github.com/mattpocock/skills) (engineering, productivity, misc), with **Qual skill usar?** first | bundled skills |
| Ferramentas | Context7, Serena, codebase-memory, Graphify, rtk, lean-ctx, context-mode | installed from the pane |
| Suas skills | every skill in `~/.claude/skills`, the project's `.claude/skills` and other plugins | found on disk |

### What costs context

- Bundled skills carry `disable-model-invocation: true`: Claude never loads them by itself, so they cost
  no context until you click.
- Eight are the exception, about 450 tokens of descriptions in every chat in all:
  - `verification-before-completion`, because it stops a false "done" (and the turn spent redoing it);
  - the seven Matt Pocock skills other skills call through the Skill tool (`grilling`, `tdd`, `code-review`,
    `codebase-design`, `domain-modeling`, `prototype`, `research`), or `grill-me`, `implement` and the
    others would break.
- **Recommended tools:** Context7 (its tools sit behind tool search: almost no context) and rtk (it cuts
  tokens). They carry **★ recomendado**, and **Instalar os recomendados** installs the missing ones after
  one confirm that lists everything they change. Nothing installs by itself: both change the global Claude
  Code config.

### Tools

- Every install shows **what it changes** before Confirmar (files, global or per project, how to undo).
- Each step runs with `~/.local/bin` on the PATH and the tool's own variables (telemetry off). A check
  step stops the install if the output is wrong, and a half-done install is undone with the tool's remove
  steps.
- Cards get extra buttons once installed:
  - **Economia** (rtk, lean-ctx, context-mode);
  - **Usar sempre** (Context7: a rule between markers in `~/.claude/CLAUDE.md`, taken out the same way);
  - **Preparar este projeto** (Serena: `serena project index`);
  - **Indexar este projeto** (codebase-memory);
  - **Pôr graphify-out/ no .gitignore** (Graphify).
- A card shows *✓ pronto neste projeto* when the project holds the tool's folder.
- Only one tool of a group installs at a time, and the card says why:
  - **code graphs:** codebase-memory or Graphify;
  - **shrink the output:** rtk, lean-ctx or context-mode.
- lean-ctx and context-mode do the input-router's job: their cards say so and offer **Desligar o
  input-router** (and **Religar**), written to `~/.claude/mods/switches.json` like the `/mods` pane does.
- Serena installs the way its README says (`uv tool install -p 3.13 serena-agent`) and starts with no
  project and no dashboard. The first time it activates a project in a chat, a band above the prompt
  offers that chat's dashboard.

### Matt Pocock's skills

- **Configurar este repositório** runs `/coding-kit:setup-matt-pocock-skills` (issue tracker, triage
  labels, docs layout). Until it has run (`docs/agents/issue-tracker.md` exists), the five skills that
  need it (`to-spec`, `to-tickets`, `triage`, `wayfinder`, `implement-spec`) show *precisa configurar
  antes* instead of Usar.
- Their links to each other point at this plugin (`/coding-kit:…`, `coding-kit:<skill>` for the Skill tool).

### The prompt

- A prompt that looks like a bug (a stack trace, "não funciona", "erro") marks *Depurar a fundo* as
  suggested and shows one toast. It is a regex: no model call.
- Typing a skill's command at the start of the prompt (`/coding-kit:grill-me`, `/grill-me`, or one of
  your own skills) shows a one-line band with its description:
  - **▾** opens the same card as in the pane (without Usar: the command is already typed);
  - **✕** takes only the command out of the prompt and keeps the rest of what you typed.
  - The pane's Usar for that skill reads *já no prompt*.

## Keeping the bundled skills current

The bundled skills come from GitHub (`skills` in `catalog.json`, the commit of each in
`skills/upstream.lock.json`).

- **When it checks:** at most once a week, in the background, with no model call. A failed check also
  waits a week.
- **How many requests:** one GitHub request per repo, on the folder its skills share. Only a repo where
  something changed costs one more request per skill.

When one changed, the pane shows *Atualização para N skills* (and one toast), with **Ver mudanças** for
the diff on GitHub.

- **Nothing changes until you confirm:** press **Atualizar** and **Confirmar**. A skill's text becomes
  instructions for Claude, so a third party's change waits for you.
- **What an update does:**
  - brings the whole folder, subfolders too, but a folder the source excludes (another agent's
    `agents/`);
  - fits the text to this mod: frontmatter overrides, a credit line, link rewrites;
  - applies from the next chat.
- *↻ Verificar atualizações* checks now.

## Adding a skill or tool

Everything in the pane comes from [catalog.json](catalog.json):

1. Put the skill in `skills/<name>/SKILL.md` with `disable-model-invocation: true` in its
   frontmatter.
2. Add an item to `catalog.json`:

   ```json
   { "id": "my-skill", "kind": "skill", "group": "build", "label": "My skill",
     "command": "/coding-kit:my-skill", "description": "When to use it." }
   ```

   **`kind`:**
   - `skill`;
   - `builtin`: a Claude Code command;
   - `mcp`: with `server`, `install`, `uninstall`;
   - `tool`: with `check`, `install`, `uninstall`;
   - `plugin`: with `plugin` (`name@marketplace`) and `marketplace` (`owner/repo`); the install and
     remove steps are made from them unless given.

   **Steps:** an argv array, or `{ "argv": [...], "match": "text" }` for a check that stops the install.

   **Optional fields:**
   - `fill`: text put in the prompt instead of `command`;
   - `hint`: a regex that marks the item suggested;
   - `exclusive`: a group of which only one can be installed, with its reason in `exclusives`;
   - `needs`: binaries required first;
   - `env`: variables for every step;
   - `changes`: lines shown before Confirmar;
   - `actions`: extra buttons, each with `run`, `rule` or `fill`;
   - `overlapsMod`: `{ "mod", "why" }`;
   - `prepared`: a path in the project;
   - `sub`: a heading inside the group;
   - `needsSetup`: waits for the group's `setup`;
   - `recommended`;
   - `source`, `repo`.

   New groups go in `groups`, with an optional `setup` (`label`, `command`, `done`).
3. Press **↻ Reler instalados e skills do disco** in the pane, or open a new chat.

The pane's behaviour is tested with `claude plugin test plugins/coding-kit`. The catalog's own entries
(what each tool installs, checks, undoes and warns about, and the bundled Matt Pocock skills) are tested
with `python3 -m unittest discover -s tests` from the repo root.

## Credits

- The 31 skills in the Matt Pocock section, `grill-me` and `improve-codebase-architecture` among them, are
  from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, Copyright (c) 2026 Matt Pocock); their
  links to each other are rewritten to this plugin.
- `frontend-design` is from [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0, see its `LICENSE.txt`).
- `systematic-debugging`, `test-driven-development`, `writing-plans` and `verification-before-completion` are from
  [obra/superpowers](https://github.com/obra/superpowers) (MIT, Copyright (c) 2025 Jesse Vincent),
  with links to superpowers skills not included here rewritten.
- `ponytail` is from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT);
  the system-prompt rules are read from this one copy.
- The tools are installed from their own projects, not bundled:
  - [Context7](https://github.com/upstash/context7);
  - [Serena](https://github.com/oraios/serena);
  - [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp);
  - [Graphify](https://github.com/Graphify-Labs/graphify);
  - [rtk](https://github.com/rtk-ai/rtk) (Apache edition);
  - [lean-ctx](https://github.com/yvgude/lean-ctx);
  - [context-mode](https://github.com/mksglu/context-mode) (ELv2);
  - [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance).
