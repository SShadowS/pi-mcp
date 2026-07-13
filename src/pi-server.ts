#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";
import { type PiResult, PROVIDER, runPi, type ThinkingLevel, killTree, livePiPids } from "./run-pi.js";

const PREVIEW_CHARS = 400;

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

/**
 * Exported for testing. The output_file branch is the reason this tool is usable
 * at all: a four-model research fan-out returning inline would cost the caller
 * tens of thousands of tokens of context. Returning a path costs a few hundred.
 *
 * Keep the summary SHORT. This function is reached for precisely when the answers
 * are big — if it ever starts echoing the body, the tool becomes worse than
 * useless.
 */
export function formatAskResult(res: PiResult, outputFile?: string, continuationId?: string): string {
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

export function createPiMcpServer(): McpServer {
	const server = new McpServer({ name: "pi", version: "0.1.0" });

	server.registerTool(
		"pi_ask",
		{
			title: "Ask a non-Claude model via pi",
			description:
				"Delegate a question to a model from another family (GPT-5.5, Gemini 3.1 Pro, Fable 5, Opus 4.x) through pi, billed to the GitHub Copilot subscription. Use this when an independent, uncorrelated opinion is worth more than another Claude's — research, adversarial review, second opinions. The sub-agent can READ files, SEARCH the web, and FETCH pages; it CANNOT run a shell, write, or edit. IMPORTANT: give it ABSOLUTE paths — it runs from its own workspace, not your project directory. Pass output_file for long answers: it writes the full text to disk and returns only a preview, which keeps a multi-model fan-out from flooding your context. Call pi_models to see what is available rather than guessing a model id. Answers end with [continuation_id: ...]; pass it back as continuation_id to continue that thread with prior turns intact.",
			inputSchema: {
				model: z
					.string()
					.describe(
						"Model id, e.g. gpt-5.5, gemini-3.1-pro-preview, claude-fable-5",
					),
				prompt: z
					.string()
					.describe(
						"The full prompt for the sub-agent. Reference files by ABSOLUTE path (e.g. U:/Git/al-perf/src/core/patterns.ts) — the sub-agent does not run in your project directory.",
					),
				output_file: z
					.string()
					.optional()
					.describe(
						"Write the full answer here and return only a preview. Use this for anything long.",
					),
				thinking: z
					.enum(["off", "minimal", "low", "medium", "high", "xhigh"])
					.optional()
					.describe(
						"Reasoning effort. Defaults to 'high' — anything less and models answer from priors instead of using their tools. Only lower it for trivial one-shot questions.",
					),
				continuation_id: z
					.string()
					.optional()
					.describe(
						"Continue a previous pi_ask thread. Pass the [continuation_id: ...] value from an earlier answer; the delegate sees its prior turns and files. Omit to start fresh.",
					),
				require_evidence: z
					.boolean()
					.optional()
					.describe(
						"Default true. Appends a contract forcing the delegate to declare which files it read and searches it made; the answer is prefixed with a verdict. An answer with 0 files and 0 searches is flagged as prior-derived — the silent failure mode this exists to catch. Set false only for questions where reading nothing is expected.",
					),
			},
		},
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
	);

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

	server.registerTool(
		"pi_models",
		{
			title: "List models pi can reach",
			description:
				"List models available through pi. Defaults to the github-copilot provider — the only one pi_ask can actually use. Pass all=true to see every provider pi knows about (~350 rows), but note pi_ask cannot reach them.",
			inputSchema: {
				all: z
					.boolean()
					.optional()
					.describe(
						"Show every provider, not just github-copilot. Long — ~350 rows.",
					),
			},
		},
		async ({ all }) => {
			try {
				const proc = Bun.spawn(["pi", "--list-models"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					proc.exited,
				]);

				if (exitCode !== 0 || stdout.trim().length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "pi --list-models produced no output. Is pi installed and authenticated?",
							},
						],
					};
				}

				// Default to the provider pi_ask actually uses. The full list is ~350
				// rows across five providers — dumping it costs the caller thousands of
				// tokens for models it cannot reach anyway, which is the exact context
				// flood output_file exists to prevent on the other tool.
				const lines = stdout.trim().split("\n");
				const text = all
					? stdout.trim()
					: lines
							.filter((l, i) => i === 0 || l.startsWith(PROVIDER))
							.join("\n");

				return { content: [{ type: "text" as const, text }] };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text" as const,
							text: `could not run 'pi': ${msg}. Is pi installed and on PATH?`,
						},
					],
				};
			}
		},
	);

	return server;
}

// If Claude Code kills this server mid-call, take our pi trees with us.
// Best-effort: SIGKILL of the server itself cannot be caught, but the common
// paths (session end, restart) go through these.
for (const sig of ["SIGINT", "SIGTERM", "beforeExit"] as const) {
	process.on(sig, () => {
		void cleanupLivePi();
	});
}

// Only start the transport when run directly, so tests can import this module
// without a stdio server grabbing the process.
if (import.meta.main) {
	const server = createPiMcpServer();
	await server.connect(new StdioServerTransport());
}
