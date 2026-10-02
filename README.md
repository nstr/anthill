# Anthill

Anthill turns a coding task into a workflow you can see. You draw the steps, or
let your agent draft them: who does each one, and where work loops back. Then
you watch Claude Code, Codex, Pi or VS Code's agent carry it out, step by step,
on a live diagram.

Anthill plans and observes. It never runs, stops or steers an agent: the work
happens in your own CLI session, signed in as you.

Use it when a task is big enough to need a plan, such as a feature with review
and tests or a refactor shared between several agents, and you want to see
where the session actually is.

## Install

**macOS (Apple Silicon):** download the `.dmg` from
[Releases](https://github.com/nstr/anthill/releases), open it and drag Anthill
to Applications.

**Linux:** Anthill runs as a local web app, built from source:

```bash
npm install && npm run build
npm install --global ./apps/cli
anthill            # opens Anthill on 127.0.0.1
```

macOS: desktop app and CLI. Linux: CLI. Windows support is coming soon – building from source is possible for experimentation, but Windows is not yet officially supported and some features may not work.

You need at least one of [Claude Code](https://claude.com/claude-code),
[Codex](https://github.com/openai/codex), [Pi](https://pi.dev) or
[VS Code](https://code.visualstudio.com) with its agent, installed and signed
in.

## Plugins

The plugin lets your coding session hand its workflow to Anthill, so you don't
have to copy and paste a prompt. It is optional, but it is the recommended way.
It needs Node.js on your `PATH`.

**Claude Code:**

```bash
claude plugin marketplace add nstr/anthill
claude plugin install anthill@anthill
```

**Codex:**

```bash
codex plugin marketplace add nstr/anthill
codex plugin add anthill@anthill-local
```

**VS Code (beta):** VS Code has no command for plugins. Add this repository
as a plugin marketplace in your user `settings.json`:

```json
"chat.plugins.marketplaces": ["nstr/anthill"]
```

Then open **Agent Customizations ▸ Plugins ▸ Browse Marketplace**, choose
**anthill** and **Install**. VS Code asks you to trust `nstr/anthill` first.

Then start a new session. More in the [Claude Code](plugins/anthill-claude/README.md),
[Codex](plugins/anthill-codex/README.md) and [VS Code](plugins/anthill-vscode/README.md)
plugin guides.

Pi has no plugin. Copy the prompt from Anthill and paste it into Pi.

## Use

There are two modes. The difference is who owns the plan.

**design**: you shape the plan before any work starts. The agent asks what it
needs to know, drafts the workflow and stops. Edit it in Anthill, press
**Save**, and tell the session to go.

```text
/anthill:workflow design Add retry-once to the checkout flow     # Claude Code, VS Code
$anthill design Add retry-once to the checkout flow              # Codex
```

**watch**: the agent plans and starts at once, and Anthill shows the work as
it happens.

```text
/anthill:workflow watch Rework the importer                      # Claude Code, VS Code
$anthill watch Rework the importer                               # Codex
```

Without a plugin, build the workflow in Anthill, press **Copy prompt**, and
paste it into your CLI. Anthill recognises the session and follows it the same
way.

## Principles

- **Local.** Workflows are plain `.workflow.json` files. Run data stays on
  your machine. There is no account and no sync.
- **No requests out, except diagnostics.** Anthill sends nothing anywhere
  except the anonymous diagnostics [below](#where-anthill-keeps-things), and
  you can turn those off. Your CLI talks to its own provider as usual; Anthill
  does not.
- **Read-only.** Anthill reads what your CLI already writes on disk and never
  sees private reasoning. In your project it writes only the agent files you
  hand over (`.claude/agents/`, `.codex/agents/`).
- **Instructions, not enforcement.** Order, conditions and loop limits are
  instructions for the agent. Anthill shows whether they were followed. It
  cannot force them.

<a id="where-anthill-keeps-things"></a>

## What leaves your machine

Three kinds of diagnostics. All three are on by default, and each can be turned
off in **Settings → Privacy**:

- **Anonymous usage analytics** (PostHog): a random app identifier and the
  names of a few actions, such as opening Anthill or saving a workflow. No
  prompts, workflow contents, paths or clicks.
- **Error reports** (Sentry): stack locations, with messages and user data
  removed. IP addresses are not stored.
- **Crash reports** (macOS, Sentry): a memory dump when the app crashes. It may
  contain data that was in memory at the time.

On macOS only release builds send diagnostics; the Linux CLI sends them too
unless you turn them off. Nothing else leaves your machine. Details are in
[CONTRIBUTING.md](CONTRIBUTING.md#where-anthill-keeps-things).

## Links

[Website](https://getanthill.ai) ·
[r/AnthillApp](https://www.reddit.com/r/AnthillApp/) ·
[Buy me a coffee](https://buymeacoffee.com/anthill) ·
[Report an issue](https://github.com/nstr/anthill/issues) ·
[Build from source and contribute](CONTRIBUTING.md)

MIT licensed. See [LICENSE](LICENSE).
