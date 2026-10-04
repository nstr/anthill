# Contributing to Anthill

How Anthill is built, run from source, released and laid out. For what Anthill
is and how to use it, see the [README](README.md).

## What Anthill does not do

**Anthill does not run anything.** It never starts, stops, answers or steers an
agent. It has no terminal and no model of its own, and the running app makes no
network calls at all — not to Anthropic, not to OpenAI, not anywhere. (Installing
it downloads dependencies, like any project; using it does not.) The ordering,
conditions, loops and limits in a generated workflow are *instructions for
whoever reads the prompt*, not behaviour Anthill enforces. Generated prompts say
so in their own text, so nobody reading one mistakes a workflow for a guarantee.

It also does not:

- attach to, resume or control a session — observation is one-way and read-only;
- manage permissions, sandboxes or approvals for the agent;
- display private reasoning. It reads records the CLI already writes on this
  machine, and stores only what the Live Session view needs;
- send anything off this machine.

Running workflows — invoking agent CLIs, streaming progress, keeping run history,
isolating workspaces — is a future **Runner / Orchestrator**. Some of its code is
in this repository (`packages/engine`, `runtimes`, `workspace`, `run-store`), it
is not part of the current product, and it is not reachable from the app.

## Requirements

| | |
| --- | --- |
| **Platform** | macOS (Apple Silicon) for the desktop app; macOS and Linux for the CLI. Windows is experimental. See *Platform status* below. |
| **Node.js** | Developed and tested on 22.23. There is no `engines` pin, so older majors are untried rather than refused. |
| **npm** | 10.9 (the one that ships with Node 22). The repo is npm workspaces. |
| **Claude Code** | Optional. `claude` on your `PATH`, signed in. |
| **Codex CLI** | Optional. `codex` on your `PATH`, signed in. |

Neither CLI is required to install or open Anthill. You can design a whole
workflow with neither installed; the app says which tools it can and cannot find
rather than pretending. You need at least one to hand a workflow over, because
that is the CLI you paste the prompt into.

### Platform status

**macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon –
building from source is possible for experimentation, but Windows is not yet
officially supported and some features may not work.**

- **macOS** (Apple Silicon) is where Anthill is developed and tested, and the
  only configuration packaged and released (`npm run package` builds `--mac
  --dir` for `arm64`; releases are a signed `.dmg`).
- **Linux** is supported for the CLI (`apps/cli`), which serves the same app
  as a web page on `127.0.0.1`. There is no Linux desktop package.
- **Windows** has no release, no installer and no support yet. The source is
  not blocked from building or running there: the desktop app shows a one-time
  notice that this is an unsupported, experimental build, then keeps an
  *Unsupported Windows build* chip in view; the CLI prints the same warning and
  carries on. Anything verified not to work is turned off where it is, with its
  own explanation. Nothing guarantees compatibility, data safety or support.
  WSL is optional experimentation, never a requirement or the advertised path.
  [Report a Windows issue](https://github.com/anthillapp/anthill/issues/new?template=windows.yml)
  — reports are welcome, a response is not guaranteed while Windows is
  unsupported.

A Windows CI build, if one is added, only catches compile and packaging
regressions. It is not evidence of support: Windows becomes supported only
after real-machine testing of the desktop app, the CLI, storage, hooks,
harness discovery, deep links and installation, and a decision to publish a
Windows artifact. Until then the paths in this README are macOS paths.

## Install

### From a release

Download the `.dmg` from
[Releases](https://github.com/anthillapp/anthill/releases), open it, and drag Anthill
to Applications. macOS on Apple Silicon only.

A release built with the signing secrets in place is **signed with an Apple
Developer ID and notarised**, and opens on a double-click with none of the
ceremony below. The notarisation ticket is stapled to the app itself, so it
survives being dragged out of the disk image and keeps working offline.

**If the release was built without them, the first launch is refused.**
Gatekeeper blocks it with *"Apple could not verify Anthill is free of
malware"*, and double-clicking again will not help. The build's own release
notes say which kind it is.

What to do then depends on the version of macOS, because Apple changed it:

- **macOS 15 Sequoia and later** — try to open it once and let it be refused.
  Then go to  **System Settings ▸ Privacy & Security**, scroll to the bottom,
  and press **Open Anyway** beside the message about Anthill. Confirm.
- **macOS 14 Sonoma and earlier** — **right-click** Anthill in Applications,
  choose **Open**, and confirm **Open** in the dialog. (This shortcut was
  removed in macOS 15; on newer systems it now offers only *Move to Trash*.)

Either way macOS remembers the decision and every launch after that is
ordinary.

This applies to a build *downloaded* from Releases. One you built yourself
never came from the internet, carries no quarantine flag, and opens without
any of the above.

Nothing about the app changes either way; the only difference is whether macOS
has been told who built it.

### From source

From a clean checkout. master is the latest release; to work on the next one,
check out the next-release branch first (see *Pull requests* below).

```bash
npm install
```

Then fetch the Electron build of one native dependency:

```bash
node apps/desktop/scripts/fetch-electron-sqlite.mjs
```

Expected last line:

```text
Electron-ABI better_sqlite3 written to <repo>/apps/desktop/native/better_sqlite3.node
```

A native addon is compiled against one runtime's ABI. The copy npm installs
targets your system Node; Electron refuses to load it. This writes a second
binary beside it so the tests and the app each get the one they need. It belongs
to the future runner rather than to the workflow builder, but the app expects it
at startup.

Now start it:

```bash
npm run dev:desktop
```

This builds every workspace package and then opens the Electron window. Expect
about a minute the first time. The window is the Anthill launcher: the app mark,
three ways to start and a fourth for a workflow a coding session hands over on
the left, your workflows and agents on the right.

Development uses a separate application profile. On macOS, its data lives in
`~/Library/Application Support/@anthill/desktop-dev`; the installed application
keeps `~/Library/Application Support/@anthill/desktop`. You can run both at once
to test the dev window while watching its QA session in the installed app.
The first dev launch starts with fresh settings, agents and recents; existing
data is not copied or moved. Workflow files explicitly opened from disk remain
shared files, so use a dedicated test folder for QA documents.

Each profile still permits only one running instance. The temporary
`ANTHILL_DEV_ALLOW_MULTIPLE` bypass is no longer supported. CLI authentication,
session records and local hook input remain in their existing locations; each
Anthill profile keeps its own observation journal. Harness hook installation
still changes shared CLI configuration, so review it before enabling or disabling
hooks in either instance. For manual dev QA, target the native Electron window,
not the renderer URL in a browser.

To check the tree without running it:

```bash
npm run typecheck
npm test
```

Both should pass on a clean checkout.

## Your first workflow

1. **Create one.** In the launcher, *Create New Workflow…* starts from a
   template or blank. *Workflow from a Prompt…* describes the work in your own
   words and asks a local CLI to draft a workflow — that run is locked down: no
   tools, an empty temporary folder, and none of your MCP servers. Attach a
   project folder and the CLI may read it, read-only, so the draft fits your
   stack, scripts and tests; it still cannot change or run anything there.
2. **Design it.** Drag steps from the palette, connect them, and give each step
   an agent. A connection can carry a condition; a loop needs a pass limit and
   done criteria. The Problems list says what is unfinished and takes you to the
   field that fixes it.
3. **Hand it over.** Open the handover. Anthill asks for the project folder,
   writes the agent files into it, registers the run, and copies the prompt.
   That order matters: a harness fixes its list of callable agents when its
   session starts, so the files must be in place before you paste.
4. **Paste it yourself.** Start Claude Code or Codex in that project and paste
   the prompt. **Anthill does not do this for you and cannot.**
5. **Watch it.** If Live Observation is on, Anthill recognises the session from
   the run marker at the top of the prompt and the workflow shows what the
   session is doing — which step it announced, what came back, where it looped.
   When it cannot tell, it says so rather than guessing.

Without Live Observation the first four steps work exactly the same. You lose
step 5 and nothing else.

## Live Observation

Anthill sees a session in two ways, both passive:

- **Transcripts and rollouts** it can read on its own — `~/.claude/projects/`
  for Claude Code, `~/.codex/sessions/` for Codex. Nothing to install.
- **Local hooks**, which the CLI calls as it works. More timely, and they need
  one-time setup.

Open **Settings** (⌘,) to install them. Anthill adds its own entries to
`~/.claude/settings.json` and `~/.codex/hooks.json`, backing the file up first,
and marks each entry as its own so disabling later removes only what it added.
The hook command appends a line to `~/.anthill/live-hooks/events.jsonl` and
exits. It reads nothing else and sends nothing anywhere.

**Verifying it worked.** Settings reports each harness separately, and it
distinguishes states that look alike:

- *Not installed* — no Anthill entries in that config file.
- *Installed, waiting* — entries are there, and the CLI has not called them yet.
- *Working* — an event has actually arrived. This is the only state that proves
  the hooks run, because a config file can be correct and still never be read.

If a harness stays at *installed, waiting*, start a session in that CLI and do
something in it. Anthill re-checks when you come back to the window. You can also
look directly:

```bash
tail -f ~/.anthill/live-hooks/events.jsonl
```

Lines appearing there while a session runs means the hooks work, whatever the
screen says.

## What lands in your project

Only the agent files, and only in the folder you choose during handover:

- **Claude Code** — `.claude/agents/<agent>.md`, Markdown with YAML front
  matter.
- **Codex** — `.codex/agents/<agent>.toml`, the documented custom-agent schema.

The prompt itself goes to your clipboard, not to disk. Anthill writes nothing
else into your repository.

> **Codex version note.** Project-scoped custom agents are a recent Codex
> feature. Anthill checks the `codex` on your `PATH` — not a copy inside some
> application bundle — and if that build does not read `.codex/agents`, the app
> says *Update needed* on the tool's card, keeps whatever model you chose, marks
> it "saved, but not applied", and warns you before handover that the files will
> be ignored and every step will run on the session's own model. Nothing is
> blocked; the choice becomes true when you update.

## Where Anthill keeps things

Workflows and session data stay local. Anthill has no account or sync. Both the
macOS app and the Linux CLI offer independent controls under **Settings → Privacy**.
All three are on by default and each can be turned off there at any time:

- **Anonymous product analytics** sends a random app identifier and the
  names of a few app actions (opening Anthill, enabling analytics, opening or
  saving a workflow, starting live observation) to PostHog, along with the SDK name and version.
  PostHog discards the sender's IP address. It sends no prompts, workflow contents,
  paths, clicks, page views, or recordings. Turning it off stops future events
  and deletes the local identifier.
- **JavaScript error reports** send sanitized stack locations to Sentry, with
  messages, user data, breadcrumbs, and runtime context removed; Sentry is told
  not to infer, and set not to store, the sender's IP address. Turning it on
  takes effect after a restart; turning it off stops new reports immediately.
- **Native crash reports** (macOS only) separately permit Electron memory dumps
  to Sentry. A dump may contain private data from memory. This requires error
  reporting and a restart. Turning it off stops new uploads immediately.

On macOS, only releases the release workflow published can send
diagnostics: development runs, manual workflow runs and locally built packages
have it compiled out. On Linux, any built CLI can, once you opt in; the
`run`, `step`, `done` and `observation` commands never report. The browser page
the CLI serves sends nothing itself: its errors go to the CLI process over the
local bridge and leave from there, through the same consent check. Session
replay is off.

Release builds need no PostHog or Sentry credentials to send opted-in events;
their project token and DSN are public client configuration. To upload private
source maps during a release, create a Sentry organization token with the
`org:ci` scope and store it as the `SENTRY_AUTH_TOKEN` GitHub Actions repository
secret. The release build uses that secret to upload the maps and removes the
local map files afterward. Without it, releases still build and error reports
arrive, but Sentry cannot map minified stack positions back to source.

| Path | What |
| --- | --- |
| `~/Library/Application Support/@anthill/desktop/` | Recent workflows, the agent library, pending-run state |
| `~/.anthill/live-hooks/events.jsonl` | The hook event log |
| `~/.anthill/live-observation-setup.json` | Whether you dismissed or installed hook setup |
| `~/.claude/settings.json`, `~/.codex/hooks.json` | Your CLIs' own configs — Anthill adds only its own marked entries |

Your workflows are ordinary `.workflow.json` files, wherever you saved them.

Anthill reads two things it does not own: your CLIs' session transcripts, to
follow a run, and Codex's model catalogue, to offer real model names instead of
a list hand-copied into our source. Both are read-only, both are local.

## Troubleshooting

**A blank window in development.** The Vite dev server on port 5173 has died.
Check with `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` and
restart `npm run dev:desktop` if it is not answering.

**`npm run dev:desktop` exits immediately.** Another dev instance may already
hold the development profile's single-instance lock. Check that instance and
the startup log. The installed `Anthill.app` uses a separate profile and may
stay open. After upgrading from a dev build that shared installed data, quit
the old dev instance before restarting it with the new code.

**`ERR_DLOPEN_FAILED` or a `NODE_MODULE_VERSION` mismatch at startup.** The
Electron build of `better-sqlite3` is missing. Re-run
`node apps/desktop/scripts/fetch-electron-sqlite.mjs`. Re-running is safe; it
never writes into `node_modules`.

**A CLI shows as "not found" that you know is installed.** Anthill asks your
login shell for its `PATH` at startup, because an app launched from Finder is
started by launchd and inherits a bare system `PATH` with none of the places a
CLI lives. If it still cannot see one, check that the command works in a *new*
terminal window — if the `PATH` that makes it work is set somewhere an
interactive login shell does not read, Anthill will not see it either.

**A CLI shows as "signed out" and you are not.** Anthill asks the CLI, and takes
an unclear answer as unclear rather than as a no. If it says *signed out*, the
CLI said so; sign in from that CLI's own window and come back — Anthill re-checks
when the window regains focus. It never handles your credentials.

**The session is running and Anthill shows nothing.** Check the hook log above.
If the log is empty, the hooks are not installed or the CLI is not calling them.
If the log has lines, the run marker was probably lost — that happens when the
prompt is edited before pasting.

## Building a release

```bash
npm run dist --workspace=@anthill/desktop
```

Writes `apps/desktop/release/Anthill-<version>-arm64.dmg`. Signed with whatever
Developer ID certificate the machine has, and ad-hoc signed when it has none —
which is the same build, minus Apple having been told who made it.

CI builds the same image on a macOS runner with
`.github/actions/macos-package`. The `macos-package` job does it on pull
requests into master, and publishes nothing. When a verified release reaches
master ([RELEASING.md](RELEASING.md)), `.github/workflows/release.yml` sees a
version with no `v<version>` tag yet, builds the image again on that commit,
tags it and attaches the image to the release. It runs no checks of its own:
the pull request passed them on exactly that tree. Merging the release is the decision to
publish; a push to master whose version is already released publishes nothing.
`workflow_dispatch` builds the image without publishing.

**Signing it properly.** The packaging is already configured for it — hardened
runtime, the entitlements Electron needs under it, and notarisation are all in
`apps/desktop/package.json`, and the release workflow signs and notarises when,
and only when, the secrets exist. Without them it builds exactly as before and
says in the log that it did. So all that is missing is an Apple Developer
Program membership ($99/year) and five repository secrets:

| Secret | What it is |
|---|---|
| `MACOS_CERTIFICATE` | the **Developer ID Application** certificate exported from Keychain Access as `.p12`, then base64-encoded |
| `MACOS_CERTIFICATE_PASSWORD` | the password set on that export |
| `APPLE_API_KEY_P8` | an App Store Connect API key (`.p8`), base64-encoded |
| `APPLE_API_KEY_ID` | that key's ID |
| `APPLE_API_ISSUER` | the issuer ID from App Store Connect |
| `APPLE_TEAM_ID` | the team the certificate belongs to |

Note that **Apple Development** and **Apple Distribution** certificates will not
do: the first is for running on your own machines, the second for the App
Store. Distributing a Mac app outside the App Store needs a *Developer ID
Application* certificate specifically, which is created by the account holder.

With those in place a release produces a build that opens on a double-click, and
the workflow's last step says which of the two kinds it made rather than
leaving it to be discovered by whoever downloads it.

**Intel Macs are not covered.** The target is `arm64` only. A `universal` build
is possible but the native dependency is fetched per-architecture, so it needs
both copies — untried here rather than known to work.

## Repository layout

```text
apps/
  desktop/           Electron app: the launcher, canvas, handover and Live Session
  mcp/               the local stdio MCP server a coding harness hands a workflow over through

packages/
  workflow-schema/   the graph model and its validation
  workflow/          actions, agents, harness profiles, validation, prompt and file compilation
  workflow-exchange/ the contract a coding harness hands a workflow over on
  exchange-store/    handed-over workflows on disk: identity, revisions, readiness, bindings
  exchange-host/     the app side of a handover: the inbox, working copies, links (desktop and web shell)
  builder/           canvas, palette, document operations
  live/              run markers, pending-run state, bootstrap prompts, observation events
  ui/                shared UI primitives

  # Future Runner / Orchestrator — not part of the product today
  engine/            workflow execution
  runtimes/          Codex CLI and Claude Code adapters
  workspace/         repository and isolation management
  run-store/         run persistence
```

## Pull requests

master holds the latest release and nothing newer: Linux and Windows build it
from source, and plugins installed from GitHub run it. The next release
collects in a branch named after the release it follows — `0.8.8-next` while
master is 0.8.8, since its own number is chosen only when it is frozen — and
that is where pull requests go:

```bash
npm run release -- status    # names the next-release branch
git switch -c my-change origin/<version>-next
```

Open the pull request against `<version>-next`, not master; a pull request
into master from any other branch fails the `release-gate` check. The whole
process, from the freeze to the tag and hotfixes, is in
[RELEASING.md](RELEASING.md).

## Issues

Report bugs and request features in
[GitHub Issues](https://github.com/anthillapp/anthill/issues). For anything about a
session Anthill misread, say which CLI and whether hooks were installed — those
two facts decide almost every observation question. Windows problems have their
own [form](https://github.com/anthillapp/anthill/issues/new?template=windows.yml).

Note that `docs/` is git-ignored: it is a scratch directory for generated
reports, not project documentation.
