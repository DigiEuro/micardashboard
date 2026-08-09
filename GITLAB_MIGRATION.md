# GitLab source and CI migration

GitLab is the intended canonical repository for the MiCAR Tracker. The
GitLab project pushes a mirror to GitHub so the public GitHub repository and
its history remain available as a second copy.

## One-time GitLab setup

1. Merge `dev` into `main` in GitLab.
2. Open **Settings > CI/CD > Job token permissions** and enable **Allow Git
   push requests to the repository**. The scheduled updater uses the
   short-lived `CI_JOB_TOKEN` to commit generated data; it does not require a
   long-lived token when this setting is enabled.
3. Open **Build > Pipeline schedules**, create a schedule for branch `main`
   with cron `0 */6 * * *`, and run it manually once. The updater reads the
   existing defaults in `config.js`; add `CSV_URL`, `DATE_URL`,
   `NON_COMPLIANT_URL`, or `CASPS_URL` as masked schedule variables only if a
   source override is needed.
4. Confirm that the scheduled job passes validation, and that its commit is
   mirrored to GitHub.

If the project policy does not allow CI job-token pushes to `main`, create a
masked `GITLAB_PUSH_TOKEN` CI/CD variable instead. It must be a project access
token that can write the repository, and it should be protected if `main` is
protected. The pipeline uses it only as a fallback.

## Cloudflare Pages

Once the merge request checks are green, open the Cloudflare Pages project and
change its connected repository from GitHub to
`digital-euro-association-group/micardashboard` on GitLab. Doing this before
the merge lets the GitLab `main` push be the first deployment test. If you
switch after the merge, use Cloudflare's **Retry deployment** action to verify
the GitLab connection. The GitHub mirror remains the rollback copy; reconnect
Cloudflare to GitHub only if a rollback is needed.

After the first scheduled GitLab update succeeds, disable the legacy GitHub
scheduled updater so there is only one data writer.

The GitLab pipeline validates and commits the generated site files. Cloudflare
Pages remains responsible for building and publishing the static site from
the `main` branch.

## Rollback

The GitHub mirror remains a complete copy. If GitLab CI or Pages needs to be
rolled back, re-enable the GitHub schedule/connection while the GitLab project
is repaired. Do not delete the `dev` branch.
