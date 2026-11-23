"""Checks the Coding Kit's catalog.json: what each item installs, checks, undoes and warns about.

The pane's behaviour is tested in plugins/coding-kit/hooks/kit.test.tsx (claude plugin test); those tests
can not read files, so the catalog's own entries are checked here.

    python3 -m unittest discover -s tests
"""
import json
import pathlib
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


if __name__ == "__main__":
    unittest.main()
