# Releasing Anthill

How changes reach a release: which branch to work on, how a release is frozen
and checked, how it reaches master, and how it is tagged. This is the only
description of the process. [AGENTS.md](AGENTS.md) gives coding agents a short
list of the rules that apply to every task and sends them here for the rest;
if the two ever disagree, this file is right.

## Why master is special

**master is the stable channel.** Linux and Windows users build Anthill from
source on master, and a plugin installed from GitHub runs the MCP server
committed there. macOS ships separately, as the disk image the Release
workflow builds and publishes when a release reaches master. So master only
ever receives a release whose exact commit was checked, or a hotfix, and the
macOS release is tagged on that same master commit: every platform's stable
code is one release.

## Branches at a glance

| Branch | What it is | Starts from | Merges into |
| --- | --- | --- | --- |
| `master` | the latest release, nothing newer | — | — |
| `<V>-next` | the next release, collecting work | master | master, as one pull request |
| your feature or fix branch | one change | `origin/<V>-next` | `<V>-next`, squash |
| `hotfix/<topic>` | an urgent fix to the released version | master | master |
| `sync/<V>` | master brought into `<V>-next` after a hotfix | `<V>-next` | `<V>-next`, merge commit |

`<V>` is the version in master's `package.json`, the release the branch
follows: `0.8.8-next` while master is 0.8.8. The branch is not named after the
release it will become, because whether that is a patch, a minor or a major is
decided only when it is frozen.

```mermaid
%%{init: {"gitGraph": {"mainBranchName": "master"}}}%%
gitGraph
  commit id: "v0.8.8"
  branch "0.8.8-next"
  commit id: "feature A"
  commit id: "fix B"
  commit id: "release 0.8.9 (freeze)"
  commit id: "fix found by checks"
  checkout master
  merge "0.8.8-next" id: "v0.8.9" tag: "v0.8.9"
  branch "0.8.9-next"
  commit id: "feature C"
```

(The diagram draws the squash as a merge; on master it is a single commit.)

`npm run release -- status` prints the next-release branch, whether it is open
or frozen, and its tip.

## Day to day

1. Start from the next-release branch:

   ```bash
   npm run release -- status
   git switch -c my-change origin/<V>-next
   ```

2. Open the pull request against `<V>-next`, never master. It merges with
   **squash** once `check` passes. A pull request into master from any other
   branch fails the required `release-gate` check, and GitHub refuses a direct
   push to master.
3. If `<V>-next` does not exist (`status` says so), create it from master:
   `git push origin origin/master:refs/heads/<V>-next`. Normally it is created
   right after each release, so there is always one.

The branch is **open** while its `package.json` still carries master's version:
features and fixes go in. It is **frozen** once the release's version bump has
merged: from then on it takes only fixes for what the release's checks found,
and release chores. A feature that misses the freeze waits as a draft pull
request and moves to the next `-next` branch once that exists.

## Freezing a release

1. **The maintainer chooses the version.** When the release's content is
   complete, the maintainer decides which version `<V>-next` becomes, for
   example `0.8.7-next` = `0.8.8`. Nobody else picks it — not a contributor,
   not a coding agent.
2. **The freeze** is a pull request `chore: release X.Y.Z` into `<V>-next` that
   sets the version everywhere and rebuilds the plugin bundle. The version, the
   bundle and the release notes are all done here, before anything goes to
   master:

   ```bash
   npm run version:set -- X.Y.Z
   npm install
   npm run plugin:bundle
   ```

   `version:set` writes every workspace `package.json`, the Claude Code plugin
   manifest and its marketplace entry, the Claude Code skill's frontmatter, the
   VS Code plugin manifest and its marketplace entry, and the Codex plugin
   manifest (with a fresh `+codex.<timestamp>` build suffix, which is what
   makes Codex treat a reinstall as new). `apps/mcp/src/versions.test.ts` fails
   if any of them disagree, so a version written by hand is caught.

   `npm run plugin:bundle` builds the MCP server and writes it, with this
   version in its first line, into `server/anthill-mcp.mjs` in every plugin.
   That copy is what a plugin installed from GitHub or a directory runs, so it
   is committed with the release. The same test fails when it is still last
   release's.

The plugin's version tracks the app's release: a plugin-only change ships with
a release, and every release asks installed plugins to update. That is a
choice, made so the two cannot drift apart by accident.

## The release candidate and its checks

1. **The release candidate is one commit**: the branch's tip after the freeze
   merged, named by its full 40-character SHA. Every check is about that commit
   and nothing else; anything run by hand runs on a clean checkout where
   `git rev-parse HEAD` prints that SHA.
2. **Automated checks** run on the release pull request into master (*Moving a
   release into master*), on GitHub's merge of it, whose tree `release-gate`
   requires to be exactly the candidate's: `check`, `linux-source`,
   `windows-source` and `macos-package` (CI). They rerun by themselves when the
   branch is updated. Checks run only on pull requests: a push to `<V>-next` or
   master is the merge of something they already passed. `macos-package`
   builds and signs the macOS disk image with the same steps the Release workflow publishes with
   (`.github/actions/macos-package`), and publishes nothing; its image is the
   run's artefact. These checks are what verifies a candidate.
3. **A bug the checks find** is fixed by a pull request into the branch. The
   new tip is a new candidate, and the release pull request's checks run again
   by themselves.
   Anything else that was run on the old candidate and touches the changed code
   is run again, and the record says what was rerun.
4. **Anything that changes the branch after it was verified** — a fix, a hotfix
   brought in from master, a conflict resolution — makes a new candidate that
   is verified again before it can go to master. `release-gate` enforces this:
   the commit named as verified must be the branch's head.

## What a check proves

Building, automated tests and end-to-end use are different evidence, and one
platform's result says nothing about another. A green macOS CI does not show
that Anthill builds or starts on Linux or Windows; a green `linux-source` does
not show that Anthill works on Linux.

| Evidence | macOS | Linux (supported: CLI) | Windows (experimental) |
| --- | --- | --- | --- |
| Builds | `macos-package` (disk image) | `linux-source`: README steps, `npm run build` | `windows-source`: the same |
| Automated tests | `check`: typecheck and tests on `macos-14` | `linux-source`: `npm test` | not run |
| Starts | not checked automatically | `linux-source`: the CLI serves its page | `windows-source`: the same |
| End to end | only by hand: the desktop app with Codex and Claude Code | only by hand, on a Linux machine | only by hand, on a Windows machine |

Record every cell for the candidate as **passed**, **failed** or **not run**,
and never fill one cell from another. The macOS checks and the Linux build,
tests and start must pass. A Windows failure does not block on its own, but it
is reported and the maintainer decides. End-to-end use is not a required step;
when nobody ran it, the cell says **not run**, and the release is not described
as tested end to end.

## Moving a release into master

1. Open one pull request from `<V>-next` into `master`, titled
   `chore: release X.Y.Z (<V>-next)`. Its description starts with the line
   `` `<V>-next` = X.Y.Z ``, then has a line
   `` Verified commit: `<40-character SHA>` `` and the evidence table above.
   Public text only: no links to internal trackers or plans.
2. `release-gate` checks that the head is `<master's version>-next` or a hotfix
   branch of this repository, that its version is higher than master's, that
   the verified commit is the head, and that the squash will be exactly that
   commit's tree. When master holds changes the branch lacks, or they conflict,
   bring master into the branch (*Hotfixes*, step 5), verify the new candidate
   and update the line. Never resolve conflicts in GitHub's editor, on master,
   or by editing the squash.
3. The maintainer squash-merges it. Only the maintainer merges into master.
4. **The merge publishes it.** The push to master runs the Release workflow,
   and only it. It checks nothing — the pull request passed every check on this
   exact tree — and only publishes: the version has no `vX.Y.Z` tag yet, so it
   builds the macOS disk image again on that master commit, tags the commit `vX.Y.Z` and attaches the image to a
   GitHub release. Nobody pushes a tag by hand, so macOS never ships a release
   master does not have, and master never has a release macOS lacks. A push to
   master whose version is already tagged publishes nothing; one whose version
   is lower than a released one fails the workflow.

   To confirm master is the verified tree and see where the release stands:

   ```bash
   npm run release -- landed <verified SHA>
   ```

## After the release

1. **Refresh the installed plugins.** A plugin installed from a directory is a
   copy, not a live mount — nothing refreshes it on its own:

   ```bash
   claude plugin update anthill@anthill
   ```

   and reinstall the Codex plugin from this checkout's marketplace. VS Code
   updates a plugin installed from a marketplace on its own schedule, as it
   does extensions, unless its auto-update is off. Then start new sessions: a
   running session keeps the skill it started with.

   If this step is skipped, the plugin's launcher reports the version it was
   installed at, and the MCP server puts a notice at the top of its
   instructions naming both versions and this command. That only works once
   the installed copy has a launcher new enough to report its version, i.e.
   from the first update after 0.7.8, and only when the plugin runs a
   checkout's server (`~/.anthill/plugin.json` or `ANTHILL_*`). A plugin
   running the server it carries is always the same version as that server,
   so it says nothing about being behind the app.

2. **The next branch opens by itself.** Once the release is published, the
   Release workflow (`next-branch`) creates `X.Y.Z-next` from the released
   master commit, moves the open pull requests of the branch that was just
   released onto it, and deletes that branch: its work is in master now. A
   `*-next` branch whose tree is not the released commit's is never deleted:
   it holds unreleased work (what a hotfix leaves behind) and is renamed to
   `X.Y.Z-next` instead (*Hotfixes*, steps 4 and 5). If the job did not run,
   do the same by hand:

   ```bash
   git push origin origin/master:refs/heads/X.Y.Z-next
   git push origin --delete <released V>-next
   ```

3. **Rebase the moved pull requests.** Moving a pull request does not change
   its branch, which still carries the old branch's commits that the squash
   replaced on master. Drop them:

   ```bash
   git rebase --onto origin/X.Y.Z-next $(git merge-base HEAD <verified SHA>)
   ```

## Hotfixes

For a released version that cannot wait for the next release:

1. Branch `hotfix/<topic>` from `origin/master`. Commit the fix with its test,
   then set the version and rebuild the plugin bundle (*Freezing a release*,
   step 2). The maintainer chooses the version here too, usually the next
   patch after master's.
2. Verify the hotfix branch's tip like a candidate: the automated checks
   above, on that exact commit.
3. Open a pull request into master as in *Moving a release into master*, with
   its own `Verified commit:` line; the gate, the squash, `landed` and the
   release the merge publishes are the same.
4. master's version has moved, so the next-release branch is renamed after
   it. The Release workflow does this itself after publishing the hotfix
   (`next-branch`); if it did not, `status` prints the command (GitHub
   retargets its open pull requests):

   ```bash
   gh api -X POST repos/{owner}/{repo}/branches/<old V>-next/rename -f new_name=<new V>-next
   ```

   If the branch was already frozen at the number the hotfix took, the
   maintainer chooses a higher one and it is frozen again.
5. Bring master into the next-release branch: branch `sync/<new V>` from it,
   run `git merge origin/master`, keep the branch's own version where they
   conflict (rerun `npm run plugin:bundle` if it is frozen), and open a pull
   request into the branch that is merged with **Create a merge commit**, never
   squash. The merge commit is what lets the release later squash into master
   without conflicts. On a frozen branch this is a new candidate.

## Tools

| Command | Where | What it does |
| --- | --- | --- |
| `npm run release -- status` | anyone | the next-release branch, open or frozen, its tip; how to create or rename it |
| `npm run release -- landed <sha>` | after the merge into master | checks master is the verified tree and says whether it is published |
| `release.mjs gate` | `release-gate` workflow, pull requests into master | the branch, version, verified commit and squash tree checks above |
| `release.mjs released` | Release workflow, on a push to master | the tag to create and publish, or none when the version is already released |
| `release.mjs next-branch` | Release workflow, after publishing | creates `X.Y.Z-next`, moves the released branch's pull requests to it and deletes it, or renames a branch with unreleased work |
| `.github/actions/macos-package` | `macos-package` in CI, the Release workflow | builds, signs and checks the macOS disk image |
| `scripts/smoke-cli.mjs` | `linux-source`, `windows-source` | starts the installed CLI and fetches its page, with diagnostics off |

GitHub enforces the rest: master takes pull requests only, squash only, with
`check`, `linux-source`, `windows-source`, `macos-package` and
`release-gate` passing; `*-next` branches take pull requests only,
with `check` passing, and refuse force pushes.
