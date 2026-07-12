import { describe, expect, it } from "bun:test";
import { buildPiArgs } from "../src/run-pi.js";

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

	it("passes the model through and puts the prompt last", () => {
		const args = buildPiArgs("gemini-3.1-pro-preview", "what is 2+2");
		expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-preview");
		expect(args[args.length - 1]).toBe("what is 2+2");
	});
});
