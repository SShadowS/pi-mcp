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

const PROVIDER = "github-copilot";
const TOOLS = "read,mcp";

/** The directory holding the .mcp.json that gives pi fetch + search. */
export const PI_WORKSPACE = resolve(import.meta.dir, "..", "pi-workspace");

export function buildPiArgs(model: string, prompt: string): string[] {
	return [
		"-p",
		"--no-session",
		"--provider",
		PROVIDER,
		"--model",
		model,
		"--tools",
		TOOLS,
		prompt,
	];
}

export async function runPi(model: string, prompt: string): Promise<PiResult> {
	try {
		const proc = Bun.spawn(["pi", ...buildPiArgs(model, prompt)], {
			// Never process.cwd(). See the note above: the cwd IS the MCP config,
			// and running anywhere else silently strips pi's web access.
			cwd: PI_WORKSPACE,
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

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
