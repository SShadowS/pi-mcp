import { resolve } from "path";

/**
 * The only place that knows pi's CLI shape.
 *
 * Every flag here was verified by probing the real binary, not read off --help:
 *
 *   --provider github-copilot  MANDATORY. Omit it and pi falls back to an
 *                              unauthenticated provider and prints a login
 *                              prompt instead of an answer.
 *   --tools read,mcp           pi's real built-ins are read/bash/edit/write/mcp/
 *                              workflow/subagent_*. There is no grep, glob, list,
 *                              fetch, or search. UNKNOWN NAMES IN --tools FAIL
 *                              OPEN — silently ignored, never rejected — so a
 *                              typo here grants LESS than intended and errors
 *                              nowhere. Never trust this flag; probe it.
 *                              (test/leash.test.ts is that probe.)
 *   --no-session               ephemeral; nothing written to disk.
 *   -p                         non-interactive; process the prompt and exit.
 *
 * WHY pi ALWAYS RUNS FROM pi-workspace/
 * =====================================
 * pi discovers MCP servers from ONE place: the `.mcp.json` in its working
 * directory. Not its own settings file, not ~/.mcp.json — only the cwd. Verified
 * empirically: run pi in al-perf (which has a .mcp.json) and its `mcp` gateway
 * reports al-profiler's 14 tools; run it anywhere else and it reports
 * `MCP: 0/0 servers`.
 *
 * pi also has NO built-in web access at all — no fetch, no search. Its only route
 * out is the `mcp` tool. So pi has web access if and only if its cwd contains a
 * .mcp.json wiring up fetch and search.
 *
 * Hence pi-workspace/: a directory whose sole job is to hold that .mcp.json.
 * Running pi anywhere else silently costs it the web — silently, because pi
 * reports no error, it simply has no servers.
 *
 * The alternative — putting fetch/search in each target repo's .mcp.json — was
 * rejected: Claude Code reads those too (it would get redundant tools duplicating
 * its own WebSearch/WebFetch), and it would mean committing a search server into
 * every repo pi is ever pointed at.
 *
 * The cost: pi's `read` is rooted in the workspace, so THE CALLER MUST PASS
 * ABSOLUTE PATHS in the prompt. pi handles them fine — verified: from the
 * workspace it read U:/Git/al-perf/package.json without complaint. There is
 * deliberately no `cwd` parameter, because setting one is exactly how you would
 * lose the web tools without being told.
 */

export type PiResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * pi can reach several providers and ~350 models. Only flat-rate SUBSCRIPTION
 * providers are allowed: github-copilot (default) and openai-codex (ChatGPT
 * subscription). The pay-per-token ones (anthropic, openai, openrouter, ...)
 * bill per call, and opening them up is a billing decision, not a technical one,
 * so they are refused. The operator picks the subscription per MCP registration
 * with PI_MCP_PROVIDER; it is deliberately not a per-call parameter.
 */
const SUBSCRIPTION_PROVIDERS = ["github-copilot", "openai-codex"] as const;
export type Provider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function resolveProvider(value: string | undefined): Provider {
	if (!value) return "github-copilot";
	if ((SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value)) return value as Provider;
	throw new Error(`PI_MCP_PROVIDER=${value} is not allowed; use one of ${SUBSCRIPTION_PROVIDERS.join(", ")}`);
}

export const PROVIDER = resolveProvider(process.env.PI_MCP_PROVIDER);
const TOOLS = "read,mcp";

/** The directory holding the .mcp.json that gives pi fetch + search. */
export const PI_WORKSPACE = resolve(import.meta.dir, "..", "pi-workspace");

/**
 * Session files for continuations live INSIDE the workspace, not in the user's
 * global ~/.pi tree. Two reasons: they are trivially discoverable/deletable,
 * and pi run from elsewhere will never accidentally resume one of ours.
 */
export const SESSIONS_DIR = resolve(PI_WORKSPACE, ".sessions");

/**
 * pi defaults to `medium` thinking, and that is NOT enough for multi-step agentic
 * work — the model answers from priors instead of using its tools.
 *
 * Measured, not guessed. Given "read these three files and audit them", at medium:
 *   - Gemini 3.1 Pro wrote 443 words from general knowledge, never opening a file.
 *   - Fable 5 claimed it "can't locate the tool" despite being handed absolute paths.
 *   - GPT-5.5 was the only one that did the work (2295 words, real file:line cites).
 * At `high`, Fable read the file, found the exact deciding line, and quoted it.
 *
 * Both models could read files fine when asked to read ONE file. The failure is
 * specifically sustaining a multi-tool loop, and thinking level is the lever.
 *
 * So: default to `high`. A delegate that answers from priors instead of reading
 * the code is worse than useless — it is confidently wrong, and it looks like an
 * answer.
 */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

const DEFAULT_THINKING: ThinkingLevel = "high";

/**
 * THE PROMPT NEVER RIDES IN ARGV. It is delivered on stdin (see runPi).
 *
 * On Windows, `pi` resolves to the npm `pi.cmd` shim, and spawning a .cmd goes
 * through cmd.exe — whose command line TERMINATES AT THE FIRST NEWLINE. A
 * multiline prompt passed as an argv element silently truncates to its first
 * line: the delegate answers "you didn't send the proposal" while looking like
 * it got the prompt. Metachars (`>`, `<`, `&`, `|`) in the prompt are live cmd
 * syntax on that path too (a stray `> file` redirect is how a pwned.txt once
 * appeared in this repo).
 *
 * Probed against the real binary (2026-07-17):
 *   - argv prompt, multiline: delegate received ONLY line 1 (4/4 calls).
 *   - `@file` message args: pi hangs in -p mode, with or without a trailing
 *     message (3/3 probes, exit only by timeout). Dead route.
 *   - stdin: multiline + metachar prompt arrived intact ("STDIN-OK-55" probe,
 *     model quoted line 1's metachars and obeyed line 2).
 */
export function buildPiArgs(
	model: string,
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
		// CONTAMINATION GUARDS. pi loads skills, prompt templates, and CLAUDE.md/
		// AGENTS.md from the user's global config by default — including
		// ~/.claude/skills, the SAME skills the calling Claude has.
		//
		// That defeats the entire purpose of this tool. The point is an INDEPENDENT,
		// UNCORRELATED opinion from another model family. A delegate primed with the
		// caller's own skills is not independent; it is the caller's priors laundered
		// through a different model.
		//
		// Caught in the wild: asked to audit al-perf's detectors by reading three
		// specific source files, Gemini instead answered from an `al-sem-detector`
		// skill it found in ~/.claude/skills — 161 words of hedged speculation
		// ("assuming it lacks a multi-file resolved model") without ever opening the
		// code. GPT-5.5, given the identical prompt, read the files and wrote 2295
		// words of specifics.
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--provider",
		PROVIDER,
		"--model",
		model,
		"--tools",
		TOOLS,
	];
}

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

export async function runPi(
	model: string,
	prompt: string,
	thinking?: ThinkingLevel,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
	sessionId?: string,
): Promise<PiResult> {
	try {
		const proc = Bun.spawn(["pi", ...buildPiArgs(model, thinking, sessionId)], {
			// Never process.cwd(). See the note above: the cwd IS the MCP config,
			// and running anywhere else silently strips pi's web access.
			cwd: PI_WORKSPACE,
			// The prompt travels on stdin, NEVER argv — the .cmd shim's cmd.exe
			// command line truncates at the first newline and interprets metachars
			// (see buildPiArgs's doc). pi -p with no message args reads the prompt
			// from stdin; probed 2026-07-17.
			stdin: Buffer.from(prompt, "utf8"),
			stdout: "pipe",
			stderr: "pipe",
			detached: process.platform !== "win32",
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
		// The common case is pi not being on PATH. Say so, rather than surfacing a
		// raw ENOENT that reads like a bug in this server.
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: `could not run 'pi': ${msg}. Is pi installed and on PATH?`,
		};
	}
}
