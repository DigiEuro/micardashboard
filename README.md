# Digital Euro Association (DEA) MiCAR Tracker

This project tracks issuers of Electronic Money Tokens (EMTs), Crypto-Asset Service Providers (CASPs), and non-compliant entities under the MiCAR framework. The dashboard is a static site (HTML + Tailwind CSS + vanilla JS) served via GitHub Pages that loads its register data from JSON files at runtime.

## Architecture

- **`data/*.json`** — the registers themselves. `emts.json`, `casps.json`, and `non-compliant.json` are the single source of truth; the page fetches them on load. `snapshot.json` records the sheet snapshot dates and the last refresh time, and `changelog.json` records dated additions/removals.
- **`update-data.js`** — the scheduled updater. It reads the source Google Sheet (Sheets API when `GOOGLE_API_KEY` is set, public CSV export otherwise), converts the rows, diffs them against the previous data to extend the changelog and `feed.xml` (RSS), writes the JSON files, and patches the human-readable "Data as of" dates in `index.html`'s footer.
- **`.github/workflows/update-dashboard.yml`** — runs the updater every 6 hours and commits `index.html`, `data/`, and `feed.xml` when anything changed.
- **`.github/workflows/ci.yml`** — runs on pull requests and pushes to `dev`: script syntax checks, updater-marker checks, and data validation.

## Data API

The JSON files are stable, publicly served endpoints — feel free to consume them directly:

| Register | URL |
| --- | --- |
| EMT issuers | `https://micatracker.digital-euro-association.de/data/emts.json` |
| CASPs | `https://micatracker.digital-euro-association.de/data/casps.json` |
| Non-compliant entities | `https://micatracker.digital-euro-association.de/data/non-compliant.json` |
| Change history | `https://micatracker.digital-euro-association.de/data/changelog.json` |
| Snapshot metadata | `https://micatracker.digital-euro-association.de/data/snapshot.json` |
| RSS feed of register changes | `https://micatracker.digital-euro-association.de/feed.xml` |

Each table on the dashboard also offers CSV export of the currently filtered view.

## Configuration

The updater reads feed locations from the `CSV_URL`, `DATE_URL`, `NON_COMPLIANT_URL`, and `CASPS_URL` environment variables, defaulting to the public Google Sheet exports in `config.js`. Set `GOOGLE_API_KEY` (and optionally `GOOGLE_SHEET_ID`) to use the Sheets API instead of CSV exports; the API path falls back to CSV automatically on errors.

## Caching

The updater first fetches the snapshot dates. If neither the EMT nor CASPs snapshot date changed since the last run, the cached JSON under `data/` is reused and no full refetch happens. When the snapshot changes, all registers are refetched, diffed for the changelog, and persisted.

## Validation

`npm run validate:data` validates the JSON registers (EMT token counts vs. per-currency totals, required fields on CASPs and non-compliant entries) and cross-checks currency metadata against `index.html`. CI runs this on every pull request; the update workflow runs it before committing.

## Building the CSS

Tailwind output is committed at `styles/tailwind.css`. After changing markup or `tailwind.config.js`, rebuild with:

```
npm install
npm run build:css
```

Fonts (Inter), icons (Font Awesome), and the flag-emoji polyfill are vendored under `assets/vendor/` — the site makes no third-party requests except Umami analytics.
