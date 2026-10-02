# The Anthill plugin for VS Code (beta)

Hands the work of a VS Code agent chat to Anthill as a workflow you can read and
edit, then reports progress against the graph you settled on.

Anthill runs nothing. VS Code's agent does the work; Anthill draws it and
watches.

This is VS Code's own agent-plugin format: `plugin.json` at the root,
`.mcp.json`, and `skills/`. It needs VS Code with agent plugins (1.110 or
later) and a chat that can use tools, such as one in Agent mode.

**Beta.** Both modes and a copied prompt work end to end in VS Code's Agents
window. What is still rough:

* Anthill cannot install it for you; VS Code takes plugins only from its own
  settings (see Installing).
* Tool calls reach Anthill from VS Code's session record rather than from its
  hooks, which carry no call id to pair a start with its end.
* Every step runs on the chat's model; a workflow cannot pin a model per agent.

## What it gives you

* `/anthill:workflow` — one skill, taking `design` or `watch` plus the task.
* Six MCP tools from Anthill's own server, which the skill calls for you.

## Installing

You need [Anthill](https://github.com/nstr/anthill) itself, and Node.js on your
`PATH` (the plugin's server is a Node program).

VS Code has no command line for plugins; both ways in are settings.

**From GitHub.** Add Anthill's repository as a plugin marketplace in your user
`settings.json`:

```json
"chat.plugins.marketplaces": ["nstr/anthill"]
```

Then open **Agent Customizations ▸ Plugins ▸ Browse Marketplace** (in the
Agents window, **Customizations** in the sidebar), choose **anthill** and
**Install**. VS Code asks you to trust `nstr/anthill` first.

VS Code reads this repository's `.github/plugin/marketplace.json`, which lists
this plugin. Claude Code reads `.claude-plugin/marketplace.json` from the same
repository and never this one, so each tool gets its own plugin named
`anthill`.

**From a checkout.** In **Agent Customizations ▸ Plugins**, choose **Install
from Source** and pick this folder, or point VS Code at it in `settings.json`,
which is what Install from Source writes. VS Code runs the plugin from a copy
it keeps in its own data folder (`Code/agentPlugins/`):

```json
"chat.pluginLocations": { "/abs/path/to/anthill/plugins/anthill-vscode": true }
```

Then start a new chat.

The plugin carries its own copy of Anthill's MCP server, in
`server/anthill-mcp.mjs`. VS Code may ask you to allow that server before it
starts it the first time; **MCP: List Servers** in the Command Palette shows it
and its output.

### What it runs

* **`bin/anthill-mcp`**, started by VS Code as the MCP server
  (`node ${PLUGIN_ROOT}/bin/anthill-mcp --host vscode`). It finds the server
  and runs it with Node on your machine, over stdio. `--host vscode` tells it
  which harness it serves; the server never sees the flag.
* **The server** reads and writes handed-over workflows in Anthill's own data
  folder on this machine, and opens Anthill with an `anthill://` link so the
  workflow appears there.
* **Progress commands** (`anthill run`, `anthill step`, `anthill done`, or the
  `node …/server/anthill-report.mjs` equivalent), which the agent runs in VS
  Code's terminal. VS Code may ask you to allow each one.
* **Nothing is sent off this machine.** No telemetry, no error reports, no
  downloads.

### Running a checkout's own server

As for the other plugins: `ANTHILL_MCP_SERVER`, `ANTHILL_REPO` or
`~/.anthill/plugin.json` name a server built in a checkout, and the launcher
prefers them to its own copy. See the Claude Code plugin's README for the
details; the launcher is the same file.

## Using it

```
/anthill:workflow design Add retry-once to the checkout flow, let me read it first
/anthill:workflow watch  Rework the importer — show me the work as it happens
/anthill:workflow design --dev Add retry-once to the checkout flow, in the dev build
```

**`design`** — the workflow is yours. The agent asks what it does not know,
drafts the plan and stops. Anthill opens it on the canvas, you change what you
want, press **Save** and tell the chat to start. It works from what you saved.

**`watch`** — the workflow is the agent's, and you want to see the work happen.
It writes the graph from your task, hands it over and starts. Anthill opens the
**Live Session**.

On macOS, `--dev` directly after the mode sends the chat to the development
build of an Anthill checkout; without it, the installed app.

## What Anthill sees

VS Code gives a chat no id a tool can read, so the skill makes one for each chat
(`vscode-<uuid>`) and hands it over as the session. Anthill finds the chat
itself by the run's nonce, which appears in the commands the agent runs after
binding. A prompt copied from Anthill and pasted into a chat is found by the
marker it carries.

Where the chat's record is depends on what runs it:

* **The Agents window, and Agent mode since VS Code 1.140**, run on the
  Copilot agent host, which writes
  `~/.copilot/session-state/<id>/events.jsonl` as the work happens.
* **The workbench's own agent** (the Local harness) keeps the chat under
  `workspaceStorage/<hash>/chatSessions/` and saves it about once a minute,
  when its window loses focus, and on exit, so the Live Session can trail the
  chat by that much.

From either, Anthill reads the agent's messages, which tools it ran and
whether they worked, and whether a request finished, was stopped or failed.
Never the model's thinking. A shell command's output is searched for the
run's markers, and a tool's input and output for the run's nonce; nothing else
is taken from them. The steps the agent reports with `anthill step` arrive at
once.

### Detailed progress

Anthill can also install observation hooks for VS Code, from Settings ▸ Live
observation or when it hands a prompt over. It writes one file of its own,
`~/.copilot/hooks/anthill.json`, which VS Code's agent reads by default: every
tool call and turn then reaches Anthill as it happens, instead of when VS Code
next saves the chat. The hook records which event happened, which tool, and
the file or pattern a tool was about, with anything that looks like a secret
taken out; never a tool's output. It always exits without effect.

VS Code runs hooks while `chat.useHooks` is on, which it is by default, and
only in a trusted workspace. The Copilot CLI reads the same folder. Removing
the file, or disabling the hooks in Anthill, turns them off again.

Settings ▸ Plugins shows whether VS Code has the plugin, read from
`chat.pluginLocations` and from `~/.vscode/agent-plugins/installed.json`, and
the line to add to your settings when it does not. Whether a plugin is
switched on VS Code keeps to itself, so an installed plugin is taken as on;
the card turns green only when the installed plugin's server answers.

A chat run by a harness other than these two may keep its record elsewhere;
Anthill then shows the reported steps only.

Every step runs in the chat, on the chat's model. The agents a workflow names
are roles in one prompt, not separate VS Code agents, and Anthill does not pin
a model per agent here.

## Uninstalling

Remove the plugin in VS Code, or take its entry out of `chat.pluginLocations`.
That does not touch `~/.anthill/plugin.json`, the workflows Anthill has stored,
or anything the app keeps.
