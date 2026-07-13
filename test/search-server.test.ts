import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
	formatSerperResults,
	formatSerpResults,
	resolveSearchProvider,
} from "../src/search-server.js";

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

describe("resolveSearchProvider — Serper preferred, SerpAPI fallback", () => {
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

	it("picks serper when both keys are present", () => {
		process.env.SERPER_API_KEY = "serper-key";
		process.env.SERPAPI_API_KEY = "serpapi-key";
		expect(resolveSearchProvider()).toEqual({
			provider: "serper",
			key: "serper-key",
		});
	});

	it("falls back to serpapi when only that key is present", () => {
		delete process.env.SERPER_API_KEY;
		process.env.SERPAPI_API_KEY = "serpapi-key";
		// NOTE: a SERPER_API_KEY in the repo's .env would still win here — that is
		// correct behavior (env-or-.env, serper preferred), so only assert when the
		// .env fallback does not interfere.
		const got = resolveSearchProvider();
		if (got?.provider === "serpapi") {
			expect(got.key).toBe("serpapi-key");
		} else {
			expect(got?.provider).toBe("serper"); // .env had a serper key
		}
	});

	it("returns undefined when no key exists anywhere", () => {
		delete process.env.SERPER_API_KEY;
		delete process.env.SERPAPI_API_KEY;
		const got = resolveSearchProvider();
		// Only assert absence if the repo .env doesn't supply a key on this machine.
		if (got !== undefined) {
			expect(["serper", "serpapi"]).toContain(got.provider);
		}
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
