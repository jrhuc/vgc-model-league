# Deployment

The public site is a static GitHub Pages deployment. There is no hosted
service: no server, database, authentication, or import API. The browser app
is built once, and every read-only API response it needs is a committed JSON
file exported from local records.

## Pipeline

1. `vgcleague export-site` projects the local archive (terminal, non-test runs
   by default) into `artifacts/public/site/`. Curate with `--run`, `--pool`,
   or `--include-test`; the export replaces the directory wholesale, so the
   committed tree always mirrors exactly one export.
2. Commit and push `artifacts/public/site` to `main`.
3. `.github/workflows/pages.yml` builds the client with
   `vite build --mode static`, copies the committed data to `data/`, and
   deploys the result to GitHub Pages.

`pnpm run publish:site` performs all three steps in one command.

## One-time repository setup

Under Settings → Pages, set the source to **GitHub Actions**. The workflow
deploys on pushes that touch the site data or client, and can be run manually
from the Actions tab.

## What the static build changes

`--mode static` defines `__STATIC_SITE__`, which maps API routes onto exported
files (`/api/league?run=X` → `data/league/X.json`), disables the live event
stream, and marks the app read-only. Everything else is the same client the
local console serves.

Live runs never appear on the public site. They are visible only on the local
operator console (`vgcleague gui`, loopback only) and reach the site by
finishing and being re-exported.

## Size expectations

The exported archive is currently ~15 MB of JSON plus ~2 MB of sprites and
assets. GitHub Pages allows 1 GB per site, so growth headroom is large; if the
archive ever outgrows Pages, move `data/` to object storage behind the same
relative paths.
