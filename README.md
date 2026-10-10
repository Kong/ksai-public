# ksai-public

The KSAI runtime, published here so a repository that cannot resolve `uses:` into an internal repository can still call it.

**This branch carries the release candidate v5.0.0-rc.75.** `rc/v5.0.0-rc.75` holds its snapshot, written once and never moved. The control plane serves it only to the projects it lets run release candidates, and refuses it to every other repository. Pin the full commit this branch names, with `# v5.0.0-rc.75` in a trailing comment.

**Nothing here is edited by hand.** Every file is generated and the whole tree is overwritten on each release, so a change made here is lost at the next one.

**It runs only through the KSAI control plane.** `.github/workflows/ksai.yml` is the one workflow you call. It takes no inputs and no secrets, and every job in it starts only on the `workflow_dispatch` the control plane sends. The control plane holds the repository's settings, mints every App token a run uses and every model token it spends, leaving the job's own `GITHUB_TOKEN` only what the caller's permissions grant it, and answers only a run of a release it admits. So the KSAI App has to be installed on the repository and the repository enrolled with the control plane before anything runs, and a run started any other way does nothing.

**Pin a general release.** Tags here are general releases of v5 and later, `vX.Y.Z`, and no tag names a pre-release or a floating major. A branch named `rc/vX.Y.Z-rc.N` carries a release candidate, which the control plane serves only to the projects it lets run release candidates. Call the workflow from a job in a file that answers only `workflow_dispatch`, pinned to the full commit a tag names with the version in a trailing `# vX.Y.Z` comment, and grant that job `contents: read` and `id-token: write`. The token is how the run proves to the control plane which repository and release it is. A tag pinned directly works too, but a commit cannot move.
