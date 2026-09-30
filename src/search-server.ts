#!/usr/bin/env bun
/**
 * A web-search MCP server (Serper.dev preferred, SerpAPI fallback) — consumed by
 * PI, not by Claude Code.
 *
 * It is how pi reaches the web. pi has NO built-in fetch or search tool at all —
 * only an `mcp` tool — so its web access must come from an MCP server. This is
 * that server, registered in pi's own settings (~/.pi/agent/settings.json).
 *
 * It must NOT be added to a project's .mcp.json: Claude Code reads those, and
 * Claude already has WebSearch and WebFetch. Crossing those wires is the easy
 * mistake here.
 *
 * Written rather than installed: npm offers only unvetted third-party packages
 * for both providers, and installing a stranger's code to give an out-of-family
 * model web access is the same supply-chain risk we declined elsewhere. Each
 * provider is one REST call, so a few dozen lines we control beats an audit.
 *
 * THE API KEYS ARE NEVER STORED IN THIS REPO. They are read from the environment
 * at call time. No default, no fallback.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

/**
 * Read a key from `<repo>/.env` if it is not already in the environment.
 *
 * Resolved against this file's own directory, NOT process.cwd(): this server is
 * spawned by pi, whose cwd is pi-workspace/, so a cwd-relative lookup would miss.
 *
 * `.env` is gitignored. Keys must NEVER go in pi-workspace/.mcp.json — that
 * file IS committed, and MCP config supports an `env` block, which is exactly what
 * makes it a trap: it would work perfectly and quietly put a live key in git.
 */
function loadKeyFromDotEnv(name: string): string | undefined {
	const envPath = resolve(import.meta.dir, "..", ".env");
	if (!existsSync(envPath)) return undefined;

	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq).trim() !== name) continue;
		// Strip surrounding quotes if present.
		return trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return undefined;
}

function resolveKey(name: string): string | undefined {
	return process.env[name] ?? loadKeyFromDotEnv(name);
}

export type SearchProvider = { provider: "serper" | "serpapi"; key: string };

/**
 * Every provider with a key, in preference order: Serper (cheaper, faster)
 * first, SerpAPI second. Resolved at call time. runSearch falls through the
 * list on failure — Serper out of credits should not take search down when a
 * working SerpAPI key is sitting right there. Exported for testing.
 */
export function resolveSearchProviders(): SearchProvider[] {
	const out: SearchProvider[] = [];
	const serper = resolveKey("SERPER_API_KEY");
	if (serper) out.push({ provider: "serper", key: serper });
	const serpapi = resolveKey("SERPAPI_API_KEY");
	if (serpapi) out.push({ provider: "serpapi", key: serpapi });
	return out;
}

interface SerpOrganicResult {
	title?: string;
	link?: string;
	snippet?: string;
}

/** Shared result renderer — both providers use {title, link, snippet} rows. */
function formatResults(results: SerpOrganicResult[]): string {
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

/** Exported for testing. Pure — no network. */
export function formatSerpResults(json: {
	organic_results?: SerpOrganicResult[];
}): string {
	return formatResults(json.organic_results ?? []);
}

/** Serper.dev puts results under `organic` instead of `organic_results`. */
export function formatSerperResults(json: {
	organic?: SerpOrganicResult[];
}): string {
	return formatResults(json.organic ?? []);
}

/**
 * Error text for a failed search call. Carries the provider's own message
 * (Serper: `message`, SerpAPI: `error`) because a bare status code tells the
 * delegate nothing: Serper answers "Not enough credits" with a plain 400.
 * The key is redacted in case a provider ever echoes it back.
 * Exported for testing. Pure — no network.
 */
export function httpErrorText(
	provider: "Serper" | "SerpAPI",
	status: number,
	body: string,
	key: string,
): string {
	let detail = body.trim();
	try {
		const json = JSON.parse(detail) as { message?: unknown; error?: unknown };
		const msg = json.message ?? json.error;
		if (typeof msg === "string") detail = msg;
	} catch {
		// Not JSON: keep the raw body.
	}
	detail = detail.split(key).join("[redacted]").slice(0, 300);
	return detail
		? `${provider} returned HTTP ${status}: ${detail}`
		: `${provider} returned HTTP ${status}.`;
}

export type SearchOutcome = { ok: true; text: string } | { ok: false; error: string };

const LABEL = { serper: "Serper", serpapi: "SerpAPI" } as const;

/** One provider, one call. Never throws: network errors become outcomes. */
export async function searchOne(
	p: SearchProvider,
	query: string,
	num?: number,
): Promise<SearchOutcome> {
	try {
		if (p.provider === "serper") {
			// Serper.dev: POST with the key in a header — never in the URL.
			const res = await fetch("https://google.serper.dev/search", {
				method: "POST",
				headers: { "X-API-KEY": p.key, "Content-Type": "application/json" },
				body: JSON.stringify({ q: query, num: num ?? 10 }),
			});
			if (!res.ok) return { ok: false, error: httpErrorText("Serper", res.status, await res.text(), p.key) };
			return { ok: true, text: formatSerperResults((await res.json()) as { organic?: SerpOrganicResult[] }) };
		}
		const url = new URL("https://serpapi.com/search.json");
		url.searchParams.set("engine", "google");
		url.searchParams.set("q", query);
		url.searchParams.set("num", String(num ?? 10));
		url.searchParams.set("api_key", p.key);
		const res = await fetch(url);
		if (!res.ok) return { ok: false, error: httpErrorText("SerpAPI", res.status, await res.text(), p.key) };
		return { ok: true, text: formatSerpResults((await res.json()) as { organic_results?: SerpOrganicResult[] }) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `${LABEL[p.provider]} failed: ${msg.split(p.key).join("[redacted]")}` };
	}
}

/**
 * Try each provider in preference order; first success wins. A fallback is
 * never silent: the result names the provider that failed and why, so the
 * delegate and the human reading its answer can see the switch happened.
 * `doSearch` is injectable so the fallback logic is testable without network.
 */
export async function runSearch(
	providers: SearchProvider[],
	query: string,
	num?: number,
	doSearch: typeof searchOne = searchOne,
): Promise<string> {
	if (providers.length === 0) {
		return "No search API key is set. Put SERPER_API_KEY (preferred) or SERPAPI_API_KEY in the environment, or in a .env file at the pi-mcp repo root (gitignored). Web search is unavailable until then.";
	}
	const errors: string[] = [];
	for (const p of providers) {
		const out = await doSearch(p, query, num);
		if (out.ok) {
			return errors.length === 0
				? out.text
				: `[Fell back to ${LABEL[p.provider]}. ${errors.join(" ")}]\n\n${out.text}`;
		}
		errors.push(out.error);
	}
	return `Search failed on every provider.\n${errors.join("\n")}`;
}

export function createSearchMcpServer(): McpServer {
	const server = new McpServer({ name: "web-search", version: "0.2.0" });

	server.registerTool(
		"search",
		{
			title: "Web search (Google via Serper or SerpAPI)",
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
			const text = await runSearch(resolveSearchProviders(), query, num);
			return { content: [{ type: "text" as const, text }] };
		},
	);

	return server;
}

if (import.meta.main) {
	const server = createSearchMcpServer();
	await server.connect(new StdioServerTransport());
}
