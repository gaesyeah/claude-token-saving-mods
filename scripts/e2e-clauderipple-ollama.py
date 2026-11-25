#!/usr/bin/env python3
"""Live ClaudeRipple catalogue -> worker selection -> local Ollama generation smoke test.

This intentionally does not start Claude Code or call its interactive UI. It reads
ClaudeRipple's loopback admin APIs, selects the first usable agent on the active
"light" rung, then sends a real prompt to Ollama's local HTTP API.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

TIMEOUT = 10
PROMPT = "Reply with exactly: CLAUDERIPPLE_OLLAMA_E2E_OK"


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def get_json(url: str, timeout: int = TIMEOUT) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        fail(f"GET {url} failed: {exc}")


def post_json(url: str, payload: dict[str, Any], timeout: int = 120) -> Any:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        fail(f"POST {url} returned HTTP {exc.code}: {detail}")
    except Exception as exc:
        fail(f"POST {url} failed: {exc}")


def settings_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    nested = value.get("settings")
    return nested if isinstance(nested, dict) else value


def effective_rungs(settings: dict[str, Any]) -> dict[str, Any]:
    active_id = settings.get("activeMode")
    modes = settings.get("modes")
    if isinstance(active_id, str) and isinstance(modes, list):
        active = next((m for m in modes if isinstance(m, dict) and m.get("id") == active_id), None)
        if isinstance(active, dict) and isinstance(active.get("rungs"), dict):
            return active["rungs"]
    rules = settings.get("rules")
    general = rules.get("general") if isinstance(rules, dict) else None
    if isinstance(general, dict) and isinstance(general.get("rungs"), dict):
        return general["rungs"]
    rungs = settings.get("rungs")
    return rungs if isinstance(rungs, dict) else {}


def is_allowed(agent: str, provider: str, settings: dict[str, Any]) -> bool:
    allow = settings.get("allow") if isinstance(settings.get("allow"), list) else []
    known = settings.get("allowKnown") if isinstance(settings.get("allowKnown"), list) else []
    return not allow or agent in allow or provider in allow or (bool(known) and agent not in known)


def resolve_light(options: dict[str, Any], settings: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    agents = options.get("agents") if isinstance(options.get("agents"), list) else []
    providers = options.get("providers") if isinstance(options.get("providers"), list) else []
    models = options.get("models") if isinstance(options.get("models"), list) else []
    provider_by_name = {p.get("name"): p for p in providers if isinstance(p, dict)}
    rungs = effective_rungs(settings)
    configured = rungs.get("light")
    entries = configured if isinstance(configured, list) else ([configured] if isinstance(configured, dict) else [])
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        if not isinstance(target, dict) or not isinstance(target.get("agent"), str):
            continue
        name = target["agent"]
        matches = [a for a in agents if isinstance(a, dict) and a.get("name") == name]
        if len(matches) != 1:
            continue
        agent = matches[0]
        provider_name = agent.get("provider")
        provider = provider_by_name.get(provider_name)
        if not isinstance(provider, dict) or provider.get("usable") is not True:
            continue
        if isinstance(settings.get("providers"), dict) and settings["providers"].get(provider_name) is False:
            continue
        if not is_allowed(name, provider_name, settings):
            continue
        model = agent.get("model")
        model_matches = [
            m for m in models
            if isinstance(m, dict) and m.get("model") == model and m.get("provider") == provider_name
        ]
        if len(model_matches) != 1 or model_matches[0].get("judgeOnly") is True:
            continue
        unavailable = provider.get("models")
        if isinstance(unavailable, dict) and (unavailable.get(model) or unavailable.get(f"{provider_name}:{model}")):
            continue
        efforts = agent.get("efforts") if isinstance(agent.get("efforts"), list) else []
        requested_effort = entry.get("effort")
        effort = requested_effort if isinstance(requested_effort, str) and requested_effort in efforts else None
        return agent, effort
    fail("no usable agent could be resolved from the active ClaudeRipple light rung")
    raise AssertionError("unreachable")


def main() -> None:
    home = Path(os.environ.get("CLAUDERIPPLE_HOME", str(Path.home() / ".clauderipple"))).expanduser()
    config_path = home / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"cannot read {config_path}: {exc}")

    admin = config.get("admin") if isinstance(config, dict) else None
    listen = config.get("listen") if isinstance(config, dict) else None
    port = admin.get("port") if isinstance(admin, dict) else None
    if port is None and isinstance(listen, dict):
        listen_port = listen.get("port")
        if isinstance(listen_port, int):
            port = listen_port + 1
    if not isinstance(port, int) or not 1 <= port <= 65535:
        fail("admin port not found in config.json (expected admin.port or listen.port + 1)")

    base = f"http://127.0.0.1:{port}"
    options = get_json(base + "/api/mod-options")
    settings_response = get_json(base + "/api/mod-settings")
    settings = settings_payload(settings_response)
    if not isinstance(options, dict) or not isinstance(options.get("models"), list):
        fail("/api/mod-options returned an unexpected catalogue")

    agent, effort = resolve_light(options, settings)
    model = agent["model"]
    provider = agent["provider"]
    if "ollama" not in provider.lower():
        fail(f"active light rung resolved to provider {provider!r}, not an Ollama provider; refusing to send the prompt elsewhere")
    print(f"ClaudeRipple admin API: OK (127.0.0.1:{port})")
    print(f"Active light rung: resolved agent={agent['name']} provider={provider} model={model}")
    print(f"Effort forwarded: {effort if effort else 'no (not declared by this agent)'}")

    ollama = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    tags = get_json(ollama + "/api/tags")
    installed = {
        item.get("name") for item in tags.get("models", [])
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    } if isinstance(tags, dict) else set()
    if model not in installed and not any(name.split(":")[0] == model.split(":")[0] for name in installed):
        fail(f"resolved model {model!r} is not installed in Ollama; installed models: {', '.join(sorted(installed)) or '(none)'}")

    result = post_json(ollama + "/api/chat", {
        "model": model,
        "messages": [{"role": "user", "content": PROMPT}],
        "stream": False,
    })
    message = result.get("message", {}) if isinstance(result, dict) else {}
    answer = message.get("content", "") if isinstance(message, dict) else ""
    if not isinstance(answer, str) or not answer.strip():
        fail("Ollama returned no assistant message")
    print(f"Ollama generation: OK (model={result.get('model', model)})")
    print(f"Model response: {answer.strip()}")
    if "CLAUDERIPPLE_OLLAMA_E2E_OK" not in answer:
        fail("Ollama responded, but did not return the expected smoke-test marker")
    print("PASS: live catalogue selection and real local Ollama generation succeeded.")
    print("Note: this verifies catalogue -> model selection -> Ollama HTTP generation; it does not exercise Claude Code's $.model.complete or ClaudeRipple's upstream proxy adapter.")


if __name__ == "__main__":
    main()
