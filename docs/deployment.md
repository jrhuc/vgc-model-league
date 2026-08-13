# Deploy the public site

The public site uses a static GitHub Pages deployment. It has no hosted server,
database, authentication, or import API. The build reads every required
read-only API response from committed JSON files exported from local records.

## Publish the site

1. Run `vgcleague export-site`. By default, this command exports terminal,
   non-test runs from the local archive to `artifacts/public/site/`. Use
   `--run`, `--pool`, or `--include-test` to curate the export. The command
   replaces the output directory, so the committed tree represents exactly one
   export.
2. Merge `artifacts/public/site` into `main` through a pull request. The `main`
   ruleset rejects direct pushes.
3. Let `.github/workflows/pages.yml` build the client with
   `vite build --mode static`, copy the committed data to `data/`, and deploy
   the result to GitHub Pages.

Run all three steps with:

```sh
pnpm run publish:site
```

## Configure the repository

In **Settings > Pages**, set **Source** to **GitHub Actions**. The workflow runs
on pushes that change the site data or client. You can also run it manually from
the **Actions** tab.

## Static build behavior

The `--mode static` build selects static capability and loader modules. This
mode:

- maps API routes to exported files, such as `/api/league?run=X` to
  `data/league/X.json`;
- disables the live event stream;
- omits **Live** and **New run** from navigation and route resolution; and
- marks the remaining research and archive views as read-only.

The static build is an archive-only client. Its build-time capability and loader
selection excludes the operational Live and New run module graph instead of
shipping inactive controls. The remaining research and archive views share
their implementation with the local console.

Live runs appear only in the loopback-only local operator console started by
`vgcleague gui`. To publish a live run, finish it and export the site again.

## Storage limits

The current export contains about 15 MB of JSON and 2 MB of sprites and other
assets. GitHub Pages allows 1 GB per site. If the archive exceeds this limit,
move `data/` to object storage and preserve the same relative paths.
