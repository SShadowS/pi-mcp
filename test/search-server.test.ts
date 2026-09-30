import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
	formatSerperResults,
	formatSerpResults,
	httpErrorText,
	resolveSearchProviders,
	runSearch,
} from "../src/search-server.js";

describe("httpErrorText — a status code alone tells the delegate nothing", () => {
	it("carries Serper's message", () => {
		expect(httpErrorText("Serper", 400, '{"message":"Not enough credits","statusCode":400}', "k-123")).toBe(
			"Serper returned HTTP 400: Not enough credits",
		);
	});
	it("carries SerpAPI's error", () => {
		expect(httpErrorText("SerpAPI", 401, '{"error":"Invalid API key."}', "k-123")).toBe(
			"SerpAPI returned HTTP 401: Invalid API key.",
		);
	});
	it("falls back to the raw body when it is not JSON", () => {
		expect(httpErrorText("Serper", 502, "Bad Gateway", "k-123")).toBe("Serper returned HTTP 502: Bad Gateway");
	});
	it("says only the status when the body is empty", () => {
		expect(httpErrorText("Serper", 500, "", "k-123")).toBe("Serper returned HTTP 500.");
	});
	it("redacts the key if a provider echoes it", () => {
		const out = httpErrorText("SerpAPI", 401, '{"error":"Invalid key k-123"}', "k-123");
		expect(out).not.toContain("k-123");
		expect(out).toContain("[redacted]");
	});
});

// No key in this file, and none needed: the mapper is pure.

describe("the key never reaches git", () => {
	// pi-workspace/.mcp.json IS committed, and MCP config supports an `env` block —
	// so putting the key there would work perfectly and quietly ship a live secret
	// to the repo. That is exactly what makes it a trap. This test is the tripwire.
	it("pi-workspace/.mcp.json contains no key material", () => {
		const cfg = readFileSync(
			join(import.meta.dir, "..", "pi-workspace", ".mcp.json"),
			"utf8",
		);
		expect(cfg).not.toContain("SERPAPI_API_KEY");
		expect(cfg).not.toContain("SERPER_API_KEY");
		expect(cfg).not.toMatch(/[0-9a-f]{32,}/i);
	});

	it(".env is gitignored", () => {
		const ignore = readFileSync(join(import.meta.dir, "..", ".gitignore"), "utf8");
		expect(ignore.split("\n").map((l) => l.trim())).toContain(".env");
	});

	it(".env.example carries the name but never a value", () => {
		const p = join(import.meta.dir, "..", ".env.example");
		expect(existsSync(p)).toBe(true);
		const example = readFileSync(p, "utf8");
		expect(example).toContain("SERPAPI_API_KEY");
		expect(example).toContain("SERPER_API_KEY");
		expect(example).not.toMatch(/[0-9a-f]{32,}/i);
	});
});

describe("resolveSearchProviders — Serper first, SerpAPI second", () => {
	// Save/restore the real env so these tests never leak state (or a real key)
	// into each other.
	const saved = {
		serper: process.env.SERPER_API_KEY,
		serpapi: process.env.SERPAPI_API_KEY,
	};
	afterEach(() => {
		if (saved.serper === undefined) delete process.env.SERPER_API_KEY;
		else process.env.SERPER_API_KEY = saved.serper;
		if (saved.serpapi === undefined) delete process.env.SERPAPI_API_KEY;
		else process.env.SERPAPI_API_KEY = saved.serpapi;
	});

	it("lists serper first, then serpapi, when both keys are present", () => {
		process.env.SERPER_API_KEY = "serper-key";
		process.env.SERPAPI_API_KEY = "serpapi-key";
		expect(resolveSearchProviders()).toEqual([
			{ provider: "serper", key: "serper-key" },
			{ provider: "serpapi", key: "serpapi-key" },
		]);
	});

	it("lists serpapi last when only that key is in the environment", () => {
		delete process.env.SERPER_API_KEY;
		process.env.SERPAPI_API_KEY = "serpapi-key";
		// A SERPER_API_KEY in the repo's .env may still come first on this machine
		// (env-or-.env, serper preferred); serpapi must be last either way.
		expect(resolveSearchProviders().at(-1)).toEqual({ provider: "serpapi", key: "serpapi-key" });
	});
});

describe("runSearch — fall through providers, never silently", () => {
	const serper = { provider: "serper", key: "s" } as const;
	const serpapi = { provider: "serpapi", key: "p" } as const;

	it("returns the first provider's results with no note when it succeeds", async () => {
		const calls: string[] = [];
		const out = await runSearch([serper, serpapi], "q", undefined, async (p) => {
			calls.push(p.provider);
			return { ok: true, text: `results from ${p.provider}` };
		});
		expect(out).toBe("results from serper");
		expect(calls).toEqual(["serper"]);
	});

	it("falls back to SerpAPI and names why Serper failed", async () => {
		const out = await runSearch([serper, serpapi], "q", undefined, async (p) =>
			p.provider === "serper"
				? { ok: false, error: "Serper returned HTTP 400: Not enough credits" }
				: { ok: true, text: "results from serpapi" },
		);
		expect(out).toContain("Fell back to SerpAPI");
		expect(out).toContain("Not enough credits");
		expect(out).toEndWith("results from serpapi");
	});

	it("reports every provider's error when all fail", async () => {
		const out = await runSearch([serper, serpapi], "q", undefined, async (p) => ({
			ok: false,
			error: `${p.provider} broke`,
		}));
		expect(out).toContain("serper broke");
		expect(out).toContain("serpapi broke");
	});

	it("says no key is set when there are no providers", async () => {
		expect(await runSearch([], "q")).toContain("No search API key is set");
	});
});

describe("formatSerperResults", () => {
	it("maps organic results to title / link / snippet", () => {
		const out = formatSerperResults({
			organic: [
				{ title: "Bun docs", link: "https://bun.sh", snippet: "Fast runtime" },
				{ title: "MDN", link: "https://mdn.io", snippet: "Web docs" },
			],
		});
		expect(out).toContain("Bun docs");
		expect(out).toContain("https://bun.sh");
		expect(out).toContain("Fast runtime");
		expect(out).toContain("MDN");
	});

	it("says so plainly when there are no results", () => {
		expect(formatSerperResults({ organic: [] })).toContain("No results");
	});

	it("does not throw when organic is missing entirely", () => {
		expect(formatSerperResults({})).toContain("No results");
	});

	it("tolerates a result missing its fields", () => {
		const out = formatSerperResults({ organic: [{}] });
		expect(out).toContain("(no title)");
		expect(out).toContain("(no link)");
	});
});

describe("formatSerpResults", () => {
	it("maps organic results to title / link / snippet", () => {
		const out = formatSerpResults({
			organic_results: [
				{ title: "Bun docs", link: "https://bun.sh", snippet: "Fast runtime" },
				{ title: "MDN", link: "https://mdn.io", snippet: "Web docs" },
			],
		});
		expect(out).toContain("Bun docs");
		expect(out).toContain("https://bun.sh");
		expect(out).toContain("Fast runtime");
		expect(out).toContain("MDN");
	});

	it("says so plainly when there are no results", () => {
		expect(formatSerpResults({ organic_results: [] })).toContain("No results");
	});

	it("does not throw when organic_results is missing entirely", () => {
		// SerpAPI omits the key on some responses (e.g. an error payload). Returning
		// "No results" is honest; throwing would surface as an opaque tool crash to
		// the sub-agent, which cannot debug it.
		expect(formatSerpResults({})).toContain("No results");
	});

	it("tolerates a result missing its fields", () => {
		const out = formatSerpResults({ organic_results: [{}] });
		expect(out).toContain("(no title)");
		expect(out).toContain("(no link)");
	});
});
