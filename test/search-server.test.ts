import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { formatSerpResults } from "../src/search-server.js";

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
		expect(example).not.toMatch(/[0-9a-f]{32,}/i);
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
