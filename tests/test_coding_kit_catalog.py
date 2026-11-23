"""Checks the Coding Kit's catalog.json: what each item installs, checks, undoes and warns about.

The pane's behaviour is tested in plugins/coding-kit/hooks/kit.test.tsx (claude plugin test); those tests
can not read files, so the catalog's own entries are checked here.

    python3 -m unittest discover -s tests
"""
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1] / "plugins" / "coding-kit"
CATALOG = json.loads((ROOT / "catalog.json").read_text())
ITEMS = {i["id"]: i for i in CATALOG["items"]}
GROUPS = {g["id"]: g for g in CATALOG["groups"]}


def argvs(steps):
    return [" ".join(s if isinstance(s, list) else s["argv"]) for s in steps]


class Catalog(unittest.TestCase):
    def test_every_item_is_in_a_known_group(self):
        for i in CATALOG["items"]:
            self.assertIn(i["group"], GROUPS, i["id"])

    def test_every_install_says_what_changes(self):
        for i in CATALOG["items"]:
            if i["kind"] in ("mcp", "tool", "plugin"):
                self.assertTrue(i.get("changes"), f"{i['id']} has no changes list")

    def test_exclusive_groups_say_why(self):
        for i in CATALOG["items"]:
            if i.get("exclusive"):
                self.assertIn(i["exclusive"], CATALOG.get("exclusives", {}), i["id"])


class ModernWebGuidance(unittest.TestCase):
    def test_installs_from_the_googlechrome_marketplace(self):
        i = ITEMS["modern-web-guidance"]
        self.assertEqual(i["kind"], "plugin")
        self.assertEqual(i["group"], "build")
        self.assertEqual(i["plugin"], "modern-web-guidance@googlechrome")
        self.assertEqual(i["marketplace"], "GoogleChrome/modern-web-guidance")
        self.assertTrue(i["fill"].startswith("Use o modern-web-guidance"))
        self.assertEqual(i["repo"], "https://github.com/GoogleChrome/modern-web-guidance")


class Rtk(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["rtk"]

    def test_installs_the_apache_edition_checks_it_and_adds_only_the_hook(self):
        steps = argvs(self.i["install"])
        self.assertIn("RTK_EDITION=oss sh", steps[0])
        self.assertIn("https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh", steps[0])
        # `rtk gain` fails on the other rtk (Rust Type Kit): the install stops there.
        self.assertEqual(steps[1], "rtk gain")
        self.assertEqual(steps[2], "rtk init -g --auto-patch --hook-only")
        self.assertEqual(self.i["env"]["RTK_TELEMETRY_DISABLED"], "1")

    def test_removes_the_hook_the_binary_and_its_history(self):
        steps = " ; ".join(argvs(self.i["uninstall"]))
        self.assertIn("rtk init -g --uninstall", steps)
        self.assertIn(".local/bin/rtk", steps)
        self.assertIn(".local/share/rtk", steps)

    def test_is_detected_shrinks_with_the_others_and_shows_its_savings(self):
        self.assertEqual(self.i["check"], {"argv": ["rtk", "gain"]})
        self.assertEqual(self.i["exclusive"], "shrink-output")
        self.assertIn({"id": "gain", "label": "Economia", "run": ["rtk", "gain"]}, self.i["actions"])
        self.assertTrue(any("settings.json" in c for c in self.i["changes"]))


class LeanCtx(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["lean-ctx"]

    def test_installs_without_onboarding_every_tool_and_with_telemetry_off_before_init(self):
        steps = argvs(self.i["install"])
        self.assertIn("https://leanctx.com/install.sh", steps[0])
        self.assertEqual(self.i["env"]["LEAN_CTX_NO_ONBOARD"], "1")
        self.assertEqual(self.i["env"]["LEAN_CTX_NO_UPDATE_CHECK"], "1")
        self.assertLess(steps.index("lean-ctx telemetry disable"), steps.index("lean-ctx init --agent claude"))
        verify = self.i["install"][1]
        self.assertEqual(verify, {"argv": ["lean-ctx", "--version"], "match": "official"})

    def test_remove_also_takes_its_block_out_of_claude_md(self):
        steps = " ; ".join(argvs(self.i["uninstall"]))
        self.assertIn("lean-ctx uninstall", steps)
        self.assertIn("<!-- lean-ctx -->", steps)
        self.assertIn(".claude/CLAUDE.md", steps)

    def test_warns_about_auto_approved_tools_and_overlaps(self):
        changes = " ".join(self.i["changes"])
        self.assertIn("ctx_shell", changes)
        self.assertIn("sem pedir", changes)
        self.assertEqual(self.i["exclusive"], "shrink-output")
        self.assertEqual(self.i["overlapsMod"]["mod"], "input-router")
        self.assertIn({"id": "gain", "label": "Economia", "run": ["lean-ctx", "gain", "--terminal"]}, self.i["actions"])


class ContextMode(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["context-mode"]

    def test_is_a_plugin_that_checks_node_first_and_removes_its_data(self):
        self.assertEqual(self.i["kind"], "plugin")
        self.assertEqual(self.i["plugin"], "context-mode@context-mode")
        install = argvs(self.i["install"])
        self.assertIn("24", install[0])
        self.assertEqual(install[1:], ["claude plugin marketplace add mksglu/context-mode", "claude plugin install context-mode@context-mode"])
        remove = argvs(self.i["uninstall"])
        self.assertEqual(remove[:2], ["claude plugin uninstall context-mode@context-mode", "claude plugin marketplace remove context-mode"])
        self.assertIn(".context-mode", remove[2])

    def test_says_it_replaces_the_input_router(self):
        self.assertEqual(self.i["exclusive"], "shrink-output")
        self.assertEqual(self.i["overlapsMod"]["mod"], "input-router")
        self.assertIn("ELv2", self.i["source"])


class Context7(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["context7"]

    def test_sends_an_api_key_when_one_is_set(self):
        step = argvs(self.i["install"])[0]
        self.assertIn('CONTEXT7_API_KEY', step)
        self.assertIn('--header "Authorization: Bearer $CONTEXT7_API_KEY"', step)
        self.assertIn("https://mcp.context7.com/mcp", step)

    def test_has_a_use_always_rule(self):
        a = next(a for a in self.i["actions"] if a["id"] == "always")
        self.assertIn("Context7", a["rule"])
        self.assertEqual(a["label"], "Usar sempre")


class Serena(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["serena"]

    def test_installs_the_way_its_readme_says(self):
        steps = argvs(self.i["install"])
        self.assertEqual(steps[0], "uv tool install -p 3.13 serena-agent")
        self.assertIn('"$(uv tool dir --bin)/serena" start-mcp-server --context claude-code --open-web-dashboard false', steps[1])
        self.assertNotIn("--project-from-cwd", steps[1])
        self.assertEqual(self.i["needs"], ["uv"])

    def test_removes_both_and_prepares_a_project(self):
        steps = " ; ".join(argvs(self.i["uninstall"]))
        self.assertIn("claude mcp remove --scope user serena", steps)
        self.assertIn("uv tool uninstall serena-agent", steps)
        self.assertEqual(self.i["prepared"], ".serena/project.yml")
        a = next(a for a in self.i["actions"] if a["id"] == "index")
        self.assertEqual(a["run"], ["serena", "project", "index"])


class CodebaseMemory(unittest.TestCase):
    def test_can_index_the_project_and_remove_deletes_its_indexes(self):
        i = ITEMS["codebase-memory"]
        a = next(a for a in i["actions"] if a["id"] == "index")
        self.assertIn("codebase-memory", a["fill"])
        self.assertIn(".cache/codebase-memory-mcp", " ; ".join(argvs(i["uninstall"])))


class Graphify(unittest.TestCase):
    def setUp(self):
        self.i = ITEMS["graphify"]

    def test_says_it_writes_a_skill_and_claude_md_not_a_hook(self):
        changes = " ".join(self.i["changes"])
        self.assertIn("skills/graphify", changes)
        self.assertIn("CLAUDE.md", changes)
        self.assertNotIn("hook", changes)

    def test_maps_the_project_and_keeps_its_output_out_of_git(self):
        self.assertEqual(self.i["prepared"], "graphify-out/graph.json")
        a = next(a for a in self.i["actions"] if a["id"] == "gitignore")
        self.assertIn("graphify-out/", " ".join(a["run"]))


MATT = {
    "Engenharia": ["ask-matt", "codebase-design", "code-review", "diagnosing-bugs", "domain-modeling", "grill-with-docs", "implement", "implement-spec",
                   "improve-codebase-architecture", "pr", "prototype", "research", "retro", "setup-matt-pocock-skills", "tdd", "to-spec", "to-tickets",
                   "triage", "wayfinder", "wizard"],
    "Produtividade": ["grilling", "grill-me", "handoff", "teach", "to-questionnaire", "wait-what", "writing-for-agents"],
    "Outras": ["git-guardrails-claude-code", "migrate-to-shoehorn", "scaffold-exercises", "setup-pre-commit"],
}
BUCKET = {"Engenharia": "engineering", "Produtividade": "productivity", "Outras": "misc"}
# Called by other skills through the Skill tool: the model must be able to load them.
CHAIN = {"codebase-design", "research", "grilling", "tdd", "prototype", "domain-modeling", "code-review"}
NEEDS_SETUP = {"to-spec", "to-tickets", "triage", "wayfinder", "implement-spec"}
SOURCES = {x["dir"]: x for x in CATALOG["skills"]}
LOCK = json.loads((ROOT / "skills" / "upstream.lock.json").read_text())


class MattPocock(unittest.TestCase):
    def test_has_its_own_section_with_a_repo_setup(self):
        g = GROUPS["matt"]
        self.assertEqual(g["setup"]["command"], "/coding-kit:setup-matt-pocock-skills")
        self.assertEqual(g["setup"]["done"], "docs/agents/issue-tracker.md")
        first = next(i for i in CATALOG["items"] if i["group"] == "matt")
        self.assertEqual(first["id"], "ask-matt")

    def test_every_skill_is_a_card_in_its_sub_section(self):
        for sub, names in MATT.items():
            for n in names:
                i = ITEMS[n]
                self.assertEqual((i["kind"], i["group"], i["sub"], i["command"]), ("skill", "matt", sub, f"/coding-kit:{n}"), n)
                self.assertTrue(i["label"] and i["description"], n)
                self.assertEqual(bool(i.get("needsSetup")), n in NEEDS_SETUP, n)

    def test_every_skill_is_bundled_from_its_upstream_folder(self):
        for sub, names in MATT.items():
            for n in names:
                src = SOURCES[n]
                self.assertEqual((src["repo"], src["path"]), ("mattpocock/skills", f"skills/{BUCKET[sub]}/{n}"), n)
                self.assertEqual(src["exclude"], ["agents"], n)
                self.assertEqual(src["frontmatter"]["disable-model-invocation"], "false" if n in CHAIN else "true", n)
                self.assertEqual(len(LOCK[n]["sha"]), 40, n)
                d = ROOT / "skills" / n
                text = (d / "SKILL.md").read_text()
                self.assertIn(f"disable-model-invocation: {'false' if n in CHAIN else 'true'}", text.split("---")[1], n)
                self.assertIn("<!-- From mattpocock/skills", text, n)
                for f in d.rglob("*.md"):
                    self.assertIsNone(re.search(r'Skill tool with "(?!coding-kit:)', f.read_text()), str(f))
                self.assertFalse((d / "agents").exists(), n)

    def test_cross_references_point_at_this_plugin(self):
        text = (ROOT / "skills" / "grill-me" / "SKILL.md").read_text()
        self.assertIn('Call the Skill tool with "coding-kit:grilling"', text)
        ask = (ROOT / "skills" / "ask-matt" / "SKILL.md").read_text()
        self.assertIn("/coding-kit:grill-me", ask)
        self.assertNotIn(" /grill-me", ask)
        self.assertTrue((ROOT / "skills" / "diagnosing-bugs" / "scripts" / "hitl-loop.template.sh").exists())

    def test_the_old_places_are_gone(self):
        self.assertEqual(ITEMS["grill-me"]["group"], "matt")
        self.assertEqual(ITEMS["improve-codebase-architecture"]["group"], "matt")


class Defaults(unittest.TestCase):
    def test_only_the_cheap_and_saving_tools_are_recommended(self):
        rec = {i["id"] for i in CATALOG["items"] if i.get("recommended")}
        self.assertEqual(rec, {"context7", "rtk"})

    def test_verification_is_the_one_bundled_skill_claude_may_load_by_itself(self):
        src = SOURCES["verification-before-completion"]
        self.assertEqual(src["frontmatter"]["disable-model-invocation"], "false")
        text = (ROOT / "skills" / "verification-before-completion" / "SKILL.md").read_text()
        self.assertIn("disable-model-invocation: false", text.split("---")[1])
        for d in ["systematic-debugging", "test-driven-development", "writing-plans", "frontend-design", "ponytail"]:
            self.assertEqual(SOURCES[d]["frontmatter"]["disable-model-invocation"], "true", d)


if __name__ == "__main__":
    unittest.main()
