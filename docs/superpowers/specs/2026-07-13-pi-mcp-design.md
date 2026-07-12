# pi-mcp — Design

**Date:** 2026-07-13
**Status:** Approved, ready for implementation planning

## Why

Claude Code can only ever ask another Claude. Every subagent I spawn shares my
training, my blind spots, and my failure modes — so three of them agree with each
other more than the evidence warrants. For research and review, that correlation
is the enemy.

`pi` (pi.dev) is installed and authenticated against a **GitHub Copilot**
subscription, which exposes Fable 5 (1M context), Opus 4.5–4.8, Sonnet 4.5/4.6,
**GPT-5.5 / 5.4 / 5.3-codex**, and **Gemini 3.1 Pro**. Different model families,
different training, genuinely uncorrelated opinions — and billed to a different
subscription than the one running this session.

`pi-mcp` exposes pi to Claude Code as MCP tools so that delegation is a tool call
rather than a shell incantation.

**The cost saving is secondary. The point is model diversity.**

## Scope

Bare minimum. No daemon, no RPC bridge, no session management.

`pi --mode rpc` exists and offers persistent stateful sessions, and a third-party
wrapper (`Agusx1211/pi-as-mcp`) already does this. Both were deliberately
rejected:

- **Persistent sessions solve a problem we do not have.** The target use is a
  fan-out where each model answers *one* independent question. No follow-ups.
  Statelessness is not a limitation there — independence is precisely what makes
  cross-family disagreement informative.
- **`pi -p` (one-shot, non-interactive) already works**, verified.
- **Parallel tool calls make blocking free.** Claude Code can issue four `pi_ask`
  calls in one message; they run concurrently. The main reason to build session
  machinery evaporates.

Revisit if we hit the actual wall: **re-sending the same large context to pi on
consecutive calls.** That is the signal that persistence has become worth its
complexity. Not before.

## Architecture

A stdio MCP server (TypeScript, Bun, `@modelcontextprotocol/sdk`) that shells out
to `pi -p`. One process per call; it exits when done. That is the entire trick,
and it is why this stays small.

A second, separate tiny MCP server ships in the same repo — a **SerpAPI search
server** — but it is consumed by **pi**, not by Claude Code. See "Web access".

### Tools exposed to Claude Code

**`pi_ask({ model, prompt, output_file?, cwd? })`**

Runs:

```
pi -p --no-session --provider github-copilot --model <model> --tools read,mcp <prompt>
```

- Returns the answer inline by default.
- When `output_file` is given, writes the full answer there and returns only a
  **preview, the path, and a word count**. This is what stops a four-model
  research fan-out from costing 40,000 tokens of the caller's context. It is the
  difference between a usable tool and an unusable one.
- `cwd` sets pi's working directory — pi's file reads are relative to it.

**`pi_models()`**

Passthrough of `pi --list-models`. Exists so the model list is never hardcoded
into a file that goes stale.

## The leash

**Verified by probing the real binary, not inferred from flags:**

| | |
|---|---|
| `--tools read,mcp` | pi may read files and call MCP servers |
| `bash` | **BLOCKED** — probe returned `NO_BASH_TOOL` |
| `write` | **BLOCKED** — probe returned `NO_WRITE_TOOL` |
| `edit` | **BLOCKED** (same allowlist mechanism) |
| `--no-session` | ephemeral; no history written to disk |

A correction worth recording, because it invalidated the first design: **pi's real
built-in tools are `read`, `bash`, `edit`, `write`, `mcp`, `workflow`, and a set
of `subagent_*` tools. There is no `grep`, `glob`, `list`, `fetch`, or `search`.**
An earlier allowlist of `read,grep,glob,list` appeared to work only because `read`
exists; the other three were silently ignored as unknown names. Unknown tool names
in `--tools` fail open (ignored), not closed (error) — so an allowlist typo
silently grants less than intended, never more. Verify with a probe, never by
reading the flag.

## Web access

**pi has no built-in web access at all.** No fetch, no search. Its only route out
is the `mcp` tool, which is why `mcp` is in the allowlist.

Two MCP servers get wired into **pi's own** config (`~/.pi/agent/settings.json`) —
deliberately **not** into any project's `.mcp.json`, which Claude Code also reads
and which must not be polluted with servers meant for pi:

1. **`mcp-server-fetch`** — official, no API key, URL → markdown. Run via
   `uvx mcp-server-fetch` (`uvx` is already installed).
2. **A SerpAPI search server, written here.** npm offers only
   `@pipeworx/mcp-serpapi` — an unvetted third-party package, and installing
   strangers' code to give an out-of-family model web access is precisely the
   supply-chain risk we declined when we passed on `pi-as-mcp`. SerpAPI is one
   REST call (`GET /search.json?q=…&api_key=…` → `organic_results[]`), so ~40 lines
   we fully control is both cheaper and safer than an audit.

**The API key is referenced by env var name (`SERPAPI_API_KEY`) and never
committed.** The user sets it once in their environment. No file in this repo ever
contains the value.

## Security posture

Stated plainly rather than papered over.

**pi CAN:** read any file under `cwd`; call the MCP servers configured in pi's own
settings (fetch, search).

**pi CANNOT:** execute a shell, write, or edit.

**Residual risk:** read-access plus web-reach is, in principle, an exfiltration
path — a model can read a file and then fetch a URL with its contents in the query
string. This is *inherent* to "let it read the code and reach the internet," which
is exactly the capability being asked for and the right trade for research work.
It is not mitigated by this design; it is accepted. Point this at code you would be
relaxed about open-sourcing.

The models are served by GitHub Copilot (Microsoft), so this is not a novel trust
relationship — but it is a different one from Anthropic's, and worth knowing.

## Location

Its own repo: `U:\Git\pi-mcp`. It is a general-purpose tool, not an al-perf
feature — it belongs on every project. Registered globally in
`~/.claude/settings.json`.

## Testing

- `pi_ask` returns text from a real model (integration, hits Copilot).
- `output_file` writes the full answer and returns a preview, not the body — pin
  that the return value is short even when the answer is long. This is the whole
  reason the parameter exists.
- The leash holds: a prompt explicitly asking pi to use `bash` or `write` comes
  back reporting the tool is unavailable. This must be an assertion, not a comment
  — it is the security boundary.
- `pi_models` returns a non-empty list including at least one non-Claude model.
- A missing/failed `pi` binary produces a clear error, not a hang.
