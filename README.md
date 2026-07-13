# pi-mcp

Exposes [pi](https://pi.dev) to Claude Code as MCP tools, so work can be delegated
to model families **other than Claude** — GPT-5.5, Gemini 3.1 Pro, Fable 5,
Opus 4.x — billed to a GitHub Copilot subscription.

## Why

Claude Code can only ever ask another Claude. Every subagent it spawns shares the
same training, the same blind spots, the same failure modes — so three of them
agree with each other more than the evidence warrants. For research and
adversarial review, that correlation is the enemy.

**The cost saving is secondary. The point is model diversity.** A GPT-5.5 and a
Gemini 3.1 Pro reviewing Claude's work will surface things Claude structurally
will not.

## Tools

| Tool | What it does |
|---|---|
| `pi_ask({ model, prompt, output_file? })` | Ask a model. Returns the answer inline, or writes it to `output_file` and returns only a preview. |
| `pi_models()` | List the models pi can reach. Call this rather than guessing a model id. |

**Use `output_file` for anything long.** A four-model research fan-out returning
inline costs the caller tens of thousands of tokens of context. Returning a path
costs a few hundred.

**Pass ABSOLUTE paths in the prompt.** The sub-agent does not run in your project
directory — see "The workspace" below.

## What the sub-agent can and cannot do

**CAN:** read any file (by absolute path), search the web, fetch pages.
**CANNOT:** run a shell, write files, edit files.

This is enforced by `--tools read,mcp` and **verified by probe**, not assumed —
see `test/leash.test.ts`, which asks pi to run `bash` and to `write`, and asserts
it reports both unavailable.

That test matters more than it looks: **pi's `--tools` allowlist fails open.**
Unknown tool names are silently ignored, never rejected. So the flag proves
nothing on its own — a typo would grant less than intended and error nowhere. The
only thing that establishes the boundary is asking pi to cross it and watching it
fail.

### Accepted risk

Read-access plus web-reach is, in principle, an exfiltration path — a model can
read a file and then fetch a URL with the contents in the query string. This is
inherent to "let it read the code *and* reach the internet," which is the whole
point. It is **accepted, not mitigated**. Point this at code you would be relaxed
about open-sourcing.

## The workspace — and why pi always runs there

`pi` discovers MCP servers from exactly **one** place: the `.mcp.json` in its
**working directory**. Not its own settings file. Not `~/.mcp.json`. Only the cwd.

And pi has **no built-in web access at all** — no fetch, no search, only an `mcp`
gateway tool. So pi can reach the web *if and only if* its cwd holds a `.mcp.json`
wiring one up.

`pi-workspace/` is a directory whose sole job is to hold that file. `runPi` always
spawns pi there. Run it anywhere else and it **silently** loses the web — silently,
because pi reports no error, it simply has no servers.

The cost: pi's `read` is rooted in the workspace, so **callers must pass absolute
paths**. pi handles them fine. There is deliberately no `cwd` parameter on
`pi_ask`, because setting one is exactly how you would lose the web tools without
being told.

The alternative — putting `fetch`/`search` into each target repo's `.mcp.json` —
was rejected. Claude Code reads those too (it would get redundant tools
duplicating its own `WebSearch`/`WebFetch`), and it would mean committing a search
server into every repo pi is ever pointed at.

## Setup

### 1. Register with Claude Code

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "pi": {
      "command": "bun",
      "args": ["run", "U:/Git/pi-mcp/src/pi-server.ts"]
    }
  }
}
```

### 2. Set a search API key

Web search needs a [Serper.dev](https://serper.dev) key (preferred — cheaper,
faster) or a [SerpAPI](https://serpapi.com) key (fallback; used only when no
Serper key is present). **Keys are never stored in this repo** — they are read
from the environment (or a gitignored `.env` at the repo root) at call time.

```powershell
[Environment]::SetEnvironmentVariable("SERPER_API_KEY", "<your-key>", "User")
# or
[Environment]::SetEnvironmentVariable("SERPAPI_API_KEY", "<your-key>", "User")
```

Restart your terminal so child processes inherit it. Without it, `fetch` still
works; only `search` is unavailable, and it says so plainly rather than failing
mysteriously.

### 3. Requirements

- `pi`, authenticated (`pi --list-models` should print a table)
- `bun`
- `uvx` (for `mcp-server-fetch`, the official keyless URL→markdown server)

## Which config serves which consumer

Crossing these is the easy mistake:

| Config | Consumer | Contains |
|---|---|---|
| `~/.claude/settings.json` | **Claude Code** | the `pi` server |
| `pi-workspace/.mcp.json` | **pi** | `fetch`, `search` |

`fetch` and `search` must **never** go in a project's `.mcp.json` — Claude Code
reads those, and Claude already has `WebSearch` and `WebFetch`.

## Tests

```bash
bun test
```

`test/leash.test.ts` hits the real Copilot API deliberately (~30s). A mock would
prove nothing about a security boundary.

## Sharp edges

### Code changes need a Claude Code restart
Claude Code spawns this MCP server ONCE at session start. Editing anything in
`src/` does nothing to the running session — the tool keeps behaving the old
way with no error and no hint. If a fix "isn't taking", this is why. Restart
Claude Code (or `/mcp` reconnect) after every change to this repo.

### `pi --list-models` output depends on the cwd
From some directories pi lists ~350 models across 5 providers; from others,
17 github-copilot rows. Root cause unknown (BACKLOG #5). `pi_models` filters
to github-copilot regardless, so callers are protected either way — but if
you are debugging model lists by hand, know that your cwd changes the answer.

### Provider is pinned to github-copilot on purpose
pi can reach anthropic, openai, azure-openai-responses, and openrouter. Those
bill to different accounts, so `pi_ask` deliberately cannot select them — it
is a billing decision, not a technical one (BACKLOG #6). Widening model
diversity via openrouter is a conscious decision for a human to make, in
`src/run-pi.ts` (`PROVIDER`).

### If a call wedges: `pi_cleanup`, never `taskkill //IM`
`pi_cleanup` kills only the process trees this server spawned. The blunt
alternative (`taskkill //F //IM python.exe`) also kills every other Python
MCP server you have running — verified the hard way (it took out pal and
serena).
