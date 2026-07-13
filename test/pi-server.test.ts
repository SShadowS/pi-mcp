import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatAskResult, cleanupLivePi } from "../src/pi-server.js";
import { livePiPids } from "../src/run-pi.js";

describe("formatAskResult carries the continuation_id", () => {
	it("appends the id on success so the caller can continue the thread", () => {
		const out = formatAskResult({ ok: true, text: "answer" }, undefined, "abc-123");
		expect(out).toContain("answer");
		expect(out).toContain("[continuation_id: abc-123]");
	});

	it("omits it on failure — a dead call is not a thread", () => {
		const out = formatAskResult({ ok: false, error: "boom" }, undefined, "abc-123");
		expect(out).not.toContain("continuation_id");
	});
});

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

describe("pi_cleanup — safe reaping, scoped to PIDs WE spawned", () => {
	it("kills only tracked pi trees and reports the count", async () => {
		// A fake "pi" stand-in: any long-lived process we own.
		const stub = Bun.spawn(
			process.platform === "win32"
				? ["ping", "-n", "600", "127.0.0.1"]
				: ["sleep", "600"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		livePiPids.add(stub.pid);

		const killed = await cleanupLivePi();
		expect(killed).toBeGreaterThanOrEqual(1);
		expect(livePiPids.size).toBe(0);

		const exited = await Promise.race([
			stub.exited.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
		]);
		expect(exited).toBe(true);
	});

	it("is a no-op when nothing is tracked", async () => {
		expect(await cleanupLivePi()).toBe(0);
	});
});
