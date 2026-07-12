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
 */

export type PiResult = { ok: true; text: string } | { ok: false; error: string };

const PROVIDER = "github-copilot";
const TOOLS = "read,mcp";

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

export async function runPi(
	model: string,
	prompt: string,
	cwd?: string,
): Promise<PiResult> {
	try {
		const proc = Bun.spawn(["pi", ...buildPiArgs(model, prompt)], {
			cwd: cwd ?? process.cwd(),
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
