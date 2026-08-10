import assert from "node:assert/strict";
import test from "node:test";
import {
	KIMI_CODE_API,
	KIMI_CODE_API_KEY,
	KIMI_CODE_BASE_URL,
	KIMI_MODEL_SPECS,
	kimiStreamModel,
	kimiTransportOptions,
} from "../src/kimi-config.ts";

test("Kimi queued provider uses a custom API identity and the stored login credential", () => {
	assert.equal(KIMI_CODE_API, "adaptive-queued-kimi");
	assert.notEqual(KIMI_CODE_API, "openai-completions");
	assert.equal(KIMI_CODE_BASE_URL, "https://api.kimi.com/coding/v1");
	assert.equal(KIMI_CODE_API_KEY, "!omp token kimi-code --raw");
});

test("Kimi transport receives the resolved credential and disables nested retries", () => {
	const options = { apiKey: "resolved-secret", signal: new AbortController().signal, temperature: 0.2 };
	const resolved = kimiTransportOptions(options);

	assert.equal(resolved.apiKey, options.apiKey);
	assert.equal(resolved.signal, options.signal);
	assert.equal(resolved.temperature, options.temperature);
	assert.equal(resolved.maxRetries, 0);
});

test("Kimi transport model restores protocol metadata without losing queued identity", () => {
	const canonical = {
		provider: "kimi-code",
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
		compat: {
			thinkingFormat: "kimi",
			reasoningContentField: "reasoning_content",
			supportsStrictMode: false,
		},
		compatConfig: { thinkingFormat: "kimi" },
	};
	const restored = kimiStreamModel({
		id: "k3",
		provider: "kimi-code-queued",
		compat: undefined,
		name: "queued K3",
	}, canonical);

	assert.equal(restored.provider, "kimi-code-queued");
	assert.equal(restored.api, "openai-completions");
	assert.equal(restored.baseUrl, KIMI_CODE_BASE_URL);
	assert.equal(restored.name, "queued K3");
	assert.equal(restored.compat.thinkingFormat, "kimi");
	assert.equal(restored.compat.reasoningContentField, "reasoning_content");
	assert.equal(restored.compat.supportsStrictMode, false);
	assert.equal(restored.compatConfig.thinkingFormat, "kimi");
	assert.deepEqual(restored.thinking.efforts, ["low", "high", "max"]);

	const k2dot5 = kimiStreamModel(
		{ id: "kimi-k2.5", provider: "kimi-code-queued", compat: undefined },
		{ compat: { thinkingFormat: "zai", requiresReasoningContentForToolCalls: true } },
	);
	assert.equal(k2dot5.compat.thinkingFormat, "zai");
	assert.equal(k2dot5.compat.requiresReasoningContentForToolCalls, true);
});

test("Kimi queued models mirror the current OMP Kimi Code catalog", () => {
	assert.deepEqual(
		KIMI_MODEL_SPECS.map(model => model.id),
		[
			"k3",
			"k3-256k",
			"kimi-for-coding",
			"kimi-for-coding-highspeed",
			"kimi-k2",
			"kimi-k2-turbo-preview",
			"kimi-k2.5",
		],
	);

	const k3 = KIMI_MODEL_SPECS[0];
	assert.deepEqual(k3.thinking, {
		mode: "effort",
		efforts: ["low", "high", "max"],
		requiresEffort: true,
		defaultLevel: "high",
	});
	assert.equal(k3.contextWindow, 1_048_576);
	assert.equal(KIMI_MODEL_SPECS.find(model => model.id === "kimi-for-coding")?.compat?.thinkingFormat, "zai");
});
