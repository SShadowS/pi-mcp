# pi-mcp

MCP server that lets Claude Code delegate work to non-Claude models (GPT-5.5, Gemini 3.1 Pro, and others) through [pi](https://pi.dev), billed to a flat-rate subscription.

[![Bun](https://img.shields.io/badge/runtime-bun-black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-5.6-blue)](https://typescriptlang.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-purple)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| Metric | Value |
|--------|-------|
| Language | TypeScript on Bun |
| Dependencies | `@modelcontextprotocol/sdk`, `zod` |
| Billing | Subscription only: `github-copilot` (default) or `openai-codex` |
| Sub-agent rights | Read files, search the web, fetch pages. No shell, no writes. |
| Platform | Developed on Windows; paths in examples are Windows-style |

## Why

Claude Code can only ever ask another Claude. Every subagent it spawns shares the
same training, the same blind spots, the same failure modes, so three of them
agree with each other more than the evidence warrants. For research and
adversarial review, that correlation is the enemy.

**The cost saving is secondary. The point is model diversity.** A GPT-5.5 and a
Gemini 3.1 Pro reviewing Claude's work will surface things Claude structurally
will not.

## Features

| Feature | Description |
|---------|-------------|
| **`pi_ask`** | Ask a model a question. Returns the answer inline, or writes it to `output_file` and returns a preview. |
| **`pi_models`** | List models pi can reach on the active provider. `all=true` shows every provider. |
| **`pi_cleanup`** | Kill only the pi process trees this server spawned. Use when a call wedges. |
| **Evidence contract** | By default the delegate must declare which files it read and which searches it ran. Answers with zero of both are flagged as prior-derived. |
| **Continuations** | Each answer ends with `[continuation_id: ...]`. Pass it back to continue the thread with prior turns intact. |
| **Probed leash** | `test/leash.test.ts` asks pi to run `bash` and `write` against the real API and asserts both fail. |
| **Web search** | Bundled search MCP server using Serper.dev (preferred) or SerpAPI. If Serper fails and a SerpAPI key is set, search falls back and says so in the result. |

### `pi_ask` parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `model` | required | Model id, for example `gpt-5.5`, `gemini-3.1-pro-preview`. Call `pi_models` rather than guessing. |
| `prompt` | required | Full prompt. Reference files by **absolute** path. |
| `output_file` | none | Write the full answer here and return only a preview. Use for anything long. |
| `thinking` | `high` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Lower values make models answer from priors instead of using tools. |
| `continuation_id` | none | Continue a previous thread. |
| `require_evidence` | `true` | Append the evidence contract and prefix the answer with a verdict. |

**Use `output_file` for anything long.** A four-model research fan-out returning
inline costs the caller tens of thousands of tokens of context. Returning a path
costs a few hundred.

## Prerequisites

- [`pi`](https://pi.dev), authenticated (`pi --list-models` prints a table)
- [`bun`](https://bun.sh)
- [`uvx`](https://docs.astral.sh/uv/) for `mcp-server-fetch`, the official keyless URL-to-markdown server
- A GitHub Copilot or ChatGPT subscription connected to pi

## Installation

1. Clone and install:

   ```bash
   git clone https://github.com/SShadowS/pi-mcp.git
   cd pi-mcp
   bun install
   ```

2. Register with Claude Code:

   ```bash
   claude mcp add pi -s user -- bun run <path-to>/pi-mcp/src/pi-server.ts
   ```

3. Set a search API key (see Configuration). Restart your terminal so child processes inherit it.

## Usage

From Claude Code, once registered:

```
pi_models()
pi_ask({
  model: "gpt-5.5",
  prompt: "Review U:/Git/myrepo/src/parser.ts for off-by-one errors.",
  output_file: "U:/tmp/gpt-review.md"
})
```

Restart Claude Code (or `/mcp` reconnect) after any change to `src/`. The server is spawned once per session.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_MCP_PROVIDER` | `github-copilot` | Subscription provider: `github-copilot` or `openai-codex`. Pay-per-token providers are refused at startup. |
| `SERPER_API_KEY` | none | [Serper.dev](https://serper.dev) key. Preferred search provider. |
| `SERPAPI_API_KEY` | none | [SerpAPI](https://serpapi.com) key. Used when no Serper key is set, or when Serper fails (for example, out of credits). |

Keys are read from the environment, or from a gitignored `.env` at the repo root (copy `.env.example`). They are never stored in the repo. Without a key, `fetch` still works and `search` reports plainly that it is unavailable.

```powershell
[Environment]::SetEnvironmentVariable("SERPER_API_KEY", "<your-key>", "User")
```

Choose the provider per registration:

```bash
claude mcp add pi -s user -e PI_MCP_PROVIDER=openai-codex -- bun run <path-to>/pi-mcp/src/pi-server.ts
```

Model ids differ per provider, so call `pi_models` after switching. `openai-codex` models have a 272K context, smaller than Copilot's.

### Which config serves which consumer

| Config | Consumer | Contains |
|--------|----------|----------|
| Claude Code MCP settings | **Claude Code** | the `pi` server |
| `pi-workspace/.mcp.json` | **pi** | `fetch`, `search` |

`fetch` and `search` must **never** go in a project's `.mcp.json`. Claude Code
reads those, and Claude already has `WebSearch` and `WebFetch`.

## Architecture

```
Claude Code
  |
  v  (stdio, MCP)
pi-server.ts            pi_ask / pi_models / pi_cleanup
  |
  v  spawn, cwd = pi-workspace/, --tools read,mcp, prompt on stdin
pi (sub-agent, GPT-5.5 / Gemini / ...)
  |-- read              absolute paths only
  |-- mcp -> fetch      uvx mcp-server-fetch
  |-- mcp -> search     search-server.ts (Serper / SerpAPI)
```

### Why pi always runs in `pi-workspace/`

pi discovers MCP servers from exactly **one** place: the `.mcp.json` in its
**working directory**. Not its own settings file, not `~/.mcp.json`. And pi has
**no built-in web access**, only an `mcp` gateway tool. So pi can reach the web
if and only if its cwd holds a `.mcp.json` wiring one up.

`runPi` always spawns pi in `pi-workspace/`. Run it anywhere else and it
**silently** loses the web: pi reports no error, it simply has no servers.
That is why `pi_ask` has no `cwd` parameter, and why callers must pass absolute
paths.

Putting `fetch`/`search` into each target repo's `.mcp.json` was rejected. Claude
Code reads those too, and it would mean committing a search server into every
repo pi is pointed at.

### The leash, and why it is probed

`--tools read,mcp` restricts the sub-agent, but **pi's `--tools` allowlist fails
open**: unknown tool names are silently ignored. A typo would change the
boundary and error nowhere. The only proof is asking pi to cross it and watching
it fail, which is what `test/leash.test.ts` does.

### Accepted risk

Read access plus web reach is, in principle, an exfiltration path: a model can
read a file and then fetch a URL with the contents in the query string. This is
inherent to letting it read the code and reach the internet. It is **accepted,
not mitigated**. Point this at code you would be relaxed about open-sourcing.

## Sharp edges

| Edge | Detail |
|------|--------|
| Code changes need a restart | Claude Code spawns the server once. Edits to `src/` do nothing to a running session, with no error. |
| `pi --list-models` depends on cwd | Some directories list ~350 models, others 17 github-copilot rows. `pi_models` filters to the active provider regardless. |
| Wedged call | Use `pi_cleanup`, never `taskkill //F //IM python.exe`. The blunt version kills every other Python MCP server too. |

## Tests

```bash
bun test
bun run typecheck
```

`test/leash.test.ts` hits the real Copilot API deliberately (~30s). A mock would
prove nothing about a security boundary.

## Key Files

| File | Purpose |
|------|---------|
| `src/pi-server.ts` | MCP server: `pi_ask`, `pi_models`, `pi_cleanup`, evidence contract |
| `src/run-pi.ts` | Spawns pi in the workspace, provider pinning, process-tree tracking |
| `src/search-server.ts` | Search MCP server used by pi (Serper / SerpAPI) |
| `pi-workspace/.mcp.json` | MCP servers pi sees: `fetch`, `search` |
| `test/leash.test.ts` | Live probe that the sub-agent cannot run a shell or write |
| `.env.example` | Template for search API keys |
| `BACKLOG.md` | Open issues and deferred work |

---

**Author**: Torben Leth (SShadowS@SShadowS.dk)
**License**: MIT (see [LICENSE](LICENSE))
