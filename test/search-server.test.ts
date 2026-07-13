import { describe, expect, it } from "bun:test";
import { formatSerpResults } from "../src/search-server.js";

// No key in this file, and none needed: the mapper is pure.

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
