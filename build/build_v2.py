#!/usr/bin/env python3
"""Inline v2/src/* into the deployed index.html at the repo root.

The deploy is one static file with no build step, which is what keeps the planner working
from a phone in a parking lot with no signal. This generator runs offline, in the repo --
source stays editable under v2/src/, the artifact stays deployable.

The output is the repo-root index.html, which is what Vercel serves at /. There is
deliberately no second copy under v2/: two generated artifacts drift, and only one of
them is ever the thing that deployed.

v1 is no longer part of the build. Its self-contained page remains at v1/index.html and
stays reachable at /v1/, but nothing here depends on it.

Run: python3 build/build_v2.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "v2", "src")
OUT = os.path.join(ROOT, "index.html")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def main():
    data = read(os.path.join(ROOT, "data", "derived", "browser-data.json"))
    # </script> inside a JSON string literal would close the tag early.
    data = data.replace("</", "<\\/")

    html = read(os.path.join(SRC, "shell.html"))
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

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print(f"index.html (deployed)  {size/1024:.0f} KB")
    for token in ("__LEAFLET_CSS__", "__APP_CSS__", "__LEAFLET_JS__", "__DATA__",
                  "__CORE_JS__", "__ROUTE_JS__", "__GPX_JS__", "__APP_JS__"):
        assert token not in html, f"unsubstituted token {token}"
    assert html.count("<html") == 1
    print("  all tokens substituted")


if __name__ == "__main__":
    main()
