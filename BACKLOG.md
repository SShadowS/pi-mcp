# pi-mcp: Backlog

Deferred work. Everything here was learned by using the tool in anger on real
tasks (first: auditing al-perf's 18 detectors across three model families), not
speculated.

Open items come first, ordered by how much pain they cause. Resolved items are
kept at the bottom as a short record of what was learned.

---

## Open

### 1. Search errors hide their cause

**MEDIUM. Hit on 2026-09-30.**

Serper returned HTTP 400 and the delegate saw only `Serper returned HTTP 400.`
The body said `{"message":"Not enough credits"}`, which took a manual probe to
find. A delegate cannot act on a bare status code, and neither can the human
reading its answer.

- Include Serper's `message` (and SerpAPI's `error`) in the tool result. Never
  echo request headers, since those carry the key.
- Consider falling back to SerpAPI when Serper reports exhausted credits. This
  reverses the current "no cross-provider retry" rule in `search-server.ts`, so
  decide it deliberately; a credit error is not a transient HTTP failure.

### 2. Code changes need a Claude Code restart

**LOW. Documented in README "Sharp edges". Friction, not breakage.**

Claude Code spawns the server once per session. Edits to `src/` do nothing until
a restart or `/mcp` reconnect, and the tool keeps behaving the old way with no
hint. This cost real time twice (the `--no-skills` and `--thinking high` fixes).

Option if it keeps biting: have the server watch its own source and exit on
change, so Claude Code respawns it.

### 3. `pi --list-models` is cwd-dependent, cause unknown

**LOW. Documented in README "Sharp edges".**

From one directory pi lists ~350 rows across 5 providers; from another, 17
github-copilot rows. `pi_models` filters to the active provider, so callers are
protected, but unexplained inconsistencies tend to matter later.

### 4. Pay-per-token providers are unreachable

**LOW. Deliberate. Revisit consciously, not by accident.**

`PI_MCP_PROVIDER` allows `github-copilot` and `openai-codex` (both flat-rate).
pi can also reach `anthropic`, `openai`, `azure-openai-responses` and
`openrouter`, which would add Grok, DeepSeek, Qwen, GLM and Kimi. For model
diversity, the whole reason this tool exists, openrouter would widen the spread
well beyond GPT and Gemini. It is a billing decision, so it stays out of the
tool until someone makes it.

### 5. Delegate-side context budgeting

**DEFERRED. Revisit only if delegates start blowing their context windows.**

PAL (`utils/conversation_memory.py`, `utils/model_context.py`) collects history
newest-first, drops the oldest turns when the budget is tight, dedups files
across turns, and sizes the budget per model. Since continuations moved to pi's
own `--session-id` files, pi does its own context management, so there is no
observed pain yet. `openai-codex` models have a smaller window (272K), which
makes this more likely to matter there first.

### 6. Reuse one pair of MCP servers across calls

**DEFERRED. The leak is fixed; this would be the performance fix.**

Every `pi_ask` still spawns a fresh `fetch` (Python via `uvx`) and `search` (Bun)
server. Reaping (see resolved R1) stops the orphans, but each call still pays the
startup cost. pi's RPC mode (`pi --mode rpc`) would spawn them once per session.
Worth it only if call latency becomes the complaint.

---

## Resolved

Implementation details for R1 to R5 are in
`docs/superpowers/plans/2026-07-13-backlog-hardening.md`.

| # | Problem | Fix | Commit |
|---|---------|-----|--------|
| R1 | Killed calls orphaned MCP children (33 zombie `mcp-server-fetch` processes in one afternoon, a slowdown death spiral) | Kill the whole process tree; `pi_cleanup` tool and exit reaper scoped to our own PIDs | `4d41781`, `08d5202`, `aa8209f` |
| R2 | No runtime bound, and a naive `timeout` caused R1 | Bounded runtime that kills the tree, not just pi | `4d41781` |
| R3 | No multi-turn; RPC mode was assumed necessary | `continuation_id` via pi `--session-id`. The MCP server process is persistent even though MCP is stateless (PAL's insight) | `6cc82d1` |
| R4 | Delegates silently answered from priors (Gemini: 443 confident, wrong words, never opened a file) | `require_evidence` contract: the delegate must declare files read and searches made; zero of both is flagged | `6a250a4` |
| R5 | No guidance on which models do agentic work | `--thinking high` default; `pi_models` annotates measured reliability | `9b57f48`, `dbeba27` |
| R6 | Multiline prompts truncated on Windows | Prompt delivered on stdin, not argv | `63c672a` |
| R7 | Committed `pi-workspace/.mcp.json` held a machine-specific absolute path | Relative `../src/search-server.ts`, resolved against pi's pinned cwd; test forbids absolute paths | `42e41e2` |
| R8 | Two tests failed when `.env` set `PI_MCP_PROVIDER=openai-codex` (Bun auto-loads `.env`; `PROVIDER` resolves at module load) | `buildPiArgs` takes the provider as a parameter; unit test asserts it explicitly; integration test picks a model that exists on the active provider | this change |

### Lessons worth keeping

- **Do not re-introduce a naive `timeout`.** Any runtime bound must kill the
  whole process tree.
- **Never clean up with `taskkill //F //IM python.exe`.** It kills every other
  Python MCP server too (it took out `pal` and `serena`).
- **pi's `--tools` allowlist fails open.** Unknown names are ignored, so only the
  live probe in `test/leash.test.ts` proves the boundary.
- **A prior-derived answer looks exactly like a real one.** Make the failure
  visible in the data, not in a human's judgment.
