# MiCAR Tracker — working notes

## Branch workflow (dev hygiene)

- All development happens on `dev`; never commit directly to `main`.
- `main` is merged from `dev` via a pull request (creates a merge commit).
- **Keep `dev` — do not delete it after a merge.**
- **Do not stack new work on already-merged history.** After each `dev → main`
  PR merges, bring `dev` back in line with `main` *before* starting new work:
  - Preferred (no history rewrite): because the PR merge commit has the `dev`
    tip as a parent, `dev` can fast-forward to `main`:
    `git checkout dev && git fetch origin main && git merge --ff-only origin/main && git push origin dev`
  - If `dev` and `main` have genuinely diverged and no fast-forward is
    possible, reset `dev` onto `main`
    (`git checkout dev && git reset --hard origin/main && git push --force-with-lease origin dev`)
    — but only when `dev` carries no unmerged commits worth keeping.

## Architecture

- Static site: HTML + Tailwind + vanilla JS, served via GitHub Pages
  (`CNAME` → micatracker.digital-euro-association.de).
- Data pipeline: Google Sheets → `update-data.js` → `data/*.json`, fetched at
  runtime by the pages. The scheduled GitHub Action refreshes the JSON.
- `index.html` is Overview-only (KPIs, charts, changelog). Each register lives
  on its own standalone page: `casp-tracker.html`, `emt-tracker.html`,
  `non-compliant-casps.html`.
- `assets/js/register-view.js` is the single renderer for all three register
  tables (search, sort, filter, CSV/JSON export, summary cards, freshness).
  It reads `#registerRoot[data-register]` and overwrites its contents on load.
- For SEO, `update-data.js` bakes a **static crawlable table** into each intent
  page between `<!-- register-snapshot:start/end -->` markers (inside
  `#registerRoot`). Crawlers/no-JS visitors see real rows; `register-view.js`
  replaces them with the interactive table for JS users. The scheduled Action
  regenerates and commits these snapshots, so never hand-edit between the
  markers.
- Security invariants: `esc()` on all `innerHTML` interpolation;
  `safeHttpUrl()` for links; non-compliant entity websites are rendered as
  plain text, never links. CSP allows only self + Umami.
