#!/usr/bin/env python3
"""Inline app/src/* into the deployed index.html at the repo root.

The deploy is one static file with no build step, which is what keeps the planner working
from a phone in a parking lot with no signal. This generator runs offline, in the repo --
source stays editable under app/src/, the artifact stays deployable.

The output is the repo-root index.html, which is what Vercel serves at /. There is
deliberately no second copy under v2/: two generated artifacts drift, and only one of
them is ever the thing that deployed.

There is one app and one deployed file. The old v1 map is gone from the tree -- it lives
in git history if it is ever wanted, and keeping a second version around invited exactly
the "which one is live?" confusion this layout exists to prevent.

Run: python3 build/build_app.py
"""
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "app", "src")
OUT = os.path.join(ROOT, "index.html")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def check_js(paths):
    """Refuse to build a page whose JavaScript does not parse.

    Inlining is a string replace, so a syntax error in a source file used to ship in
    silence -- the build printed success, every Python test still passed, and the page
    was dead in the browser. Node parses it here instead, before anything is written.
    Skipped, loudly, if node is absent.
    """
    import shutil
    if not shutil.which("node"):
        print("  WARNING: node not found -- JavaScript not syntax-checked")
        return
    for path in paths:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"{os.path.basename(path)} does not parse:\n{r.stderr.strip()}")
    print(f"  {len(paths)} JavaScript files parse")


def main():
    data = read(os.path.join(ROOT, "data", "derived", "browser-data.json"))
    # </script> inside a JSON string literal would close the tag early.
    data = data.replace("</", "<\\/")

    html = read(os.path.join(SRC, "shell.html"))
    check_js([os.path.join(SRC, n) for n in ("core.js", "route.js", "gpx.js", "app.js")])
    for token, path in [
        ("__LEAFLET_CSS__", os.path.join(SRC, "..", "vendor", "leaflet.css")),
        ("__APP_CSS__", os.path.join(SRC, "styles.css")),
        ("__LEAFLET_JS__", os.path.join(SRC, "..", "vendor", "leaflet.js")),
        ("__CORE_JS__", os.path.join(SRC, "core.js")),
        ("__ROUTE_JS__", os.path.join(SRC, "route.js")),
        ("__GPX_JS__", os.path.join(SRC, "gpx.js")),
        ("__APP_JS__", os.path.join(SRC, "app.js")),
    ]:
        html = html.replace(token, read(path))
    html = html.replace("__DATA__", data)

    # The header lockup is the same artwork the icons are cut from. Inlined rather than
    # linked so the page stays one self-contained file that works from a filesystem.
    mark = read(os.path.join(ROOT, "app", "brand", "mark.svg"))
    mark = mark.replace('<svg ', '<svg class="mark-svg" ', 1)
    html = html.replace("__MARK_SVG__", mark)

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print(f"index.html (deployed)  {size/1024:.0f} KB")
    for token in ("__LEAFLET_CSS__", "__APP_CSS__", "__LEAFLET_JS__", "__DATA__",
                  "__CORE_JS__", "__ROUTE_JS__", "__GPX_JS__", "__APP_JS__", "__MARK_SVG__"):
        assert token not in html, f"unsubstituted token {token}"
    assert html.count("<html") == 1
    print("  all tokens substituted")


if __name__ == "__main__":
    main()
