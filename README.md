# Digital Euro Association (DEA) MiCAR Tracker

This project tracks issuers of Electronic Money Tokens (EMTs) and Crypto-Asset Service Providers (CASPs) under the MiCAR framework. The dashboard is a simple static site that reads data from a public Google Sheets document and visualises it using HTML and Tailwind CSS.

## Data source

`update-data.js` downloads a CSV export of the ESMA registers from Google Sheets, ensuring the dashboard reflects the latest EMT and CASP information published by the regulator.

The script parses the CSV, converts each row into a JavaScript object and then rewrites `index.html` with the new data and a human‑friendly source date.

## Configuration

The script reads CSV locations from the `CSV_URL` and `DATE_URL` environment variables. If they are not set, default URLs pointing to the public Google Sheet are used.

## Google Sheets API & caching

- Set `GOOGLE_API_KEY` (and optionally `GOOGLE_SHEET_ID`) to allow `update-data.js` to read the registers via the Sheets API before falling back to CSV exports. The default sheet ID already targets the shared tracker.
- The script first queries the `snapshot!A1:B3` range (gid `353293525`). If neither the EMT nor CASPs snapshot date changed since the last run, cached JSON payloads from the `data/` directory (`emts.json`, `casps.json`, `non-compliant.json`) are reused to avoid unnecessary API calls.
- When the snapshot date changes—or when cached data is missing—the EMT (`Jurisdiction!A1:L50`, gid `0`), CASPs (`CASPs!A1:F150`, gid `1275732000`), and non-compliant (`Non Compliant!A1:E150`, gid `409089345`) ranges are fetched, converted, written back to `index.html`, and persisted under `data/` for GitHub Actions or local debugging.
- All API requests include exponential backoff and structured error logging; if the API returns an error or the key is not available, the previous CSV download logic is used as a fallback automatically.
