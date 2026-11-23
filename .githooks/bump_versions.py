#!/usr/bin/env python3
"""Pre-commit: a mod whose files change in this commit gets a new version.

`claude plugin update` compares only the version number, so a change under the
same number never reaches the installed copy. For each mod with staged changes
(tests aside) whose version did not change, bump the patch number in its
plugin.json and copy it into .claude-plugin/marketplace.json. A version you set
yourself is kept. Then refuse the commit if any marketplace version differs from
its plugin.json.
"""
import json
import re
import subprocess
import sys

MARKET = ".claude-plugin/marketplace.json"


def git(*args, check=True):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=check).stdout


def blob(rev_path):
    r = subprocess.run(["git", "show", rev_path], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def version_of(text):
    try:
        return json.loads(text).get("version") if text else None
    except ValueError:
        return None


def set_version(text, new):
    # Only the first "version" key: plugin.json keeps its own formatting.
    return re.sub(r'("version"\s*:\s*")[^"]*(")', rf"\g<1>{new}\g<2>", text, count=1)


def bump(v):
    parts = v.split(".")
    if not all(p.isdigit() for p in parts):
        return None
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def market_set(text, name, new):
    # The "version" inside the entry whose "name" is this mod.
    pat = re.compile(r'("name"\s*:\s*"' + re.escape(name) + r'"[^{}]*?"version"\s*:\s*")[^"]*(")', re.S)
    out, n = pat.subn(rf"\g<1>{new}\g<2>", text, count=1)
    return out if n else None


def main():
    staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMRD").split()
    mods = sorted({p.split("/")[1] for p in staged if p.startswith("plugins/") and p.count("/") >= 2
                   and not re.search(r"\.test\.tsx?$", p)})
    market = blob(f":{MARKET}") or ""
    changed_market = False
    for mod in mods:
        pj = f"plugins/{mod}/.claude-plugin/plugin.json"
        staged_text = blob(f":{pj}")
        if staged_text is None:
            continue  # mod deleted or has no manifest
        old = version_of(blob(f"HEAD:{pj}"))
        cur = version_of(staged_text)
        if old is None or cur is None:
            continue  # a new mod keeps the version it was written with
        new = cur
        if cur == old:
            new = bump(cur)
            if new is None:
                print(f"bump-versions: {mod} has version {cur!r}, which I can not bump; set it by hand.", file=sys.stderr)
                return 1
            if git("diff", "--name-only", "--", pj).strip():
                print(f"bump-versions: {pj} has unstaged changes; stage or stash them, then commit again.", file=sys.stderr)
                return 1
            with open(pj, "w") as f:
                f.write(set_version(staged_text, new))
            git("add", "--", pj)
            print(f"bump-versions: {mod} {cur} -> {new}")
        if market:
            m = market_set(market, mod, new)
            if m is not None and m != market:
                market, changed_market = m, True

    if changed_market:
        if git("diff", "--name-only", "--", MARKET).strip():
            print(f"bump-versions: {MARKET} has unstaged changes; stage or stash them, then commit again.", file=sys.stderr)
            return 1
        with open(MARKET, "w") as f:
            f.write(market)
        git("add", "--", MARKET)

    # Every marketplace entry must match its plugin.json.
    bad = []
    for p in (json.loads(market).get("plugins", []) if market else []):
        name, mv = p.get("name"), p.get("version")
        pv = version_of(blob(f":plugins/{name}/.claude-plugin/plugin.json"))
        if mv and pv and mv != pv:
            bad.append(f"  {name}: marketplace.json {mv}, plugin.json {pv}")
    if bad:
        print("bump-versions: versions differ; make them match:\n" + "\n".join(bad), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
