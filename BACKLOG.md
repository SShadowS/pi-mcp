# pi-mcp — Backlog

Deferred work. Everything here was learned by using the tool in anger on a real
task (auditing al-perf's 18 detectors across three model families), not
speculated.

Ordered by how much pain it actually caused.

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
