# Paste this into Claude Code to start

> I'm building v2 of a Blue Ridge Parkway motorcycle trip planner. Everything you
> need is in this folder.
>
> Read `SPEC.md` first — it's the full build spec, including a section on GPX
> export that documents a non-obvious failure mode you should not rediscover the
> hard way. Then read `GPX-REFERENCE.md` for the exact target output format.
>
> `data/` has researched, fact-checked datasets: 32 campgrounds, 29 fuel exits,
> the Parkway centerline geometry, and current road closures. Treat the
> `confidence` fields in `fuel.json` as load-bearing.
>
> `v1/` is the currently deployed static map. It's a reference and a data source,
> not something to preserve — feel free to rebuild the UI.
>
> Start by reading the spec and telling me what you'd build first, what you'd
> push back on, and anything in the spec you think is wrong. Don't write code yet.

## Repo notes

- The GitHub repo already exists and is connected to a Vercel project that
  auto-deploys on push to the default branch.
- v1 deploys as a single `index.html` at the repo root with no build step. If v2
  adds a build step, Vercel handles it, but weigh that against losing the
  "works offline from a parking lot" property.
- Ask before changing the deploy configuration.
