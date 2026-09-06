# Publish the fidelity checkpoint

This is a draft checkpoint, not a release or a claim of CS2 parity. It is published
as [draft PR #8](https://github.com/y-meechy/kz-replay/pull/8). The instructions below
document the fallback prepared before GitHub CLI authentication was available;
do not create a duplicate PR. A Git bundle preserves the exact committed branch,
including tests, benchmark reports and diagnostic images; it excludes ignored game
assets, credentials, dependencies and local build outputs.

From an authenticated checkout of `y-meechy/kz-replay`, with the supplied bundle
saved locally, run:

```sh
git bundle verify /path/to/kz-replay-fidelity.bundle
git fetch /path/to/kz-replay-fidelity.bundle refs/heads/fidelity/source2-assets-and-measurement
git push origin FETCH_HEAD:refs/heads/fidelity/source2-assets-and-measurement
git show FETCH_HEAD:docs/fidelity/pr-description.md > /tmp/kz-replay-fidelity-pr.md
gh pr create --repo y-meechy/kz-replay --draft --base main \
  --head fidelity/source2-assets-and-measurement \
  --title "Preserve Source 2 assets and add fidelity verification" \
  --body-file /tmp/kz-replay-fidelity-pr.md
```

These commands do not replace your working tree or force-update a remote branch.
If the push reports a conflicting branch, inspect that branch before proceeding;
do not force-push over someone else's work. Without GitHub CLI, open a draft PR
in the repository website after pushing and paste the supplied description.

The full bundle can also be cloned into a new directory if no checkout is available.
Set that clone's `origin` to `https://github.com/y-meechy/kz-replay.git` before pushing.

Maps need reconversion for the new data; production deployment and bulk reconversion remain
pending the visual and hardware-performance acceptance gates.
