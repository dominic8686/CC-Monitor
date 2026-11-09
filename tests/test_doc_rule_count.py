"""The rule count stated in the docs must match the actual number of rules in default_rules.json.

This number is easy to forget: it went stale twice in one session (74 -> 78 -> 86). Every new rule
means updating 6 places: the Chinese and English READMEs plus the Chinese and English website
pages. Forgetting does not raise an error; the docs just quietly lie. This test turns that into a
failing assertion.

Past CHANGELOG entries are not checked: they are release records, and "rule count raised from 70
to 74" describes what was true at the time; it should not follow the current count.

Run directly: python3 -m unittest tests/test_doc_rule_count.py
"""
import io
import json
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rule_count():
    with io.open(os.path.join(REPO, "cc_monitor", "default_rules.json"), encoding="utf-8") as f:
        return len(json.load(f))


# File -> how that file states the total rule count. The two website pages are not in git (HTML/
# is excluded by .gitignore); they are checked only if present and skipped otherwise, so people who
# only cloned the repository can still pass the test.
DOC_PATTERNS = {
    "README.zh-CN.md": [r"\*\*(\d+) 条内置检测规则"],
    "README.md": [r"\*\*(\d+) built-in detection rules"],
    # The big number in the hero section counts too, and it is the easiest to miss: the count in
    # this section changed twice, both times only the "N default rules" in the body text was
    # updated, and the hero kept the old value.
    "HTML/index.html": [
        r"<h2>(\d+) 条默认规则",
        r"(\d+) 条规则每条自带",
        r"<div><b>(\d+)</b><span>条内置规则",
    ],
    "HTML/index.en.html": [
        r"<h2>(\d+) default rules",
        r"All (\d+) rules carry",
        r"<div><b>(\d+)</b><span>built-in rules",
    ],
}


class TestDocumentedRuleCount(unittest.TestCase):
    def test_docs_match_actual_rule_count(self):
        actual = rule_count()
        checked = 0
        for rel, patterns in DOC_PATTERNS.items():
            path = os.path.join(REPO, rel)
            if not os.path.exists(path):
                continue  # the website directory is not committed, so it may be missing
            text = io.open(path, encoding="utf-8").read()
            for pat in patterns:
                m = re.search(pat, text)
                self.assertIsNotNone(m, f"No rule count statement found in {rel}: {pat}")
                self.assertEqual(
                    int(m.group(1)), actual,
                    f"{rel} says {m.group(1)} rules; default_rules.json actually has {actual}",
                )
                checked += 1
        self.assertGreater(checked, 0, "Nothing was checked, so the match patterns no longer work")

    def test_rule_ids_are_unique(self):
        with io.open(os.path.join(REPO, "cc_monitor", "default_rules.json"), encoding="utf-8") as f:
            rules = json.load(f)
        ids = [r["id"] for r in rules]
        dupes = {i for i in ids if ids.count(i) > 1}
        self.assertEqual(dupes, set(), f"Duplicate rule ids: {dupes}")


if __name__ == "__main__":
    unittest.main()
