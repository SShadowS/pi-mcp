import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { buildPiArgs, PI_WORKSPACE } from "../src/run-pi.js";

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
		const args = buildPiArgs("gpt-5.5", "hi");
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("github-copilot");
	});

	it("leashes pi to read,mcp — never bash, write, or edit", () => {
		const args = buildPiArgs("gpt-5.5", "hi");
		const tools = args[args.indexOf("--tools") + 1];
		expect(tools).toBe("read,mcp");
		expect(tools).not.toContain("bash");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("edit");
	});

	it("runs non-interactive and ephemeral", () => {
		const args = buildPiArgs("gpt-5.5", "hi");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
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
		const args = buildPiArgs("gpt-5.5", "hi");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args).toContain("--no-context-files");
	});

	it("passes the model through and puts the prompt last", () => {
		const args = buildPiArgs("gemini-3.1-pro-preview", "what is 2+2");
		expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-preview");
		expect(args[args.length - 1]).toBe("what is 2+2");
	});
});
