import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolvePiAgentDir } from "../src/agent-dir.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const root = join(import.meta.dirname, "..");

test("defaults follow OMP config and profile directories", () => {
	assert.equal(
		resolvePiAgentDir({}, "/Users/example"),
		"/Users/example/.omp/agent",
	);
	assert.equal(
		resolvePiAgentDir(
			{ PI_CONFIG_DIR: "custom-omp", OMP_PROFILE: "work" },
			"/Users/example",
		),
		"/Users/example/custom-omp/profiles/work/agent",
	);
	assert.equal(
		resolvePiAgentDir({ PI_CODING_AGENT_DIR: "~/.omp/agent" }, "/Users/example"),
		"/Users/example/.omp/agent",
	);
});

test("does not take ownership of OMP's edit, write, or legacy search tools by default", () => {
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.read, true);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.grep, true);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.bash, true);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.edit, false);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.write, false);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.find, false);
	assert.equal(DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides.ls, false);
});

test("manifest uses the OMP extension entrypoint and canonical OMP imports", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		omp?: { extensions?: string[] };
	};
	assert.deepEqual(manifest.omp?.extensions, ["./index.ts"]);

	const source = readFileSync(join(root, "src/index.ts"), "utf8");
	assert.match(source, /@oh-my-pi\/pi-coding-agent/);
	assert.doesNotMatch(source, /@(?:earendil-works|mariozechner)\/pi-/);
});
