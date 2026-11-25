#!/usr/bin/env python3
"""Exercise ClaudeRipple's real HTTPS CONNECT proxy with a harmless Ollama prompt.

Unlike e2e-clauderipple-ollama.py, this sends an Anthropic Messages request through
ClaudeRipple's configured HTTPS_PROXY listener. It uses the CA configured for
Claude Code, asks for a provider-qualified local model, and never uses Claude
account credentials or an external provider key.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PROMPT = "Reply with exactly: CLAUDERIPPLE_PROXY_E2E_OK"
TIMEOUT = 90


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"cannot read {path}: {exc}")
    if not isinstance(value, dict):
        fail(f"{path} does not contain a JSON object")
    return value


def env_setting(settings: dict[str, Any], key: str) -> str | None:
    env = settings.get("env")
    value = env.get(key) if isinstance(env, dict) else None
    if isinstance(value, str) and value.strip():
        return value.strip()
    value = os.environ.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def load_proxy_settings() -> tuple[str, Path]:
    settings_path = Path.home() / ".claude" / "settings.json"
    settings = read_json(settings_path)
    proxy = env_setting(settings, "HTTPS_PROXY") or env_setting(settings, "https_proxy")
    ca_value = env_setting(settings, "NODE_EXTRA_CA_CERTS")
    if not proxy:
        fail(f"HTTPS_PROXY not found in {settings_path} or process environment")
    if not ca_value:
        fail(f"NODE_EXTRA_CA_CERTS not found in {settings_path} or process environment")

    parsed = urllib.parse.urlparse(proxy)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port:
        fail("HTTPS_PROXY must point to ClaudeRipple's local HTTP CONNECT proxy (127.0.0.1)")
    ca_file = Path(ca_value).expanduser()
    if not ca_file.is_file():
        fail(f"ClaudeRipple CA file does not exist: {ca_file}")
    return proxy, ca_file


def active_light_target(home: Path) -> tuple[str, str]:
    config = read_json(home / "config.json")
    admin = config.get("admin") if isinstance(config.get("admin"), dict) else {}
    listen = config.get("listen") if isinstance(config.get("listen"), dict) else {}
    admin_port = admin.get("port")
    if not isinstance(admin_port, int):
        listen_port = listen.get("port")
        admin_port = listen_port + 1 if isinstance(listen_port, int) else None
    if not isinstance(admin_port, int):
        fail("cannot determine ClaudeRipple admin port from config.json")

    def get(url: str) -> dict[str, Any]:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            fail(f"cannot query ClaudeRipple admin API ({url}): {exc}")
        if not isinstance(data, dict):
            fail(f"unexpected JSON from {url}")
        return data

    options = get(f"http://127.0.0.1:{admin_port}/api/mod-options")
    settings_response = get(f"http://127.0.0.1:{admin_port}/api/mod-settings")
    settings = settings_response.get("settings") if isinstance(settings_response.get("settings"), dict) else settings_response
    agents = options.get("agents") if isinstance(options.get("agents"), list) else []
    providers = options.get("providers") if isinstance(options.get("providers"), list) else []
    models = options.get("models") if isinstance(options.get("models"), list) else []
    provider_map = {p.get("name"): p for p in providers if isinstance(p, dict)}

    rungs: dict[str, Any] = {}
    active_id = settings.get("activeMode") if isinstance(settings, dict) else None
    modes = settings.get("modes") if isinstance(settings, dict) else None
    active = next((m for m in modes if isinstance(m, dict) and m.get("id") == active_id), None) if isinstance(active_id, str) and isinstance(modes, list) else None
    if isinstance(active, dict) and isinstance(active.get("rungs"), dict):
        rungs = active["rungs"]
    else:
        rules = settings.get("rules", {}) if isinstance(settings, dict) else {}
        general = rules.get("general", {}) if isinstance(rules, dict) else {}
        if isinstance(general, dict) and isinstance(general.get("rungs"), dict):
            rungs = general["rungs"]

    configured = rungs.get("light")
    entries = configured if isinstance(configured, list) else ([configured] if isinstance(configured, dict) else [])
    for entry in entries:
        target = entry.get("target") if isinstance(entry, dict) else None
        if not isinstance(target, dict) or not isinstance(target.get("agent"), str):
            continue
        name = target["agent"]
        found = [a for a in agents if isinstance(a, dict) and a.get("name") == name]
        if len(found) != 1:
            continue
        agent = found[0]
        provider_name, model = agent.get("provider"), agent.get("model")
        provider = provider_map.get(provider_name)
        if not isinstance(provider, dict) or provider.get("usable") is not True:
            continue
        if isinstance(settings.get("providers"), dict) and settings["providers"].get(provider_name) is False:
            continue
        allow = settings.get("allow") if isinstance(settings.get("allow"), list) else []
        known = settings.get("allowKnown") if isinstance(settings.get("allowKnown"), list) else []
        if allow and name not in allow and provider_name not in allow and not (known and name not in known):
            continue
        declared = [m for m in models if isinstance(m, dict) and m.get("provider") == provider_name and m.get("model") == model]
        if len(declared) != 1 or declared[0].get("judgeOnly") is True:
            continue
        if not isinstance(model, str) or not model:
            continue
        if "ollama" not in str(provider_name).lower():
            fail(f"active light rung selected non-Ollama provider {provider_name!r}; refusing to send")
        return str(provider_name), model
    fail("no usable Ollama agent found on the active light rung")
    raise AssertionError("unreachable")


def proxy_request(proxy: str, ca_file: Path, provider: str, model: str) -> dict[str, Any]:
    # Provider qualification forces ClaudeRipple to select this exact provider.
    qualified_model = f"{provider}:{model}"
    payload = {
        "model": qualified_model,
        "max_tokens": 64,
        "stream": False,
        "messages": [{"role": "user", "content": PROMPT}],
    }
    context = ssl.create_default_context(cafile=str(ca_file))
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"https": proxy}),
        urllib.request.HTTPSHandler(context=context),
    )
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1200]
        fail(f"ClaudeRipple proxy returned HTTP {exc.code}: {detail}")
    except Exception as exc:
        fail(f"request through ClaudeRipple HTTPS proxy failed: {exc}")
    if not isinstance(body, dict):
        fail("proxy response was not a JSON object")
    blocks = body.get("content")
    answer = " ".join(
        block.get("text", "") for block in blocks
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    ) if isinstance(blocks, list) else ""
    if "CLAUDERIPPLE_PROXY_E2E_OK" not in answer:
        fail(f"proxy returned a response but not the expected marker: {answer[:500]!r}")
    return body


def check_request_log(home: Path, provider: str, model: str, previous_mtime_ns: int) -> bool:
    path = home / "requests.jsonl"
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            if path.is_file() and path.stat().st_mtime_ns > previous_mtime_ns:
                rows = []
                for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[-300:]:
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict):
                        rows.append(item)
                for item in reversed(rows):
                    # Only inspect a log file that changed during this smoke test.
                    logged_provider = item.get("provider")
                    logged_model = item.get("model", item.get("requestedModel"))
                    if logged_provider == provider and logged_model in {model, f"{provider}:{model}"}:
                        return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


def main() -> None:
    home = Path(os.environ.get("CLAUDERIPPLE_HOME", str(Path.home() / ".clauderipple"))).expanduser()
    proxy, ca_file = load_proxy_settings()
    provider, model = active_light_target(home)
    print(f"Claude Code HTTPS_PROXY: {proxy}")
    print(f"ClaudeRipple CA: {ca_file}")
    print(f"Active light target: {provider} / {model}")
    print("Sending one harmless Anthropic Messages request through the HTTPS proxy…")
    log_path = home / "requests.jsonl"
    try:
        previous_log_mtime = log_path.stat().st_mtime_ns if log_path.is_file() else 0
    except OSError:
        previous_log_mtime = 0
    response = proxy_request(proxy, ca_file, provider, model)
    print(f"Proxy generation: OK (response model={response.get('model', 'not reported')})")
    print("Model response: CLAUDERIPPLE_PROXY_E2E_OK")
    if check_request_log(home, provider, model, previous_log_mtime):
        print(f"Router request log: confirmed provider={provider}, model={model}")
    else:
        print("Router request log: matching row not found (response still succeeded through the configured proxy)")
    print("PASS: the configured HTTPS proxy accepted an Anthropic Messages request and returned the Ollama marker.")
    print("Note: this exercises ClaudeRipple's proxy + Ollama adapter, but not the Claude Code plugin engine's $.model.complete hook.")


if __name__ == "__main__":
    main()
