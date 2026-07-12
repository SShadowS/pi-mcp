#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { z } from "zod";
import { type PiResult, runPi } from "./run-pi.js";

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
				"Delegate a question to a model from another family (GPT-5.5, Gemini 3.1 Pro, Fable 5, Opus 4.x) through pi, billed to the GitHub Copilot subscription. Use this when an independent, uncorrelated opinion is worth more than another Claude's — research, adversarial review, second opinions. The sub-agent can READ files and reach the web via its own MCP servers; it CANNOT run a shell, write, or edit. Pass output_file for long answers: it writes the full text to disk and returns only a preview, which keeps a multi-model fan-out from flooding your context. Call pi_models to see what is available rather than guessing a model id.",
			inputSchema: {
				model: z
					.string()
					.describe(
						"Model id, e.g. gpt-5.5, gemini-3.1-pro-preview, claude-fable-5",
					),
				prompt: z.string().describe("The full prompt for the sub-agent"),
				output_file: z
					.string()
					.optional()
					.describe(
						"Write the full answer here and return only a preview. Use this for anything long.",
					),
				cwd: z
					.string()
					.optional()
					.describe(
						"Working directory for the sub-agent's file reads (default: server cwd)",
					),
			},
		},
		async ({ model, prompt, output_file, cwd }) => {
			const res = await runPi(model, prompt, cwd);
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
				"List the models available through pi's configured provider. Call this rather than assuming a model id — the list changes.",
			inputSchema: {},
		},
		async () => {
			try {
				const proc = Bun.spawn(["pi", "--list-models"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					proc.exited,
				]);
				const text =
					exitCode === 0 && stdout.trim().length > 0
						? stdout.trim()
						: "pi --list-models produced no output. Is pi installed and authenticated?";
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
