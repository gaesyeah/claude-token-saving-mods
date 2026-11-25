#!/usr/bin/env python3
"""Safely inspect ClaudeRipple log filenames and JSON field names without printing prompts."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

HOME = Path(os.environ.get("CLAUDERIPPLE_HOME", str(Path.home() / ".clauderipple"))).expanduser()
MAX_FILES = 30
MAX_BYTES = 2_000_000


def main() -> None:
    if not HOME.is_dir():
        raise SystemExit(f"ClaudeRipple home not found: {HOME}")
    candidates = [
        p for p in HOME.rglob("*")
        if p.is_file() and (p.suffix.lower() in {".jsonl", ".log"} or "request" in p.name.lower())
    ]
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        print(f"No log-like files found under {HOME}")
        return

    print(f"ClaudeRipple log candidates under {HOME} (newest first):")
    for path in candidates[:MAX_FILES]:
        try:
            stat = path.stat()
            rel = path.relative_to(HOME)
            print(f"\n{rel} | {stat.st_size} bytes")
            if stat.st_size > MAX_BYTES:
                print("  skipped content inspection (file exceeds 2 MB)")
                continue
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            parsed: list[dict[str, Any]] = []
            for line in lines[-80:]:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    parsed.append(value)
            if not parsed:
                print("  no JSON objects in last 80 lines; raw content intentionally not displayed")
                continue
            latest = parsed[-1]
            print("  top-level JSON keys:", ", ".join(sorted(latest.keys())) or "(none)")
            # Print only routing metadata, never prompt/message/body/headers/token fields.
            for key in ("provider", "providerName", "provider_name", "model", "requestedModel", "requested_model", "agent", "route", "status", "kind", "type"):
                value = latest.get(key)
                if isinstance(value, (str, int, float, bool)):
                    print(f"  {key}: {value}")
        except OSError as exc:
            print(f"  unable to inspect: {exc}")

    print("\nNo prompt, message body, API key, header, or credential values were printed.")


if __name__ == "__main__":
    main()
