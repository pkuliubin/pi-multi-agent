# Pi Multi-Agent

This repository is a multi-agent fork of the Pi agent harness. It keeps the original Pi coding-agent runtime and adds a shared-state sub-agent layer for role-based collaboration.

The current focus is not a new scheduler or agent-to-agent chat system. The core model is:

```text
main agent = coordinator
sub-agent = role worker
shared state = team memory / artifact workspace
```

## What This Adds

- File-based sub-agent definitions from `.pi/agents/*.md` and `~/.pi/agent/agents/*.md`.
- `run_subagent` tool for the main agent to delegate work to role-specific sub-agents.
- Persistent role sessions scoped by `mainSessionId + agentId + definitionIdentity`.
- Shared State artifacts with owner/version/provenance metadata.
- Default Shared State permission shorthand:
  ```yaml
  sharedState:
    writableSpaces: [prd]
  ```
  This means the agent can read/list/grep all shared-state spaces and write/edit only its owned spaces.
- Sub-agent observability through existing tool streaming updates in the TUI.
- Default read-only filesystem tools for sub-agents: `ls`, `read`, `grep`, `find`.
- Explicit per-agent skill inheritance through agent frontmatter.

## Current Product-Team Agents

Sample role definitions live in [`sample_agents`](sample_agents):

- `pm-agent`: product direction, user value, MVP scope, tradeoffs, product critique.
- `research-agent`: users, market/category signals, alternatives, evidence quality, validation path.
- `design-agent`: user journey, information architecture, interaction states, UX quality, visual direction.
- `engineering-agent`: code-grounded feasibility, architecture, complexity, implementation risk, testing.

Install or copy these definitions into:

```text
~/.pi/agent/agents/*.md
```

or project-local:

```text
.pi/agents/*.md
```

## Shared State

By default, shared-state artifacts are stored under the current project:

```text
<cwd>/.pi/multi-agent/shared-state/<mainSessionId>
```

The role-session index is stored at:

```text
<cwd>/.pi/multi-agent/role-sessions.json
```

You can override the shared-state root for smoke tests:

```bash
PI_MULTI_AGENT_SHARED_STATE_ROOT=/tmp/pi-shared-state pi
```

Shared State is for reusable team memory, not one-off chat text. A good sub-agent response usually does both:

```text
1. writes a durable artifact to Shared State
2. returns a short finalText summary to the main agent
```

## Running From Source

Install dependencies:

```bash
npm install --ignore-scripts
```

Run Pi from source:

```bash
./pi-test.sh
```

`pi-test.sh` can be launched from any directory. It runs the repo source code but preserves the shell's current working directory.

A convenient local alias is:

```bash
alias pi='sh /path/to/pi-multi-agent/pi-test.sh'
```

Then:

```bash
cd /path/to/your/project
pi
```

## Multi-Agent Smoke Prompt

```text
Please organize a single-round multi-agent product review.

Product idea:
Build an AI product decision workbench for indie builders and small teams. Users enter a product idea, and the system asks PM, Research, Design, and Engineering perspectives to analyze it and write reusable Shared State artifacts.

Please call suitable sub-agents in parallel:
1. pm-agent: users, problem, value proposition, MVP scope, tradeoffs.
2. research-agent: target users, alternatives, category signals, validation path, risks.
3. design-agent: user journey, information architecture, key screens, observability experience.
4. engineering-agent: feasibility, architecture, data model, complexity, risks, MVP implementation cut.

Each sub-agent should write its result to Shared State. Finally, summarize the decision and list generated files, owners, sessionIds, and message counts.
```

## Packages

| Package | Description |
|---------|-------------|
| [`packages/ai`](packages/ai) | Unified multi-provider LLM API |
| [`packages/agent`](packages/agent) | Agent runtime with tool calling and state management |
| [`packages/coding-agent`](packages/coding-agent) | Interactive coding agent CLI and multi-agent integration |
| [`packages/multi-agent`](packages/multi-agent) | Sub-agent runtime, role sessions, Shared State primitives |
| [`packages/tui`](packages/tui) | Terminal UI library |

## Development

```bash
npm run check        # Lint, format, and type check
./test.sh            # Run non-e2e tests
./pi-test.sh         # Run pi from sources
```

For targeted tests, run specific Vitest files from the package root, for example:

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-run-subagent.test.ts
```

## Upstream

This work is based on the Pi agent harness / pi-mono project. The original Pi packages remain the foundation of the runtime, session manager, provider layer, tool loop, and TUI.

- Pi website: <https://pi.dev>
- Original package scope: `@earendil-works/*`

## License

MIT
