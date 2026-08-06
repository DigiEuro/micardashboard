# MiCAR Tracker TODO

## Logo enrichment

- [ ] Add a separate, non-blocking GitHub Actions workflow for CASP logo enrichment. It should run `npm run logos:harvest` and `npm run build:entities`, preserve existing curated assets, publish a review PR for new or changed logos, and report unresolved providers without blocking the regulatory data update.

## DEA member profiles

- [ ] Add a verified DEA member status layer to entity pages. Keep ESMA regulatory facts public and unchanged, while allowing verified members to receive a clearly labelled DEA member badge and approved company-provided profile content. Make clear that membership is not regulatory endorsement.
