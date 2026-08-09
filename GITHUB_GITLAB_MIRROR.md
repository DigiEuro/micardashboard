# GitHub canonical repository and GitLab backup

GitHub is the canonical repository: it is the place where code is changed and
the production branch is merged. GitLab is an automatic backup mirror of the
GitHub branches and tags.

## One-time setup

1. Create a GitLab personal access token with the `write_repository` scope.
   Do not put the token in a commit or paste it into chat.
2. In GitHub, open **Settings > Secrets and variables > Actions** and create a
   repository secret named `GITLAB_MIRROR_TOKEN`. Paste the token as its value.
3. Merge the workflow in `.github/workflows/mirror-to-gitlab.yml` into the
   GitHub default branch, then run **Mirror repository to GitLab** once from
   the Actions tab.
4. Check GitLab's **Settings > Repository > Mirroring repositories** and
   confirm the GitHub-to-GitLab backup has updated.

The current GitLab mirror is configured in the opposite direction (GitLab →
GitHub). Remove that old push mirror after this workflow succeeds so the two
systems cannot compete with each other.

## Normal operation

Every push to GitHub, including branch and tag updates, runs the workflow and
updates GitLab without a manual step. If the mirror fails, GitHub remains the
live source and the failed workflow is visible in Actions.
