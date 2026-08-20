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
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "app", "src")
OUT = os.path.join(ROOT, "index.html")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def read_script(path):
    """Read a source file as it will actually be inlined.

    map-pins.js is authored as an ES module so it stays a drop-in for anyone loading it
    with <script type="module">. This page is a single self-contained file with plain
    <script> blocks, where a top-level `export` is a syntax error, so the keyword is
    stripped on the way in. Everything the module declares is a top-level const or
    function, which a classic script hands to the scripts that follow it -- which is how
    app.js sees pinIcon() and LINE.
    """
    text = read(path)
    return re.sub(r"^export\s+(?=(const|function|let)\b)", "", text, flags=re.M)


def check_js(sources):
    """Refuse to build a page whose JavaScript does not parse.

    Inlining is a string replace, so a syntax error in a source file used to ship in
    silence -- the build printed success, every Python test still passed, and the page
    was dead in the browser. Node parses it here instead, before anything is written.
    Skipped, loudly, if node is absent.

    The text checked is the text that gets inlined, not the file on disk: map-pins.js
    only parses as a classic script once its exports are stripped, and checking the
    original would prove the wrong thing.
    """
    import shutil
    import tempfile
    if not shutil.which("node"):
        print("  WARNING: node not found -- JavaScript not syntax-checked")
        return
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in sources:
            path = os.path.join(tmp, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode != 0:
                raise SystemExit(f"{name} does not parse:\n{r.stderr.strip()}")
    print(f"  {len(sources)} JavaScript files parse")


def check_vercel_json():
    """Refuse to build if the deploy config would be rejected by Vercel.

    Vercel validates vercel.json against a strict schema and an unknown property fails the
    BUILD, not the request -- so the site keeps serving the previous deploy and nothing on
    it looks wrong. That is the worst failure shape there is: I added explanatory "comment"
    keys to the header rules, every deploy errored for half an hour, and the whole time I
    was telling the rider his phone was caching too aggressively and to reload harder.

    Only the keys Vercel accepts on a headers rule are allowed here. It is a small check
    because the file is small; the point is that it fails in this terminal instead of
    silently in a dashboard nobody is watching.
    """
    path = os.path.join(ROOT, "vercel.json")
    if not os.path.exists(path):
        return
    with open(path) as f:
        cfg = json.load(f)          # a syntax error raises here, which is the point
    allowed_rule = {"source", "headers", "has", "missing"}
    for i, rule in enumerate(cfg.get("headers", [])):
        extra = set(rule) - allowed_rule
        if extra:
            raise SystemExit(
                f"vercel.json headers[{i}] has {sorted(extra)}, which Vercel rejects. "
                f"Allowed: {sorted(allowed_rule)}. JSON has no comments -- explain it in "
                f"sw.js instead.")
        for j, h in enumerate(rule.get("headers", [])):
            if set(h) != {"key", "value"}:
                raise SystemExit(
                    f"vercel.json headers[{i}].headers[{j}] must have exactly key and "
                    f"value, got {sorted(h)}.")
    print(f"  vercel.json: {len(cfg.get('headers', []))} header rules, all valid")


def main():
    check_vercel_json()
    data = read(os.path.join(ROOT, "data", "derived", "browser-data.json"))
    # </script> inside a JSON string literal would close the tag early.
    data = data.replace("</", "<\\/")

    html = read(os.path.join(SRC, "shell.html"))
    scripts = [("core.js", "__CORE_JS__"), ("route.js", "__ROUTE_JS__"),
               ("gpx.js", "__GPX_JS__"), ("map-pins.js", "__MAPPINS_JS__"),
               ("app.js", "__APP_JS__")]
    js = {name: read_script(os.path.join(SRC, name)) for name, _ in scripts}
    check_js([(name, js[name]) for name, _ in scripts])
    for token, path in [
        ("__LEAFLET_CSS__", os.path.join(SRC, "..", "vendor", "leaflet.css")),
        ("__APP_CSS__", os.path.join(SRC, "styles.css")),
        ("__LEAFLET_JS__", os.path.join(SRC, "..", "vendor", "leaflet.js")),
    ]:
        html = html.replace(token, read(path))
    for name, token in scripts:
        html = html.replace(token, js[name])
    html = html.replace("__DATA__", data)

    # The app's version is the service worker's version, read from sw.js rather than typed
    # here. Two places to bump is one place to forget, and the number a rider reads off the
    # Notes tab has to be the number that decides which code their phone is running.
    sw = read(os.path.join(ROOT, "sw.js"))
    m = re.search(r"const VERSION = '([^']+)'", sw)
    assert m, "sw.js has no VERSION to stamp into the page"
    html = html.replace("__APP_VERSION__", m.group(1))


    # The header lockup is the same artwork the icons are cut from. Inlined rather than
    # linked so the page stays one self-contained file that works from a filesystem.
    # The header mark follows the theme.
    #
    # BRAND.md ships two versions -- cream for dark grounds, blue for light -- because a
    # cream mark on a cream background is invisible, which is exactly what happened the
    # first time this was wired up. Rather than inline both and hide one, the BARS are
    # switched to currentColor so they inherit --fg, which is Cream in dark and Deep Blue
    # in light: the same two files, expressed once.
    #
    # The headlight stays amber deliberately. BRAND.md rule 3 forbids the circle and the
    # bars sharing a colour -- the two-tone contrast is what makes it read as a headlight.
    mark = read(os.path.join(ROOT, "app", "brand", "logo-mark.svg"))
    assert '#f2efe6' in mark, "logo-mark.svg is expected to be the cream version"
    mark = mark.replace('fill="#f2efe6"', 'fill="currentColor"')
    mark = mark.replace('<svg ', '<svg class="mark-svg" ', 1)
    html = html.replace("__MARK_SVG__", mark)

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    size = os.path.getsize(OUT)
    print(f"index.html (deployed)  {size/1024:.0f} KB")
    for token in ("__LEAFLET_CSS__", "__APP_CSS__", "__LEAFLET_JS__", "__DATA__",
                  "__CORE_JS__", "__ROUTE_JS__", "__GPX_JS__", "__MAPPINS_JS__",
                  "__APP_JS__", "__MARK_SVG__", "__APP_VERSION__"):
        assert token not in html, f"unsubstituted token {token}"
    assert html.count("<html") == 1
    print("  all tokens substituted")


if __name__ == "__main__":
    main()
