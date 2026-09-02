import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_HANDOFF_TIMEOUT_MS,
	HANDOFF_ENTRY_TYPE,
	MAX_HANDOFF_TIMEOUT_MS,
	buildOrchestrationMessage,
	createHandoffPlan,
	formatPlan,
	normalizeHandoffRequest,
	parseHandoffCommand,
} from "../src/handoff.ts";

test("registers commands and queues an auditable orchestration request", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => void }>();
	const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ text: string; options: Record<string, unknown> }> = [];
	const zodChain = () => ({ optional() { return this; } });
	const pi = {
		zod: {
			string: zodChain,
			number: zodChain,
			object: (shape: unknown) => shape,
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => void }) {
			commands.set(name, definition);
		},
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) {
			tools.push(definition);
		},
		appendEntry(type: string, data: Record<string, unknown>) {
			entries.push({ type, data });
		},
		sendMessage(text: string, options: Record<string, unknown>) {
			messages.push({ text, options });
		},
	};
	const { default: register } = await import("../src/index.ts");
	register(pi as never);

	assert.deepEqual([...commands.keys()], ["task-handoff", "task-replace"]);
	assert.equal(tools[0]?.name, "task_provider_handoff");
	const ctx = {
		cwd: "/workspace",
		getAsyncJobSnapshot: () => ({ running: ["TerraWorker"] }),
		ui: { notify() {} },
	};
	commands.get("task-replace")?.handler("TerraWorker tokenking-terra-max-executor unavailable", ctx);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.type, HANDOFF_ENTRY_TYPE);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.options.deliverAs, "followUp");
	assert.equal(messages[0]?.options.triggerTurn, true);
	assert.match(messages[0]?.text ?? "", /hub with/);

	const result = await tools[0].execute("call-1", {
		sourceAgentId: "TerraWorker",
		targetAgent: "tokenking-terra-max-executor",
	}, undefined, undefined, ctx);
	assert.equal(result.details.orchestrationQueued, true);
	assert.equal(entries.length, 2);
});

test("normalizes a provider-bound replacement request and clamps its timeout", () => {
	assert.deepEqual(normalizeHandoffRequest({
		sourceAgentId: "TerraWorker",
		targetAgent: "tokenking-terra-max-executor",
		reason: "AI Input is saturated",
		timeoutMs: 999_999,
	}), {
		sourceAgentId: "TerraWorker",
		targetAgent: "tokenking-terra-max-executor",
		reason: "AI Input is saturated",
		timeoutMs: MAX_HANDOFF_TIMEOUT_MS,
	});
	assert.equal(normalizeHandoffRequest({ sourceAgentId: "TerraWorker", targetAgent: "task" }).timeoutMs, DEFAULT_HANDOFF_TIMEOUT_MS);
});

test("rejects unsafe ids instead of turning free-form text into a task selector", () => {
	assert.throws(() => normalizeHandoffRequest({ sourceAgentId: "Terra Worker", targetAgent: "task" }), /sourceAgentId/);
	assert.throws(() => normalizeHandoffRequest({ sourceAgentId: "TerraWorker", targetAgent: "https://evil.invalid" }), /targetAgent/);
});

test("parses command arguments while preserving the reason", () => {
	assert.deepEqual(parseHandoffCommand("TerraWorker tokenking-terra-max-executor provider is unavailable"), {
		sourceAgentId: "TerraWorker",
		targetAgent: "tokenking-terra-max-executor",
		reason: "provider is unavailable",
	});
	assert.deepEqual(parseHandoffCommand("TerraWorker"), { sourceAgentId: "TerraWorker" });
	assert.equal(parseHandoffCommand("status"), undefined);
	assert.equal(parseHandoffCommand("TerraWorker https://evil.invalid"), undefined);
});

test("orchestration message keeps replacement ordering and never promises in-place switching", () => {
	const plan = createHandoffPlan({
		sourceAgentId: "TerraWorker",
		targetAgent: "tokenking-terra-max-executor",
		timeoutMs: 15_000,
	}, { requestId: "h-123456", now: new Date("2026-08-30T12:00:00.000Z") });
	const message = buildOrchestrationMessage(plan, { cwd: "/workspace", snapshot: { running: ["TerraWorker"] } });
	assert.match(message, /replacement, not an in-place model mutation/);
	assert.match(message, /hub with \{"op":"send"/);
	assert.match(message, /hub with \{"op":"cancel"/);
	assert.match(message, /Use task with/);
	assert.ok(message.indexOf("hub with {\"op\":\"send\"") < message.indexOf("hub with {\"op\":\"cancel\""));
	assert.ok(message.indexOf("hub with {\"op\":\"cancel\"") < message.indexOf("Use task with"));
	assert.match(message, /history:\/\/TerraWorker/);
	assert.match(formatPlan(plan), /mode: replacement/);
});
