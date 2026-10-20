"""Every template renders for every kind of palette, and the output for a fixed
palette matches the golden files (RICE_UPDATE_GOLDEN=1 rewrites them)."""
import json
import os
import re
import tomllib
import unittest

import helpers
from rice import palette, render

TEMPLATES = helpers.ROOT / "templates"
GOLDEN = helpers.FIXTURES / "golden"
LEFTOVER = re.compile(r"\{\{\s*[a-z][a-z0-9_]*(\s+[^}]*)?\s*\}\}")
EXTRA = {"rice_theme": "sample", "rice_theme_name": "Sample"}
T3CODE_ROLES = """
canvas chrome toolbar toolbarForeground toolbarBorder toolbarControl toolbarControlForeground
toolbarControlHover surface surfaceRaised surfaceOverlay text textMuted border input focus
accent accentForeground secondary secondaryForeground muted mutedForeground placeholder
secondaryLabel iconMuted error errorForeground errorSurface warning warningForeground
warningSurface update updateForeground updateSurface accentSurface accentSurfaceForeground
messageSurface messageForeground messageAction messageActionForeground messageActionHover
codeBackground codeForeground searchMatchBackground searchMatchForeground
searchMatchActiveBackground searchMatchActiveForeground sidebar sidebarForeground
sidebarMutedForeground sidebarControlSurface sidebarRowHover sidebarRowActive
sidebarRowSelected sidebarBorder terminalBackground terminalForeground terminalCursor
terminalSelection terminalScrollbar terminalScrollbarHover
"""

PALETTES = {
    "sample": (helpers.FIXTURES / "sample-colors.toml").read_text(),
    "minimal-dark": 'background = "#101010"\nforeground = "#ffffff"\n',
    "minimal-light": 'background = "#fffcf0"\nforeground = "#100f0f"\naccent = "#bc5215"\n',
    "stock-vesper": (helpers.ROOT / "themes/vesper/colors.toml").read_text(),
    "stock-flexoki-light": (helpers.ROOT / "themes/flexoki-light/colors.toml").read_text(),
}


def rendered(text):
    colors = palette.resolve(palette.parse(text))
    r = render.Renderer(colors, EXTRA)
    return {tpl.name[:-4]: r.text(tpl.read_text()) for tpl in render.template_files(TEMPLATES)}


class Templates(unittest.TestCase):
    def test_no_placeholder_left(self):
        for name, text in PALETTES.items():
            for out, data in rendered(text).items():
                m = LEFTOVER.search(data)
                self.assertIsNone(m, f"{name}: {out} still has {m and m.group(0)}")

    def test_structured_outputs_parse(self):
        for name, text in PALETTES.items():
            for out, data in rendered(text).items():
                with self.subTest(palette=name, file=out):
                    if out.endswith(".json"):
                        json.loads(data)
                    elif out.endswith(".toml"):
                        tomllib.loads(data)

    def test_t3code_sets_every_role(self):
        # T3 Code fills any role a seeded theme leaves out from its own generator, which
        # tints every surface with the accent's hue (and the send button 50 degrees off it).
        # So the template sets them all. The list is T3 Code's own, as of October 2026.
        roles = set(T3CODE_ROLES.split())
        for name, text in PALETTES.items():
            with self.subTest(palette=name):
                colors = json.loads(rendered(text)["t3code.json"])["colors"]
                self.assertEqual(set(colors), roles)
                for role, value in colors.items():
                    self.assertRegex(value, r"^#[0-9A-Fa-f]{6}$", role)

    def test_golden(self):
        outputs = rendered(PALETTES["sample"])
        if os.environ.get("RICE_UPDATE_GOLDEN") == "1":
            GOLDEN.mkdir(parents=True, exist_ok=True)
            for old in GOLDEN.iterdir():
                old.unlink()
            for out, data in outputs.items():
                (GOLDEN / out).write_text(data)
        self.assertEqual(sorted(p.name for p in GOLDEN.iterdir()), sorted(outputs),
                         "templates added or removed: RICE_UPDATE_GOLDEN=1 to refresh")
        for out, data in outputs.items():
            with self.subTest(file=out):
                self.assertEqual(data, (GOLDEN / out).read_text(), f"{out} changed: RICE_UPDATE_GOLDEN=1 to accept")


if __name__ == "__main__":
    unittest.main()
