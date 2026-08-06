# MiCAR Tracker TODO

## Logo enrichment

- [ ] Add a separate, non-blocking GitHub Actions workflow for CASP logo enrichment. It should run `npm run logos:harvest` and `npm run build:entities`, preserve existing curated assets, publish a review PR for new or changed logos, and report unresolved providers without blocking the regulatory data update.

## DEA member profiles

- [ ] Add a verified DEA member status layer to entity pages. Keep ESMA regulatory facts public and unchanged, while allowing verified members to receive a clearly labelled DEA member badge and approved company-provided profile content. Make clear that membership is not regulatory endorsement.

## Automated review follow-ups

- [ ] Harden logo downloads with response MIME and file-signature validation. Never save an HTML response under an image extension; add tests for common error pages and redirects.
- [ ] Reject generic `og:image` and Twitter preview artwork unless a clear logo/brand signal exists. Re-audit and replace the current promotional false positives (including Trade Republic and Swissquote).
- [x] Remove the explicit `/pages/builds` request from the dashboard updater and rely on the automatic Pages deployment from `main`, avoiding competing deployments.
- [ ] Revisit the updater’s merge path if `main` becomes protected: ensure required checks have an explicitly permitted, auditable merge path rather than relying on a skipped PR-check wait.
