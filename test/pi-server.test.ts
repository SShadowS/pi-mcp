import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatAskResult } from "../src/pi-server.js";

describe("formatAskResult", () => {
	it("returns the answer inline when no output_file is given", () => {
		const out = formatAskResult({ ok: true, text: "the answer" }, undefined);
		expect(out).toBe("the answer");
	});

	it("writes the FULL answer to output_file and returns only a short summary", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
		const file = join(dir, "answer.md");
		const long = "word ".repeat(5000).trim(); // 5000 words

		const out = formatAskResult({ ok: true, text: long }, file);

		// The file gets everything.
		expect(readFileSync(file, "utf8")).toBe(long);

		// The caller gets almost nothing. This is the whole point of the parameter:
		// a 4-model fan-out must not cost 40k tokens of the caller's context.
		expect(out.length).toBeLessThan(700);
		expect(out).toContain(file);
		expect(out).toContain("5000 words");
	});

	it("creates the output directory if it does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-"));
		const file = join(dir, "nested", "deep", "answer.md");

		formatAskResult({ ok: true, text: "hello" }, file);

		expect(readFileSync(file, "utf8")).toBe("hello");
	});

	it("surfaces a pi failure as an error string, not silence", () => {
		const out = formatAskResult(
			{ ok: false, error: "pi exited 1: boom" },
			undefined,
		);
		expect(out).toContain("boom");
	});
});
