# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Prerequisites

- Node `>=22.19.0`
- Package manager: npm workspaces
- Prefer installs without lifecycle scripts: `npm install --ignore-scripts`
- For a clean CI-style reinstall: `npm ci --ignore-scripts`

## Common commands

### Repo-wide

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
./pi-test.sh
```

- `npm run build` builds workspace packages in dependency order: `packages/tui` → `packages/ai` → `packages/agent` → `packages/coding-agent`.
- `npm run check` is the main validation pass. It runs Biome with `--write`, pinned dependency checks, TypeScript import checks, coding-agent shrinkwrap verification, `tsgo --noEmit`, and browser smoke checks. It does **not** run tests.
- `./test.sh` is the safe root test command. It strips provider credentials and local-LLM env before running workspace tests, which avoids accidentally enabling provider/e2e paths.
- `./pi-test.sh [args...]` runs the coding agent directly from source and can be launched from any directory.

### Package-level builds

```bash
npm --prefix packages/tui run build
npm --prefix packages/ai run build
npm --prefix packages/agent run build
npm --prefix packages/coding-agent run build
```

### Running a single test

For `packages/agent`, `packages/ai`, and `packages/coding-agent` (Vitest), run from the package root:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/path/to/file.test.ts
```

Useful package-specific commands:

```bash
npm --prefix packages/agent run test:harness
npm --prefix packages/coding-agent run test
npm --prefix packages/ai run test
```

For `packages/tui` (Node test runner), run from `packages/tui`:

```bash
node --test test/file.test.ts
```

### Interactive/manual smoke testing

Use the source runner for CLI/TUI smoke tests:

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux kill-session -t pi-test
```

## Architecture overview

This monorepo is split into four layers:

- `packages/coding-agent`: the actual `pi` application
- `packages/agent`: reusable agent loop and state machine
- `packages/ai`: provider/model abstraction and streaming layer
- `packages/tui`: reusable terminal UI primitives

### End-to-end flow

The main runtime path is:

`packages/coding-agent/src/cli.ts` → `packages/coding-agent/src/main.ts` → session/runtime construction → `AgentSession` → interactive / print / rpc mode → `@earendil-works/pi-agent-core` loop → `@earendil-works/pi-ai` provider stream

That split matters when debugging:

- CLI/session bugs usually start in `packages/coding-agent`
- turn execution and tool-loop bugs usually start in `packages/agent`
- provider/model/auth bugs usually start in `packages/ai`
- rendering/input/keybinding bugs usually start in `packages/tui` or `packages/coding-agent/src/modes/interactive`

### `packages/coding-agent`

This is the application layer.

- `src/cli.ts` is the `pi` entrypoint.
- `src/main.ts` is the bootstrap file. It parses args, runs migrations, resolves cwd/session/model state, creates services with `createAgentSessionServices(...)`, creates the live session with `createAgentSessionFromServices(...)`, wraps it with `createAgentSessionRuntime(...)`, and dispatches into interactive, print/json, or RPC mode.
- `src/core/agent-session.ts` is the central runtime abstraction shared by all modes. It owns tool exposure/execution, session persistence hooks, model/thinking-level state, compaction, branching, slash-command integration, and bash execution.
- `src/core/agent-session-services.ts` builds cwd-bound infrastructure such as settings, auth storage, model registry, and resource loading.
- `src/core/agent-session-runtime.ts` manages replacing/rebinding the active session runtime when sessions are resumed or switched.
- `src/core/session-manager.ts` is the JSONL-backed session store for create/open/fork/resume/tree operations.
- `src/core/model-registry.ts` and `src/core/model-resolver.ts` are the app-level model layer: built-in/custom provider registration, auth/header resolution, overrides, extension-provided providers, and CLI model selection.
- `src/modes/interactive/interactive-mode.ts` is the app-specific TUI shell. Chat UI, selectors, login/model/session dialogs, and keybinding wiring live here.
- `src/core/resource-loader.ts` is the entry point for loading prompts, skills, themes, and other repo/user resources.
- `examples/extensions/` contains reference implementations for extension SDK usage and custom providers.

### `packages/agent`

This package is the reusable execution engine. It does not know about CLI sessions or the TUI.

- `src/agent.ts` owns the current transcript/state, message queues, stream function, tool hooks, and event listeners.
- `src/agent-loop.ts` runs turns, streaming, tool calls, retries, and follow-up processing.

If behavior is wrong after a tool call or during streaming/turn progression, this is usually the first package to inspect.

### `packages/ai`

This package centralizes model/provider abstractions.

- `src/index.ts` is the public surface for models, providers, streaming helpers, OAuth helpers, and shared types.
- `src/models.ts` contains model metadata/helpers such as provider/model discovery and thinking-level support.
- `src/providers/register-builtins.ts` is the built-in provider registration entry point.
- `src/stream.ts` is where unified streaming behavior is implemented.

If a failure is about provider capabilities, auth headers, request shaping, or thinking-level compatibility, start here and then check `packages/coding-agent/src/core/model-registry.ts`.

### `packages/tui`

This is a reusable terminal UI toolkit, not the app itself.

- `src/index.ts` re-exports TUI primitives, editor/input/markdown/select components, keybindings, terminal helpers, and image rendering helpers.
- Application behavior is layered on top in `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

If you are changing chat layout or app-specific interaction, edit `coding-agent`. If you are changing reusable rendering/input primitives, edit `tui`.

## Repo-specific rules worth knowing

These come from the repository's existing guidance and are easy to miss if you only inspect code.

- Read files in full before broad or cross-cutting edits; grep snippets are not enough for this repo.
- Use top-level imports only. Do not add dynamic/inline imports such as `await import(...)` or inline type imports.
- Code checked by the root TypeScript config must stay compatible with Node's strip-only TypeScript support: no `enum`, `namespace`, parameter properties, `import =`, or `export =`.
- Do not edit `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.
- If you change keyboard behavior, update the default keybinding tables instead of hardcoding key checks.
- Treat dependency and lockfile changes as reviewed changes. `package-lock.json` is authoritative, and `packages/coding-agent/npm-shrinkwrap.json` is generated from it.
- If a dependency change requires lockfile updates, use `npm install --package-lock-only --ignore-scripts` unless you intentionally need a full install.
- `packages/coding-agent/test/suite/` should use the harness/faux provider setup, not real provider credentials.
- Multiple agent sessions may work in this checkout at the same time. Stage explicit paths only; do not use destructive git shortcuts like `git add .`, `git add -A`, `git stash`, `git clean -fd`, `git reset --hard`, or `git checkout .`.
- Before preparing upstream issue/PR content, read `CONTRIBUTING.md`; the project has an explicit contributor gate and a strict quality bar.

## Good starting files when orienting

- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-services.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`
- `packages/ai/src/index.ts`
- `packages/ai/src/models.ts`
- `packages/tui/src/index.ts`
