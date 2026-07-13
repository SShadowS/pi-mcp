#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";
import { type PiResult, PROVIDER, runPi, type ThinkingLevel } from "./run-pi.js";

const PREVIEW_CHARS = 400;

/**
 * Exported for testing. The output_file branch is the reason this tool is usable
 * at all: a four-model research fan-out returning inline would cost the caller
 * tens of thousands of tokens of context. Returning a path costs a few hundred.
 *
 * Keep the summary SHORT. This function is reached for precisely when the answers
 * are big — if it ever starts echoing the body, the tool becomes worse than
 * useless.
 */
export function formatAskResult(res: PiResult, outputFile?: string): string {
	if (!res.ok) return `pi failed: ${res.error}`;

	if (!outputFile) return res.text;

	const abs = resolve(outputFile);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, res.text, "utf8");

	const words = res.text.trim().split(/\s+/).length;
	const preview = res.text.slice(0, PREVIEW_CHARS);
	const ellipsis = res.text.length > PREVIEW_CHARS ? "…" : "";
	return `Wrote ${words} words to ${abs}\n\nPreview:\n${preview}${ellipsis}`;
}

export function createPiMcpServer(): McpServer {
	const server = new McpServer({ name: "pi", version: "0.1.0" });

	server.registerTool(
		"pi_ask",
		{
			title: "Ask a non-Claude model via pi",
			description:
				"Delegate a question to a model from another family (GPT-5.5, Gemini 3.1 Pro, Fable 5, Opus 4.x) through pi, billed to the GitHub Copilot subscription. Use this when an independent, uncorrelated opinion is worth more than another Claude's — research, adversarial review, second opinions. The sub-agent can READ files, SEARCH the web, and FETCH pages; it CANNOT run a shell, write, or edit. IMPORTANT: give it ABSOLUTE paths — it runs from its own workspace, not your project directory. Pass output_file for long answers: it writes the full text to disk and returns only a preview, which keeps a multi-model fan-out from flooding your context. Call pi_models to see what is available rather than guessing a model id.",
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
			},
		},
		async ({ model, prompt, output_file, thinking }) => {
			const res = await runPi(model, prompt, thinking);
			return {
				content: [
					{ type: "text" as const, text: formatAskResult(res, output_file) },
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

// Only start the transport when run directly, so tests can import this module
// without a stdio server grabbing the process.
if (import.meta.main) {
	const server = createPiMcpServer();
	await server.connect(new StdioServerTransport());
}
