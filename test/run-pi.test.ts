import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_TIMEOUT_MS, killTree, livePiPids, buildPiArgs, PI_WORKSPACE, SESSIONS_DIR, runPi } from "../src/run-pi.js";

describe("PI_WORKSPACE — the cwd IS the MCP config", () => {
	// pi discovers MCP servers ONLY from the .mcp.json in its working directory,
	// and pi has no built-in web access at all. So this file existing, in this
	// directory, is the entire reason pi can search and fetch. Run pi anywhere
	// else and it silently loses the web — silently, because pi reports no error,
	// it just has no servers.
	it("the workspace has a .mcp.json wiring up fetch and search", () => {
		const cfgPath = join(PI_WORKSPACE, ".mcp.json");
		expect(existsSync(cfgPath)).toBe(true);

		const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
		expect(Object.keys(cfg.mcpServers)).toContain("fetch");
		expect(Object.keys(cfg.mcpServers)).toContain("search");
	});
});

describe("buildPiArgs", () => {
	it("always passes --provider github-copilot", () => {
		// Without this, pi falls back to an unauthenticated provider and prints a
		// login prompt instead of an answer. Verified against the real binary.
		const args = buildPiArgs("gpt-5.5");
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("github-copilot");
	});

	it("leashes pi to read,mcp — never bash, write, or edit", () => {
		const args = buildPiArgs("gpt-5.5");
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).toBe("read,mcp");
		expect(tools).not.toContain("bash");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("edit");
	});

	it("runs non-interactive and ephemeral", () => {
		const args = buildPiArgs("gpt-5.5");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
	});

	it("defaults to HIGH thinking — anything less and models skip their tools", () => {
		// Measured, not guessed. At pi's default (medium), given "read these three
		// files and audit them": Gemini wrote 443 words from priors without opening
		// a file; Fable claimed it could not find files it had been handed absolute
		// paths to. At high, Fable read the file and quoted the deciding line.
		// A delegate that answers from priors is worse than useless — it is
		// confidently wrong and it looks like an answer.
		const args = buildPiArgs("gpt-5.5");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
	});

	it("thinking is overridable", () => {
		const args = buildPiArgs("gpt-5.5", "low");
		expect(args[args.indexOf("--thinking") + 1]).toBe("low");
	});

	it("does not inherit the caller's skills, templates, or context files", () => {
		// The whole point of this tool is an INDEPENDENT opinion from another model
		// family. pi loads ~/.claude/skills by default — the SAME skills the calling
		// Claude has — which makes the delegate's answer the caller's own priors
		// laundered through a different model.
		//
		// This is not hypothetical: Gemini once answered a "read these three files
		// and audit them" prompt from an al-sem-detector skill it found in
		// ~/.claude/skills, never opening the code.
		const args = buildPiArgs("gpt-5.5");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).toContain("--no-context-files");
	});

	it("passes the model through and argv NEVER carries the prompt", () => {
		// The prompt travels on stdin (see runPi). On Windows the npm pi.cmd shim
		// routes argv through cmd.exe, whose command line truncates at the first
		// newline and interprets `>` `<` `&` `|` — a multiline prompt as an argv
		// element silently arrived as its first line only. Every element here must
		// be a flag or a flag value; anything else is the bug coming back.
		const args = buildPiArgs("gemini-3.1-pro-preview");
		expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-preview");
		const flagValues = new Set([
			"--thinking", "--provider", "--model", "--tools", "--session-id", "--session-dir",
		]);
		for (let i = 0; i < args.length; i++) {
			const isFlag = args[i].startsWith("-");
			const isFlagValue = i > 0 && flagValues.has(args[i - 1]);
			expect(isFlag || isFlagValue).toBe(true);
		}
	});
});

describe("continuation via pi sessions (BACKLOG 0a)", () => {
	it("without a sessionId stays ephemeral", () => {
		const args = buildPiArgs("gpt-5.5");
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--session-id");
	});

	it("with a sessionId drops --no-session and pins the session dir", () => {
		// --session-id creates-or-resumes; --session-dir keeps session files
		// inside the workspace instead of the user's global ~/.pi tree, so they
		// are ours to find and ours to delete.
		const args = buildPiArgs("gpt-5.5", "high", "abc-123");
		expect(args).not.toContain("--no-session");
		expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");
		expect(args[args.indexOf("--session-dir") + 1]).toBe(SESSIONS_DIR);
	});

	it("a session run keeps ALL contamination guards", () => {
		// Multi-turn must not quietly become multi-turn-with-the-caller's-skills.
		const args = buildPiArgs("gpt-5.5", "high", "abc-123");
		for (const g of ["--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			expect(args).toContain(g);
		}
	});
});

describe("prompt delivery (integration — hits the real API)", () => {
	it(
		"a multiline prompt with cmd metachars arrives INTACT",
		async () => {
			// THE regression test for the 2026-07-17 truncation bug: prompts passed
			// as argv reached the delegate as their FIRST LINE ONLY (npm .cmd shim →
			// cmd.exe → command line ends at the first newline), and `>` `<` `&` `|`
			// were live shell syntax. Four real review requests failed exactly this
			// way — the delegate kept replying "you didn't send the proposal".
			// The marker lives on line 3: if the channel truncates, the model cannot
			// know it, no matter how it feels about line 1.
			const prompt = [
				"Line 1 has cmd metachars: 4 > 1, a < b, x & y, p | q.",
				"Line 2 is filler to prove multiline delivery.",
				"Line 3: reply with ONLY the marker STDIN-INTACT-31. Nothing else.",
			].join("\n");
			const res = await runPi("gpt-5-mini", prompt, "off");
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.text).toContain("STDIN-INTACT-31");
		},
		180_000,
	);
});

describe("timeout kills the whole process tree — never just pi (BACKLOG #1)", () => {
	it("exports a default timeout of 20 minutes", () => {
		// 5–15 min is a normal research call; a wedged one is forever. 20 min
		// bounds the pathological case without clipping the normal one.
		expect(DEFAULT_TIMEOUT_MS).toBe(20 * 60_000);
	});

	it("killTree kills a process AND its children", async () => {
		// Spawn a shell that spawns a long-lived child, mirroring pi spawning
		// its MCP servers. killTree on the parent must take the child too —
		// this is exactly what naive `timeout N pi ...` fails to do.
		const parent = Bun.spawn(
			process.platform === "win32"
				? ["cmd", "/c", "start /b ping -n 600 127.0.0.1 > NUL & ping -n 600 127.0.0.1 > NUL"]
				: ["sh", "-c", "sleep 600 & sleep 600"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		await killTree(parent.pid);
		// The parent must be dead within a beat.
		const exited = await Promise.race([
			parent.exited.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
		]);
		expect(exited).toBe(true);
	});

	it("runPi times out, kills the tree, and reports it", async () => {
		// A 1ms budget guarantees a timeout regardless of environment. We do not
		// need a real model — pi will be killed before it does anything.
		const res = await runPi("gpt-5.5", "hi", "off", 1);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("timed out");
	}, 30_000);

	it("tracks live pi PIDs and clears them when the call ends", async () => {
		const before = livePiPids.size;
		await runPi("gpt-5.5", "hi", "off", 1);
		// Whatever was added for this call must be removed again.
		expect(livePiPids.size).toBe(before);
	}, 30_000);
});
