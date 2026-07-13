#!/usr/bin/env bun
/**
 * A SerpAPI search MCP server — consumed by PI, not by Claude Code.
 *
 * It is how pi reaches the web. pi has NO built-in fetch or search tool at all —
 * only an `mcp` tool — so its web access must come from an MCP server. This is
 * that server, registered in pi's own settings (~/.pi/agent/settings.json).
 *
 * It must NOT be added to a project's .mcp.json: Claude Code reads those, and
 * Claude already has WebSearch and WebFetch. Crossing those wires is the easy
 * mistake here.
 *
 * Written rather than installed: npm offers only an unvetted third-party SerpAPI
 * package, and installing a stranger's code to give an out-of-family model web
 * access is the same supply-chain risk we declined elsewhere. SerpAPI is one REST
 * call, so a few dozen lines we control beats an audit.
 *
 * THE API KEY IS NEVER STORED IN THIS REPO. It is read from the environment at
 * call time. No default, no fallback.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

/**
 * Read the key from `<repo>/.env` if it is not already in the environment.
 *
 * Resolved against this file's own directory, NOT process.cwd(): this server is
 * spawned by pi, whose cwd is pi-workspace/, so a cwd-relative lookup would miss.
 *
 * `.env` is gitignored. The key must NEVER go in pi-workspace/.mcp.json — that
 * file IS committed, and MCP config supports an `env` block, which is exactly what
 * makes it a trap: it would work perfectly and quietly put a live key in git.
 */
function loadKeyFromDotEnv(): string | undefined {
	const envPath = resolve(import.meta.dir, "..", ".env");
	if (!existsSync(envPath)) return undefined;

	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq).trim() !== "SERPAPI_API_KEY") continue;
		// Strip surrounding quotes if present.
		return trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return undefined;
}

/** Environment wins; .env is the fallback. Exported for testing. */
export function resolveApiKey(): string | undefined {
	return process.env.SERPAPI_API_KEY ?? loadKeyFromDotEnv();
}

interface SerpOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
}

/** Exported for testing. Pure — no network. */
export function formatSerpResults(json: {
	organic_results?: SerpOrganicResult[];
}): string {
	const results = json.organic_results ?? [];
	if (results.length === 0) return "No results.";

	return results
		.map((r, i) => {
			const title = r.title ?? "(no title)";
			const link = r.link ?? "(no link)";
			const snippet = r.snippet ?? "";
			return `${i + 1}. ${title}\n   ${link}\n   ${snippet}`;
		})
		.join("\n\n");
}

export function createSearchMcpServer(): McpServer {
	const server = new McpServer({ name: "serpapi-search", version: "0.1.0" });

	server.registerTool(
		"search",
		{
			title: "Web search (SerpAPI / Google)",
			description:
				"Search the web and get back titles, URLs, and snippets. Follow up with a fetch to read a page in full.",
			inputSchema: {
				query: z.string().describe("The search query"),
				num: z
					.number()
					.optional()
					.describe("How many results to return (default 10)"),
			},
		},
		async ({ query, num }) => {
			const key = resolveApiKey();
			if (!key) {
				return {
					content: [
						{
							type: "text" as const,
							text: "SERPAPI_API_KEY is not set. Put it in the environment, or in a .env file at the pi-mcp repo root (gitignored). Web search is unavailable until then.",
						},
					],
				};
			}

			const url = new URL("https://serpapi.com/search.json");
			url.searchParams.set("engine", "google");
			url.searchParams.set("q", query);
			url.searchParams.set("num", String(num ?? 10));
			url.searchParams.set("api_key", key);

			try {
				const res = await fetch(url);
				if (!res.ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `SerpAPI returned HTTP ${res.status}.`,
							},
						],
					};
				}
				const json = (await res.json()) as {
					organic_results?: SerpOrganicResult[];
				};
				return {
					content: [{ type: "text" as const, text: formatSerpResults(json) }],
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Search failed: ${msg}` }],
				};
			}
		},
	);

	return server;
}

if (import.meta.main) {
	const server = createSearchMcpServer();
	await server.connect(new StdioServerTransport());
}
