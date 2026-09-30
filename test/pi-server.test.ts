import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatAskResult, cleanupLivePi, EVIDENCE_CONTRACT, evidenceVerdict, extractEvidence, annotateModels, MODEL_NOTES, snapshotSources, changedSources } from "../src/pi-server.js";
import { livePiPids } from "../src/run-pi.js";

describe("stale-code detection — edits to src/ must not go unnoticed", () => {
	it("reports modified, added, and removed .ts files, and ignores the rest", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-src-"));
		writeFileSync(join(dir, "a.ts"), "a");
		writeFileSync(join(dir, "b.ts"), "b");
		writeFileSync(join(dir, "notes.md"), "x");
		const snap = snapshotSources(dir);
		expect(changedSources(dir, snap)).toEqual([]);

		utimesSync(join(dir, "a.ts"), new Date(), new Date(Date.now() + 5000));
		rmSync(join(dir, "b.ts"));
		writeFileSync(join(dir, "c.ts"), "c");
		writeFileSync(join(dir, "notes.md"), "changed");
		expect(changedSources(dir, snap)).toEqual(["a.ts", "b.ts", "c.ts"]);
	});
});

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

describe("require_evidence — the fix for silent prior-answering (BACKLOG 0c)", () => {
	const answer = [
		"The detector works by scanning IR nodes.",
		"",
		"```json evidence",
		JSON.stringify({
			files_checked: ["U:/Git/al-perf/src/core/patterns.ts"],
			searches_performed: ["al-perf ir-json"],
			confidence: "high",
		}),
		"```",
	].join("\n");

	it("extracts the evidence block and strips it from the body", () => {
		const { evidence, body } = extractEvidence(answer);
		expect(evidence?.files_checked).toEqual(["U:/Git/al-perf/src/core/patterns.ts"]);
		expect(evidence?.confidence).toBe("high");
		expect(body).toContain("scanning IR nodes");
		expect(body).not.toContain("json evidence");
	});

	it("returns null evidence when the model ignored the contract", () => {
		const { evidence, body } = extractEvidence("Just prose, no block.");
		expect(evidence).toBeNull();
		expect(body).toBe("Just prose, no block.");
	});

	it("flags an answer with zero files and zero searches as prior-derived", () => {
		// This is Gemini's failure mode made visible in the data: confident
		// conclusions, nothing examined.
		const verdict = evidenceVerdict({
			files_checked: [],
			searches_performed: [],
			confidence: "high",
		});
		expect(verdict).toContain("⚠");
		expect(verdict.toLowerCase()).toContain("prior");
	});

	it("flags a missing evidence block even harder", () => {
		expect(evidenceVerdict(null)).toContain("⚠");
	});

	it("passes a well-evidenced answer quietly", () => {
		const verdict = evidenceVerdict({
			files_checked: ["U:/Git/al-perf/src/core/patterns.ts"],
			searches_performed: [],
			confidence: "high",
		});
		expect(verdict).not.toContain("⚠");
		expect(verdict).toContain("1 file");
	});

	it("the contract demands the exact fields extractEvidence parses", () => {
		for (const field of ["files_checked", "searches_performed", "confidence"]) {
			expect(EVIDENCE_CONTRACT).toContain(field);
		}
	});
});

describe("pi_models reliability annotations (BACKLOG #4)", () => {
	it("annotates rows for models we have measured", () => {
		const listing = [
			"provider          model",
			"github-copilot    gpt-5.5",
			"github-copilot    gemini-3.1-pro-preview",
			"github-copilot    some-untested-model",
		].join("\n");
		const out = annotateModels(listing);
		expect(out).toContain("gpt-5.5    ←");
		expect(out).toContain("gemini-3.1-pro-preview    ←");
		// Untested rows pass through untouched — no invented ratings.
		expect(out).toContain("github-copilot    some-untested-model");
		expect(out.split("\n")[3]).not.toContain("←");
	});

	it("notes exist for the three models we actually measured", () => {
		expect(MODEL_NOTES["gpt-5.5"]).toBeTruthy();
		expect(MODEL_NOTES["gemini-3.1-pro-preview"]).toBeTruthy();
		expect(MODEL_NOTES["claude-fable-5"]).toBeTruthy();
	});
});
