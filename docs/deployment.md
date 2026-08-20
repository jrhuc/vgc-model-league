# Deploy documentation and season bundles

The repository publishes two different outputs with separate responsibilities.

- GitHub Pages serves this technical documentation.
- `export-season` writes a validated, public-only bundle for the spectator
  product.

The local operator GUI is not deployed.

## GitHub Pages

In **Settings → Pages**, set **Source** to **GitHub Actions**.
`.github/workflows/pages.yml` runs when `docs/`, the package lock, or the
workflow changes. It renders the canonical Markdown files as zero-runtime HTML
and deploys `dist/docs`.

Build the same output locally with:

```sh
pnpm run build:docs
```

The output contains the documentation theme and text only. League archives,
replays, sprites, model logos, provider controls, and local operator routes do
not enter the Pages artifact.

## Spectator bundle

Build the harness, then export one explicit release boundary:

```sh
pnpm run build
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League"
```

The default output is
`artifacts/public/seasons/<run-id>/season-bundle.json`, with
`season-bundle-v2.schema.json` written beside it. Pass `--out <file>` to write
directly into a checked-out spectator repository's `public/` directory.

`--through-week` is required. Publication never advances merely because more
private results exist locally. A released week must contain every completed
series and verified replay for that week or export fails. Values past the last
regular-season week release playoff rounds one at a time; releasing the final
round also releases season reviews and opens closed team sheets.

The bundle carries the public evidence layer defined in
[Architecture](architecture.md#public-publication): stated rationales for
picks, builds, decisions, offers and responses; structured battle events;
reflections; transactions; the bracket; and provenance. It never carries
notebooks, traces, prompts, provider responses, or future results.

The spectator deployment owns release timing and presentation. It validates the
bundle against the emitted schema, and must not clone the harness, run
Showdown, or recompute standings and outcomes.
