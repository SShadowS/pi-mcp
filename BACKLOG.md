# pi-mcp — Backlog

Deferred work. Everything here was learned by using the tool in anger on a real
task (auditing al-perf's 18 detectors across three model families), not
speculated.

Ordered by how much pain it actually caused.

---

## 0. Steal these three things from PAL (`U:\Git\mcp\pal-mcp-server`)

PAL (formerly Zen MCP) solves the same problem — "call other LLMs from your CLI" —
and is years ahead. Three of its mechanisms map directly onto pain we already hit.
Read `utils/conversation_memory.py`, `utils/model_context.py`, and
`tools/shared/base_models.py`.

### 0a. `continuation_id` — multi-turn WITHOUT pi's RPC mode

**This is the one I got wrong.**

PAL's insight, stated in its own docstring: *MCP is stateless, but the MCP server
PROCESS is not.* Claude Code spawns the server once and it lives for the whole
session. So PAL keeps conversation threads in the server's own memory, keyed by a
`continuation_id` UUID, and a tool call resumes a thread by passing that id back.

It even supports **cross-tool continuation** — start a thread with `analyze`,
continue it with `codereview`, and the second tool sees the first one's turns and
files.

I concluded we needed pi's RPC mode to get multi-turn. **We do not.** Our own
server is already persistent; I treated it as stateless purely because MCP is.
And pi supports `--session <id>` / `--continue` natively — I disabled it with
`--no-session` without asking whether we wanted it.

That does NOT make RPC pointless (see #1 — RPC still fixes the process leak,
because it spawns the MCP servers once rather than per call). But it means
multi-turn and steering are reachable *today*, cheaply, without it.

### 0b. Newest-first token budgeting with cross-turn file dedup

`utils/conversation_memory.py` + `utils/model_context.py`. Conversation history is
collected **newest-first**, so when the token budget is tight, **older turns are
dropped first**. Files referenced across turns are deduplicated into one list
(newest reference wins). Token budgets are allocated per model based on its actual
context window — conservative for a 200K model, generous for a 1M one.

We have none of this. Our `output_file` preview trick stops the *caller's* context
flooding, which is a different problem — it does nothing about the delegate's.

### 0c. FORCE the delegate to declare what it examined — the fix for silent prior-answering

**This is the most valuable one, and it solves #4 and #7 outright.**

PAL's workflow tools make the model fill in a *required* schema:

```
files_checked:   list of files examined during this step
relevant_files:  FULL absolute paths to real files
findings:        evidence and insights discovered
confidence:      exploring | low | medium | high | almost_certain | certain
```

Because these are required schema fields, **a model cannot quietly answer from
priors** — it has to declare what it looked at. Gemini's answer to our detector
audit would have come back with `files_checked: []`, and the lie would have been
*visible in the data* instead of hidden in plausible prose.

That is strictly better than my proposal in #4 (tool-use telemetry). Telemetry
tells you what the harness observed; a required evidence schema makes the model
commit, on the record, to what it claims to have done — and the two disagree loudly
when it is bluffing.

**Concrete:** give `pi_ask` a `require_evidence` mode that appends a structured-
output contract to the prompt and validates the response has non-empty
`files_checked`. Reject or flag answers that claim conclusions with no evidence.

---

## 1. Process leak: every call spawns two MCP servers, and a killed call orphans them

**HIGH — this is the one that bit hardest.**

Every `pi_ask` spawns a fresh `fetch` (Python, via `uvx`) and `search` (Bun) MCP
server. pi reaps them on a clean exit. It does **not** reap them if pi is killed.

Observed: 33 orphaned `mcp-server-fetch` Python processes accumulated over an
afternoon. Each new pi run then got slower, which caused more timeouts, which
orphaned more processes. A death spiral — and every step of it looked like "pi is
hanging" rather than "you have 33 zombies".

Two aggravating factors:

- **`timeout` is a trap.** Wrapping pi in `timeout N` to bound a slow call is
  exactly what orphans the children. The cure caused the disease.
- **Cleanup is dangerous.** `taskkill //F //IM python.exe` fixes it and also kills
  every *other* Python MCP server the user has running (it took out `pal` and
  `serena`). The safe form walks the process tree from the pi PIDs down.

**Options, roughly in order of appeal:**

- **Reuse one pair of MCP servers across calls.** This is the real fix, and it is
  the argument for pi's RPC mode (`pi --mode rpc`) that the spec rejected: a
  persistent session spawns the MCP servers **once** instead of per call. The spec
  said to revisit "when we hit the wall of re-sending large context." We hit a
  different wall first.
- **Reap on our side.** Track the pi PID, and on failure/kill, walk its children and
  kill them. Bounded, but it is cleanup rather than prevention.
- **Ship a `pi_cleanup` tool** that finds and kills orphaned pi trees safely. A
  band-aid, but a cheap one, and it beats the user discovering this via a hung
  machine.

**Do NOT re-introduce a naive `timeout`.** If a runtime bound is needed, it must
kill the whole process tree, not just pi.

---

## 2. No runtime bound at all

**MEDIUM.**

`pi_ask` blocks until pi returns. A research call takes 5–15 minutes; a wedged one
takes forever. There is currently no way to bound it, because the obvious way
(`timeout`) causes finding #1.

Needs to be solved *together* with #1: a bound that kills the process tree.

---

## 3. The MCP server must be restarted to pick up code changes

**MEDIUM — pure friction, but it wasted real time.**

Claude Code spawns the pi-mcp server once at session start. Editing
`src/run-pi.ts` or `src/pi-server.ts` does nothing until Claude Code restarts.

This bit us twice in one session: the `--no-skills` fix and the `--thinking high`
fix both had to be driven through Bash because the running MCP server still had
the old code, and it is not obvious that this is what is happening — the tool just
keeps behaving the old way.

Options: document it loudly in the README; or have the server watch its own source
and exit on change (Claude Code would respawn it).

---

## 4. Model reliability varies enormously, and the tool says nothing about it

**MEDIUM.**

Measured on an identical multi-step research task (read 3 files, search the web,
synthesize):

| Model | At default (`medium`) thinking |
|---|---|
| **GPT-5.5** | Did the work. 2295 words, real `file:line` cites, fetched MS docs. |
| **Gemini 3.1 Pro** | 443 words from priors. Never opened a file. **Confidently wrong.** |
| **Fable 5** | "I can't locate the al-perf tool" — while holding three absolute paths. |

`--thinking high` fixed Gemini and Fable. That is now the default (committed).

But the tool still offers ~17 models with no guidance, and **the failure mode is
silent**: a delegate that answers from priors produces confident, plausible,
wrong prose that *looks exactly like* a real answer. Gemini's answer contained a
flat factual error about al-perf (claimed it cannot produce exact invocation
counts — the ir-json path does precisely that) and nothing in the output signalled
that it had never read the code.

**Options:**
- Have `pi_models` annotate which models are known-good for agentic work.
- Return tool-use telemetry with the answer ("this model made 0 tool calls") so a
  prior-answer is *detectable* rather than plausible. This is the highest-value
  version — it makes the failure mode visible instead of silent.

---

## 5. `pi_models` is cwd-dependent and I do not know why

**LOW, but it is an unexplained inconsistency and those tend to matter later.**

`pi --list-models` returns ~350 rows (5 providers) when run from one directory and
17 rows (github-copilot only) from another. The filter added in `9c577cb` protects
the caller either way, but the underlying behavior is not understood.

---

## 6. Only `github-copilot` is reachable

**LOW — deliberate, but worth revisiting consciously.**

`PROVIDER` is pinned. pi can also reach `anthropic`, `openai`,
`azure-openai-responses`, and `openrouter` — which means **Grok 4.3, DeepSeek v4
Pro, Qwen 3.7 Max, GLM 5.2, and Kimi** are all available to pi and invisible to
`pi_ask`.

That is a *billing* decision, not a technical one, which is why it is not a
parameter. But for genuine model diversity — the entire reason this tool exists —
openrouter would widen the family spread considerably beyond "GPT or Gemini".

---

## 7. `pi_ask` cannot show its work

**LOW.**

There is no way to see what the delegate did — which files it read, what it
searched, how many tool calls it made. When Gemini returned prose from priors, the
only way to detect it was for a human to notice the answer had no citations.

Related to #4's telemetry idea, and probably the same fix.
