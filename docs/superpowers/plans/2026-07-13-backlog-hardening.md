# Backlog Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four pain points from BACKLOG.md that bit hardest — the process leak (#1/#2), silent prior-answering (0c/#4/#7), no multi-turn (0a), and undocumented sharp edges (#3/#5/#6).

**Architecture:** All changes live in the two existing source files plus tests. `run-pi.ts` gains a tree-killing timeout and session support; `pi-server.ts` gains the evidence contract, continuation plumbing, a `pi_cleanup` tool, and model annotations. No new dependencies.

**Tech Stack:** Bun, TypeScript, `@modelcontextprotocol/sdk`, `zod`, `bun:test`.

## Global Constraints

- Runtime is Bun; tests run with `bun test`; typecheck with `bun run typecheck` (`tsc --noEmit`).
- pi is ALWAYS spawned with `cwd: PI_WORKSPACE` — the cwd IS the MCP config. Never change this.
- Provider stays pinned to `github-copilot` (billing decision, BACKLOG #6). Not a parameter.
- Tools stay leashed to `read,mcp`. Never add bash/write/edit.
- Contamination guards (`--no-skills --no-prompt-templates --no-context-files`) stay on every invocation.
- Windows is the primary platform (paths like `U:/Git/...`); tree-kill must work there. POSIX is best-effort.
- Never use a naive `timeout`-style kill that only kills pi and orphans its MCP children (BACKLOG #1).

## Out of scope (deferred, with reasons)

- **0b newest-first token budgeting:** once Task 3 lands, pi's own `--session-id` files carry conversation history and pi does its own context management. Revisit only if delegates start blowing their context windows.
- **pi RPC mode:** solves MCP-server reuse per call, but Task 1 removes the orphaning pain and Task 3 delivers multi-turn without it. Revisit when per-call spawn latency itself is the bottleneck.
- **openrouter provider (#6):** billing decision, needs a human, not code.
- **#5 root cause (`pi --list-models` cwd-dependence):** the filter in `pi-server.ts` already protects callers; Task 6 documents the mystery so it isn't re-discovered.

---

### Task 1: Bounded runtime with process-tree kill (BACKLOG #1 + #2)

`runPi` currently blocks forever, and any external kill (Ctrl-C, `timeout`) orphans the two MCP servers pi spawned (`uvx`→python fetch server, bun search server). Fix both at once: an internal timeout that kills pi's WHOLE process tree, plus a live-PID registry so the server can reap on its own exit.

**Files:**
- Modify: `src/run-pi.ts`
- Test: `test/run-pi.test.ts`

**Interfaces:**
- Produces: `killTree(pid: number): Promise<void>` (exported for testing and Task 2),
  `livePiPids: Set<number>` (exported, read by Task 2),
  `runPi(model, prompt, thinking?, timeoutMs?)` — new optional 4th param, default `DEFAULT_TIMEOUT_MS = 20 * 60_000`. On timeout returns `{ ok: false, error: "pi timed out after Ns — killed process tree (pid N)" }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-pi.test.ts`:

```ts
import { DEFAULT_TIMEOUT_MS, killTree, livePiPids, runPi } from "../src/run-pi.js";

describe("timeout kills the whole process tree — never just pi (BACKLOG #1)", () => {
	it("exports a default timeout of 20 minutes", () => {
		// 5–15 min is a normal research call; a wedged one is forever. 20 min
		// bounds the pathological case without clipping the normal one.
		expect(DEFAULT_TIMEOUT_MS).toBe(20 * 60_000);
	});

	it("killTree kills a process AND its children", async () => {
		// Spawn a shell that spawns a long-lived child, mirroring pi spawning
		// its MCP servers. killTree on the parent must take the child too —
		// this is exactly what naive `timeout N pi ...` fails to do.
		const parent = Bun.spawn(
			process.platform === "win32"
				? ["cmd", "/c", "start /b ping -n 600 127.0.0.1 > NUL & ping -n 600 127.0.0.1 > NUL"]
				: ["sh", "-c", "sleep 600 & sleep 600"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await killTree(parent.pid);
		// The parent must be dead within a beat.
		const exited = await Promise.race([
			parent.exited.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
		]);
		expect(exited).toBe(true);
	});

	it("runPi times out, kills the tree, and reports it", async () => {
		// A 1ms budget guarantees a timeout regardless of environment. We do not
		// need a real model — pi will be killed before it does anything.
		const res = await runPi("gpt-5.5", "hi", "off", 1);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("timed out");
	}, 30_000);

	it("tracks live pi PIDs and clears them when the call ends", async () => {
		const before = livePiPids.size;
		await runPi("gpt-5.5", "hi", "off", 1);
		// Whatever was added for this call must be removed again.
		expect(livePiPids.size).toBe(before);
	}, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/run-pi.test.ts`
Expected: FAIL — `killTree`, `livePiPids`, `DEFAULT_TIMEOUT_MS` are not exported.

- [ ] **Step 3: Implement in `src/run-pi.ts`**

Add above `runPi`:

```ts
/**
 * Kill a process AND all its descendants.
 *
 * This exists because of an afternoon spent with 33 orphaned mcp-server-fetch
 * pythons (BACKLOG #1). pi spawns two MCP servers per run (fetch via uvx→python,
 * search via bun) and reaps them only on a clean exit. Kill pi alone — which is
 * what `timeout N pi ...` and a bare proc.kill() both do — and the children
 * live on forever, each one slowing the next run, causing more timeouts,
 * orphaning more children. So: any kill goes through here, and here kills the
 * tree.
 *
 * Windows: `taskkill /T` walks the tree natively. POSIX: pi is spawned in its
 * own process group (see runPi), so a negative-PID signal takes the group.
 */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		const p = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await p.exited;
	} else {
		try {
			process.kill(-pid, "SIGKILL"); // whole process group
		} catch {
			try {
				process.kill(pid, "SIGKILL"); // group gone; try the pid alone
			} catch {
				/* already dead — the desired state */
			}
		}
	}
}

/** PIDs of pi processes currently in flight. Read by pi_cleanup and the exit reaper. */
export const livePiPids = new Set<number>();

/** 20 minutes: a real research call takes 5–15; only a wedged one exceeds this. */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;
```

Replace the body of `runPi` (keep its existing doc comments and the catch block):

```ts
export async function runPi(
	model: string,
	prompt: string,
	thinking?: ThinkingLevel,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PiResult> {
	try {
		const proc = Bun.spawn(["pi", ...buildPiArgs(model, prompt, thinking)], {
			// Never process.cwd(). See the note above: the cwd IS the MCP config,
			// and running anywhere else silently strips pi's web access.
			cwd: PI_WORKSPACE,
			stdout: "pipe",
			stderr: "pipe",
		});
		livePiPids.add(proc.pid);

		let timedOut = false;
		const timer = setTimeout(async () => {
			timedOut = true;
			await killTree(proc.pid);
		}, timeoutMs);

		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (timedOut) {
				return {
					ok: false,
					error: `pi timed out after ${Math.round(timeoutMs / 1000)}s — killed process tree (pid ${proc.pid})`,
				};
			}
			if (exitCode !== 0) {
				return {
					ok: false,
					error: `pi exited ${exitCode}: ${stderr.trim() || stdout.trim() || "(no output)"}`,
				};
			}
			const text = stdout.trim();
			if (text.length === 0) {
				return {
					ok: false,
					error: `pi produced no output. stderr: ${stderr.trim()}`,
				};
			}
			return { ok: true, text };
		} finally {
			clearTimeout(timer);
			livePiPids.delete(proc.pid);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `could not run 'pi': ${msg}. Is pi installed and on PATH?`,
		};
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/run-pi.test.ts && bun run typecheck`
Expected: PASS (the two runPi tests need `pi` on PATH; they do in this repo).

- [ ] **Step 5: Commit**

```bash
git add src/run-pi.ts test/run-pi.test.ts
git commit -m "fix: bound pi runtime and kill the whole process tree on timeout"
```

---

### Task 2: Reap on server exit + `pi_cleanup` tool (BACKLOG #1)

Task 1 prevents orphans from timeouts. This task handles the remaining hole: the MCP server itself being killed mid-call, and a manual escape hatch that is SAFE — never `taskkill //F //IM python.exe` (that killed pal and serena).

**Files:**
- Modify: `src/pi-server.ts`
- Test: `test/pi-server.test.ts`

**Interfaces:**
- Consumes: `killTree`, `livePiPids` from Task 1.
- Produces: exported `cleanupLivePi(): Promise<number>` (returns count killed); a `pi_cleanup` MCP tool with no inputs.

- [ ] **Step 1: Write the failing test**

Append to `test/pi-server.test.ts`:

```ts
import { cleanupLivePi } from "../src/pi-server.js";
import { livePiPids } from "../src/run-pi.js";

describe("pi_cleanup — safe reaping, scoped to PIDs WE spawned", () => {
	it("kills only tracked pi trees and reports the count", async () => {
		// A fake "pi" stand-in: any long-lived process we own.
		const stub = Bun.spawn(
			process.platform === "win32"
				? ["ping", "-n", "600", "127.0.0.1"]
				: ["sleep", "600"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		livePiPids.add(stub.pid);

		const killed = await cleanupLivePi();
		expect(killed).toBeGreaterThanOrEqual(1);
		expect(livePiPids.size).toBe(0);

		const exited = await Promise.race([
			stub.exited.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
		]);
		expect(exited).toBe(true);
	});

	it("is a no-op when nothing is tracked", async () => {
		expect(await cleanupLivePi()).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/pi-server.test.ts`
Expected: FAIL — `cleanupLivePi` is not exported.

- [ ] **Step 3: Implement in `src/pi-server.ts`**

Add imports and the function near the top (after the existing imports):

```ts
import { killTree, livePiPids } from "./run-pi.js";

/**
 * Kill every in-flight pi tree WE spawned. Deliberately scoped to our own
 * registry: the obvious global cleanup (`taskkill //F //IM python.exe`) took
 * out the user's pal and serena MCP servers when tried by hand. We only ever
 * kill trees rooted at PIDs we created.
 */
export async function cleanupLivePi(): Promise<number> {
	const pids = [...livePiPids];
	livePiPids.clear();
	await Promise.all(pids.map((pid) => killTree(pid)));
	return pids.length;
}
```

Register the tool inside `createPiMcpServer()` (after `pi_models`):

```ts
	server.registerTool(
		"pi_cleanup",
		{
			title: "Kill in-flight pi delegate processes",
			description:
				"Kill every pi delegate this server currently has in flight, including their MCP-server children (the fetch/search processes pi spawns per run). Use when a pi_ask seems wedged. Safe: only touches process trees this server created — never other Python or Bun processes on the machine.",
			inputSchema: {},
		},
		async () => {
			const n = await cleanupLivePi();
			return {
				content: [
					{
						type: "text" as const,
						text: n === 0 ? "Nothing in flight — no cleanup needed." : `Killed ${n} pi process tree(s).`,
					},
				],
			};
		},
	);
```

And a best-effort exit reaper next to the `import.meta.main` block:

```ts
// If Claude Code kills this server mid-call, take our pi trees with us.
// Best-effort: SIGKILL of the server itself cannot be caught, but the common
// paths (session end, restart) go through these.
for (const sig of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
	process.on(sig, () => {
		void cleanupLivePi();
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS across all files.

- [ ] **Step 5: Commit**

```bash
git add src/pi-server.ts test/pi-server.test.ts
git commit -m "feat: pi_cleanup tool and exit reaper, scoped to our own PIDs"
```

---

### Task 3: `continuation_id` — multi-turn via pi's own sessions (BACKLOG 0a)

PAL's insight: MCP is stateless but the server PROCESS is not — and pi goes further, persisting sessions to disk via `--session-id <id>` (verified in `pi --help`). So a continuation survives even a server restart. `pi_ask` gains an optional `continuation_id`; every successful answer returns one.

**Design:** when no `continuation_id` is passed, generate a UUID and run pi with `--session-id <uuid> --session-dir <PI_WORKSPACE>/.sessions` instead of `--no-session`. When one IS passed, reuse it — pi loads the prior turns itself. We never manage history; pi does.

**Files:**
- Modify: `src/run-pi.ts` (buildPiArgs signature), `src/pi-server.ts` (tool schema + result footer)
- Test: `test/run-pi.test.ts`, `test/pi-server.test.ts`

**Interfaces:**
- Produces: `buildPiArgs(model, prompt, thinking?, sessionId?)` — 4th optional param. With `sessionId`: emits `--session-id <id> --session-dir <SESSIONS_DIR>` and NOT `--no-session`. Without: unchanged (`--no-session`).
  `SESSIONS_DIR` exported const = `<PI_WORKSPACE>/.sessions`.
  `runPi(model, prompt, thinking?, timeoutMs?, sessionId?)` — 5th optional param, threads through.
  `formatAskResult(res, outputFile?, continuationId?)` — appends `\n\n[continuation_id: <id>]` on success.

- [ ] **Step 1: Write the failing tests**

Append to `test/run-pi.test.ts`:

```ts
import { SESSIONS_DIR } from "../src/run-pi.js";

describe("continuation via pi sessions (BACKLOG 0a)", () => {
	it("without a sessionId stays ephemeral", () => {
		const args = buildPiArgs("gpt-5.5", "hi");
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--session-id");
	});

	it("with a sessionId drops --no-session and pins the session dir", () => {
		// --session-id creates-or-resumes; --session-dir keeps session files
		// inside the workspace instead of the user's global ~/.pi tree, so they
		// are ours to find and ours to delete.
		const args = buildPiArgs("gpt-5.5", "hi", "high", "abc-123");
		expect(args).not.toContain("--no-session");
		expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");
		expect(args[args.indexOf("--session-dir") + 1]).toBe(SESSIONS_DIR);
	});

	it("a session run keeps ALL contamination guards", () => {
		// Multi-turn must not quietly become multi-turn-with-the-caller's-skills.
		const args = buildPiArgs("gpt-5.5", "hi", "high", "abc-123");
		for (const g of ["--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			expect(args).toContain(g);
		}
	});
});
```

Append to `test/pi-server.test.ts`:

```ts
describe("formatAskResult carries the continuation_id", () => {
	it("appends the id on success so the caller can continue the thread", () => {
		const out = formatAskResult({ ok: true, text: "answer" }, undefined, "abc-123");
		expect(out).toContain("answer");
		expect(out).toContain("[continuation_id: abc-123]");
	});

	it("omits it on failure — a dead call is not a thread", () => {
		const out = formatAskResult({ ok: false, error: "boom" }, undefined, "abc-123");
		expect(out).not.toContain("continuation_id");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test`
Expected: FAIL — `SESSIONS_DIR` not exported, `buildPiArgs` ignores the 4th arg, `formatAskResult` ignores the 3rd.

- [ ] **Step 3: Implement**

In `src/run-pi.ts`, add next to `PI_WORKSPACE`:

```ts
/**
 * Session files for continuations live INSIDE the workspace, not in the user's
 * global ~/.pi tree. Two reasons: they are trivially discoverable/deletable,
 * and pi run from elsewhere will never accidentally resume one of ours.
 */
export const SESSIONS_DIR = resolve(PI_WORKSPACE, ".sessions");
```

Change `buildPiArgs`:

```ts
export function buildPiArgs(
	model: string,
	prompt: string,
	thinking: ThinkingLevel = DEFAULT_THINKING,
	sessionId?: string,
): string[] {
	// MCP is stateless; this server — and pi's session files — are not. A
	// sessionId turns the call into a resumable thread: pi persists the turns
	// itself and reloads them on the next call with the same id. Without one we
	// stay ephemeral, exactly as before.
	const sessionArgs = sessionId
		? ["--session-id", sessionId, "--session-dir", SESSIONS_DIR]
		: ["--no-session"];
	return [
		"-p",
		...sessionArgs,
		"--thinking",
		thinking,
		// CONTAMINATION GUARDS. (keep the existing comment block here verbatim)
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--provider",
		PROVIDER,
		"--model",
		model,
		"--tools",
		TOOLS,
		prompt,
	];
}
```

Change `runPi`'s signature and spawn line:

```ts
export async function runPi(
	model: string,
	prompt: string,
	thinking?: ThinkingLevel,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	sessionId?: string,
): Promise<PiResult> {
```

```ts
		const proc = Bun.spawn(["pi", ...buildPiArgs(model, prompt, thinking, sessionId)], {
```

In `src/pi-server.ts`, change `formatAskResult`:

```ts
export function formatAskResult(
	res: PiResult,
	outputFile?: string,
	continuationId?: string,
): string {
	if (!res.ok) return `pi failed: ${res.error}`;

	const footer = continuationId ? `\n\n[continuation_id: ${continuationId}]` : "";

	if (!outputFile) return res.text + footer;

	const abs = resolve(outputFile);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, res.text, "utf8");

	const words = res.text.trim().split(/\s+/).length;
	const preview = res.text.slice(0, PREVIEW_CHARS);
	const ellipsis = res.text.length > PREVIEW_CHARS ? "…" : "";
	return `Wrote ${words} words to ${abs}\n\nPreview:\n${preview}${ellipsis}${footer}`;
}
```

In the `pi_ask` schema add:

```ts
				continuation_id: z
					.string()
					.optional()
					.describe(
						"Continue a previous pi_ask thread. Pass the [continuation_id: ...] value from an earlier answer; the delegate sees its prior turns and files. Omit to start fresh.",
					),
```

And change the handler:

```ts
		async ({ model, prompt, output_file, thinking, continuation_id }) => {
			// Every call gets a session id — new threads mint one — so EVERY answer
			// is continuable. The cost is a small session file in .sessions/, which
			// is why SESSIONS_DIR is ours to sweep.
			const sessionId = continuation_id ?? crypto.randomUUID();
			const res = await runPi(model, prompt, thinking, undefined, sessionId);
			return {
				content: [
					{
						type: "text" as const,
						text: formatAskResult(res, output_file, sessionId),
					},
				],
			};
		},
```

Also update the `pi_ask` description string: append the sentence
`"Answers end with [continuation_id: ...]; pass it back as continuation_id to continue that thread with prior turns intact."`

Finally add `.sessions/` to the workspace gitignore:

```bash
echo ".sessions/" >> pi-workspace/.gitignore
```

(create `pi-workspace/.gitignore` if it does not exist).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke test (one real call)**

```bash
cd U:/Git/pi-mcp/pi-workspace
pi -p --session-id smoke-test-1 --session-dir U:/Git/pi-mcp/pi-workspace/.sessions --thinking off --no-skills --no-prompt-templates --no-context-files --provider github-copilot --model gpt-5.5 --tools read,mcp "Remember the word 'xylophone'. Reply OK."
pi -p --session-id smoke-test-1 --session-dir U:/Git/pi-mcp/pi-workspace/.sessions --thinking off --no-skills --no-prompt-templates --no-context-files --provider github-copilot --model gpt-5.5 --tools read,mcp "What word did I ask you to remember?"
```

Expected: second call answers "xylophone". If pi rejects `--session-id` semantics (e.g. requires exact UUID format), adjust to generate UUIDs only and note it in the code comment.

- [ ] **Step 6: Commit**

```bash
git add src/run-pi.ts src/pi-server.ts test/run-pi.test.ts test/pi-server.test.ts pi-workspace/.gitignore
git commit -m "feat: multi-turn continuations via pi --session-id (BACKLOG 0a)"
```

---

### Task 4: `require_evidence` — force the delegate to declare what it examined (BACKLOG 0c, solves #4 and #7)

The worst observed failure is SILENT: Gemini returned 443 confident words without opening a file, and nothing in the output showed it. Fix per PAL: make evidence a required part of the answer, then validate it. A prior-answer comes back with `files_checked: []` and gets flagged loudly instead of read credulously.

**Files:**
- Modify: `src/pi-server.ts`
- Test: `test/pi-server.test.ts`

**Interfaces:**
- Produces (all exported from `src/pi-server.ts`):
  `EVIDENCE_CONTRACT: string` — the prompt suffix.
  `type Evidence = { files_checked: string[]; searches_performed: string[]; confidence: "exploring" | "low" | "medium" | "high" | "almost_certain" | "certain" }`
  `extractEvidence(text: string): { evidence: Evidence | null; body: string }` — parses the trailing fenced `json evidence` block, returns the answer body without it.
  `evidenceVerdict(e: Evidence | null): string` — one-line verdict.

- [ ] **Step 1: Write the failing tests**

Append to `test/pi-server.test.ts`:

```ts
import {
	EVIDENCE_CONTRACT,
	evidenceVerdict,
	extractEvidence,
} from "../src/pi-server.js";

describe("require_evidence — the fix for silent prior-answering (BACKLOG 0c)", () => {
	const answer = [
		"The detector works by scanning IR nodes.",
		"",
		"```json evidence",
		JSON.stringify({
			files_checked: ["U:/Git/al-perf/src/core/patterns.ts"],
			searches_performed: ["al-perf ir-json"],
			confidence: "high",
		}),
		"```",
	].join("\n");

	it("extracts the evidence block and strips it from the body", () => {
		const { evidence, body } = extractEvidence(answer);
		expect(evidence?.files_checked).toEqual(["U:/Git/al-perf/src/core/patterns.ts"]);
		expect(evidence?.confidence).toBe("high");
		expect(body).toContain("scanning IR nodes");
		expect(body).not.toContain("json evidence");
	});

	it("returns null evidence when the model ignored the contract", () => {
		const { evidence, body } = extractEvidence("Just prose, no block.");
		expect(evidence).toBeNull();
		expect(body).toBe("Just prose, no block.");
	});

	it("flags an answer with zero files and zero searches as prior-derived", () => {
		// This is Gemini's failure mode made visible in the data: confident
		// conclusions, nothing examined.
		const verdict = evidenceVerdict({
			files_checked: [],
			searches_performed: [],
			confidence: "high",
		});
		expect(verdict).toContain("⚠");
		expect(verdict.toLowerCase()).toContain("prior");
	});

	it("flags a missing evidence block even harder", () => {
		expect(evidenceVerdict(null)).toContain("⚠");
	});

	it("passes a well-evidenced answer quietly", () => {
		const verdict = evidenceVerdict({
			files_checked: ["U:/Git/al-perf/src/core/patterns.ts"],
			searches_performed: [],
			confidence: "high",
		});
		expect(verdict).not.toContain("⚠");
		expect(verdict).toContain("1 file");
	});

	it("the contract demands the exact fields extractEvidence parses", () => {
		for (const field of ["files_checked", "searches_performed", "confidence"]) {
			expect(EVIDENCE_CONTRACT).toContain(field);
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/pi-server.test.ts`
Expected: FAIL — none of the three symbols exist.

- [ ] **Step 3: Implement in `src/pi-server.ts`**

Add after `formatAskResult`:

```ts
/**
 * PAL's trick (BACKLOG 0c): a model cannot quietly answer from priors if it
 * must declare, in a required structure, what it examined. Gemini's 443-word
 * prior-answer would have arrived with files_checked: [] — the lie visible in
 * the data instead of hidden in plausible prose.
 */
export const EVIDENCE_CONTRACT = `

---
MANDATORY: End your answer with a fenced code block tagged \`json evidence\` containing exactly:
{
  "files_checked": [/* FULL absolute paths of every file you actually read */],
  "searches_performed": [/* every web search / fetch you actually made */],
  "confidence": "exploring" | "low" | "medium" | "high" | "almost_certain" | "certain"
}
Only list files you truly opened with your read tool. An empty list is an acceptable answer; a fabricated one is not.`;

export type Evidence = {
	files_checked: string[];
	searches_performed: string[];
	confidence: "exploring" | "low" | "medium" | "high" | "almost_certain" | "certain";
};

const EVIDENCE_RE = /```json evidence\s*\n([\s\S]*?)\n```\s*$/;

export function extractEvidence(text: string): {
	evidence: Evidence | null;
	body: string;
} {
	const m = text.match(EVIDENCE_RE);
	if (!m) return { evidence: null, body: text };
	try {
		const parsed = JSON.parse(m[1]);
		if (!Array.isArray(parsed.files_checked)) return { evidence: null, body: text };
		return {
			evidence: {
				files_checked: parsed.files_checked,
				searches_performed: Array.isArray(parsed.searches_performed)
					? parsed.searches_performed
					: [],
				confidence: parsed.confidence ?? "exploring",
			},
			body: text.slice(0, m.index).trimEnd(),
		};
	} catch {
		return { evidence: null, body: text };
	}
}

/** One line, loud when it matters, quiet when it doesn't. */
export function evidenceVerdict(e: Evidence | null): string {
	if (!e)
		return "⚠ NO EVIDENCE BLOCK: the delegate ignored the evidence contract. Treat the answer as unverified.";
	if (e.files_checked.length === 0 && e.searches_performed.length === 0)
		return `⚠ PRIOR-DERIVED ANSWER: 0 files read, 0 searches — the delegate examined nothing, yet reports confidence '${e.confidence}'. Its conclusions come from training priors, not your code.`;
	const files = `${e.files_checked.length} file(s) read`;
	const searches = e.searches_performed.length
		? `, ${e.searches_performed.length} search(es)`
		: "";
	return `Evidence: ${files}${searches}, confidence ${e.confidence}.\n${e.files_checked.map((f) => `  - ${f}`).join("\n")}`;
}
```

Add to the `pi_ask` schema:

```ts
				require_evidence: z
					.boolean()
					.optional()
					.describe(
						"Default true. Appends a contract forcing the delegate to declare which files it read and searches it made; the answer is prefixed with a verdict. An answer with 0 files and 0 searches is flagged as prior-derived — the silent failure mode this exists to catch. Set false only for questions where reading nothing is expected.",
					),
```

Change the `pi_ask` handler (merging with Task 3's version):

```ts
		async ({ model, prompt, output_file, thinking, continuation_id, require_evidence }) => {
			const sessionId = continuation_id ?? crypto.randomUUID();
			const wantEvidence = require_evidence !== false;
			const fullPrompt = wantEvidence ? prompt + EVIDENCE_CONTRACT : prompt;
			const res = await runPi(model, fullPrompt, thinking, undefined, sessionId);

			if (!res.ok || !wantEvidence) {
				return {
					content: [
						{ type: "text" as const, text: formatAskResult(res, output_file, sessionId) },
					],
				};
			}

			const { evidence, body } = extractEvidence(res.text);
			const verdict = evidenceVerdict(evidence);
			const formatted = formatAskResult({ ok: true, text: body }, output_file, sessionId);
			return {
				content: [{ type: "text" as const, text: `${verdict}\n\n${formatted}` }],
			};
		},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pi-server.ts test/pi-server.test.ts
git commit -m "feat: require_evidence contract makes prior-answering visible (BACKLOG 0c)"
```

---

### Task 5: Annotate known-good models in `pi_models` (BACKLOG #4, remaining half)

Task 4 makes bluffing detectable per-call; this makes it avoidable up front. Measured reliability goes into the tool output itself.

**Files:**
- Modify: `src/pi-server.ts`
- Test: `test/pi-server.test.ts`

**Interfaces:**
- Produces: exported `MODEL_NOTES: Record<string, string>` and `annotateModels(listing: string): string` (appends ` ← note` to matching rows).

- [ ] **Step 1: Write the failing test**

Append to `test/pi-server.test.ts`:

```ts
import { annotateModels, MODEL_NOTES } from "../src/pi-server.js";

describe("pi_models reliability annotations (BACKLOG #4)", () => {
	it("annotates rows for models we have measured", () => {
		const listing = [
			"provider          model",
			"github-copilot    gpt-5.5",
			"github-copilot    gemini-3.1-pro-preview",
			"github-copilot    some-untested-model",
		].join("\n");
		const out = annotateModels(listing);
		expect(out).toContain("gpt-5.5    ←");
		expect(out).toContain("gemini-3.1-pro-preview    ←");
		// Untested rows pass through untouched — no invented ratings.
		expect(out).toContain("github-copilot    some-untested-model");
		expect(out.split("\n")[3]).not.toContain("←");
	});

	it("notes exist for the three models we actually measured", () => {
		expect(MODEL_NOTES["gpt-5.5"]).toBeTruthy();
		expect(MODEL_NOTES["gemini-3.1-pro-preview"]).toBeTruthy();
		expect(MODEL_NOTES["claude-fable-5"]).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/pi-server.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Implement in `src/pi-server.ts`**

```ts
/**
 * Measured on an identical multi-step research task (read 3 files, search the
 * web, synthesize) — BACKLOG #4. Only models we have actually measured get a
 * note; inventing ratings would recreate the problem this solves.
 */
export const MODEL_NOTES: Record<string, string> = {
	"gpt-5.5":
		"RELIABLE for agentic work: did the full task at default thinking (2295 words, real file:line cites).",
	"gemini-3.1-pro-preview":
		"needs thinking=high (the default): at medium it answered from priors without opening a file, confidently wrong.",
	"claude-fable-5":
		"needs thinking=high (the default): at medium it claimed it could not find files it was handed absolute paths to.",
};

export function annotateModels(listing: string): string {
	return listing
		.split("\n")
		.map((line) => {
			for (const [model, note] of Object.entries(MODEL_NOTES)) {
				// Match the model as a whole token so gpt-5.5 doesn't hit gpt-5.5-mini.
				if (new RegExp(`(^|\\s)${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(line)) {
					return `${line}    ← ${note}`;
				}
			}
			return line;
		})
		.join("\n");
}
```

In the `pi_models` handler, wrap the final text:

```ts
				return { content: [{ type: "text" as const, text: annotateModels(text) }] };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pi-server.ts test/pi-server.test.ts
git commit -m "feat: annotate measured model reliability in pi_models output"
```

---

### Task 6: Document the sharp edges (BACKLOG #3, #5, #6)

No code — these are the traps that wasted real time and will again unless written down where they will be seen.

**Files:**
- Modify: `README.md`
- Modify: `BACKLOG.md`

- [ ] **Step 1: Add a "Sharp edges" section to `README.md`**

Append (adjusting heading level to match the existing README):

```markdown
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
```

- [ ] **Step 2: Update `BACKLOG.md` to reflect what shipped**

For each of items 0a, 0c, 1, 2, 4, 7: prepend `**RESOLVED — see docs/superpowers/plans/2026-07-13-backlog-hardening.md**` to the item's first paragraph (keep the text as historical record). For 3, 5, 6: prepend `**DOCUMENTED in README "Sharp edges".**` Item 0b: prepend `**DEFERRED: pi's own --session-id files carry history since Task 3; revisit if delegates blow their context windows.**`

- [ ] **Step 3: Full verification**

Run: `bun test && bun run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add README.md BACKLOG.md
git commit -m "docs: sharp edges (restart-to-reload, cwd-dependent model list, provider pinning)"
```

---

## Self-review notes

- **Coverage:** 0a→Task 3, 0b→deferred (stated), 0c→Task 4, #1→Tasks 1+2, #2→Task 1, #3→Task 6, #4→Tasks 4+5, #5→Task 6, #6→Task 6, #7→Task 4. RPC mode explicitly deferred.
- **Type consistency:** `runPi(model, prompt, thinking?, timeoutMs?, sessionId?)` — Task 3's handler passes `undefined` for `timeoutMs` to hit Task 1's default; Task 4 reuses that call shape.
- **Ordering:** Tasks 1→2 (killTree dependency), 3→4 (handler is rewritten cumulatively; Task 4's handler code is the merged final form). Tasks 5 and 6 are independent of 3/4.
- **Risk:** Task 3 Step 5's smoke test is the only step touching a real model; if `--session-id` semantics differ from the help text, the fallback is noted inline.
