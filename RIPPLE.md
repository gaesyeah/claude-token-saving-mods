# Optional ClaudeRipple integration

The `mods-core` model resolver optionally integrates with ClaudeRipple so compatible mods can use explicitly configured external models for their helper calls. It does not replace the model used by the main Claude Code conversation, and it does not provide authentication or usage credits for any provider.

## How it works

- The resolver reads ClaudeRipple's loopback admin API: `/api/mod-options` for agents, model/provider availability and Claude model aliases; `/api/mod-settings` for worker settings.
- It reads the config at `$CLAUDERIPPLE_HOME/config.json` when that environment variable is set, otherwise `~/.clauderipple/config.json`. The admin API port comes from `admin.port`, falling back to `listen.port + 1`.
- Worker roles map to the general ladder rungs: Low → `light`, Medium → `standard`, High → `hard`, and Max/Plan → `plan`. An active operating mode replaces the base general ladder. Entries are considered in configured order.
- Each external `target.agent` must match exactly one catalogue agent. The resolver checks the mapped model, provider availability, provider enable/disable switches, provider-specific model exhaustion, and ClaudeRipple's worker allow-list semantics.
- Native `general-purpose` targets are resolved only through ClaudeRipple's explicit `claudeLatest` model aliases. No model version is guessed.
- Effort is forwarded only when ClaudeRipple declares that effort for the selected agent/model. Unknown or unsupported effort capabilities are left to the caller's safe default.
- Missing, unavailable, malformed or ambiguous entries are skipped. If no valid target is found, the calling mod retains its existing model fallback.
- Judge resolution prefers the configured Zen model when available; otherwise it can use a unique usable `judgeOnly` model, unless its provider is disabled.

## Automated live smoke tests

Run these from the repository root while ClaudeRipple and Ollama are running:

```bash
python3 scripts/e2e-clauderipple-ollama.py
python3 scripts/e2e-clauderipple-proxy.py
```

The first test checks the live admin catalogue/settings, reproduces the active light-agent selection, and calls the local Ollama API directly. The second sends a harmless Anthropic Messages request through the `HTTPS_PROXY` and CA configured in `~/.claude/settings.json`, using the provider-qualified model ID to exercise ClaudeRipple's actual HTTPS proxy and Ollama adapter. It snapshots request IDs before the call, then requires a new matching `messages` row with the selected provider and HTTP 200 in `~/.clauderipple/logs/requests.jsonl`. It does not need an interactive Claude Code session and does not send an API key. Both tests are smoke tests; neither executes the Claude Code plugin engine's `$.model.complete` hook.

To inspect ClaudeRipple's actual log filenames and JSON metadata without printing prompts or credentials:

```bash
python3 scripts/inspect-clauderipple-logs.py
```

The plugin suites also test the completion-request boundary used by Input Router, Vault and Research Router: resolved model, declared effort only, and the legacy fallback behavior. These are automated contract tests with a mocked engine completion function; they do not invoke a live Claude Code session.

The integration is deliberately optional and fail-safe. If ClaudeRipple is not installed, is stopped, cannot be read, or returns an unsupported catalogue/settings shape, the existing per-mod behavior remains in place. The resolver does not infer providers from model names, rank models heuristically, or silently choose an arbitrary catalogue entry.

## Plugin behavior and accounting

Mods request a helper model through `$.mods.modelResolve`, then make their own model calls with `$.model.complete` and report usage through `$.mods.spent`. The resolver chooses a target; it does not perform the model call or centralize retries. Each mod retains its own retry and fallback behavior, and existing local QMD judges remain earlier in their decision paths.

Token usage is recorded for helper calls across models. USD estimates are available only when a model ID is covered by `mods-core`'s local price table. The main conversation model is never changed by this integration.

## Requirements and limitations

- ClaudeRipple must be running locally, with its admin API reachable on loopback.
- The desired provider and model must already be configured and reported as usable by ClaudeRipple. This resolver does not connect accounts, configure providers, or create model availability.
- A configured worker entry is not proof that its model is available; unavailable entries are skipped and the existing fallback is used.
- Automated tests cover the resolver's settings, availability and fallback rules. A successful end-to-end run still depends on the provider being connected and the selected model being available.
