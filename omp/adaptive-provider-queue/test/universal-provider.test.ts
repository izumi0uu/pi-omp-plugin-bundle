import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADAPTIVE_RETRY_API,
	modelRequestOptions,
	UniversalProviderRetry,
} from "../src/universal-provider.ts";

test("all registry models keep their selectors while receiving the retry transport", () => {
	const first = {
		provider: "aiinput",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		name: "Sol",
	};
	const second = {
		provider: "anthropic",
		id: "claude-sonnet",
		api: "anthropic-messages",
		name: "Sonnet",
	};
	const retry = new UniversalProviderRetry();

	assert.equal(retry.wrapRegistry({ getAll: () => [first, second, { provider: "broken" }] }), 2);
	assert.equal(first.api, ADAPTIVE_RETRY_API);
	assert.equal(second.api, ADAPTIVE_RETRY_API);
	assert.equal(first.provider, "aiinput");
	assert.equal(first.id, "gpt-5.6-sol");
	assert.equal(first.name, "Sol");

	const restoredFirst = retry.restoreOriginalModel(first);
	const restoredSecond = retry.restoreOriginalModel(second);
	assert.equal(restoredFirst.api, "openai-responses");
	assert.equal(restoredSecond.api, "anthropic-messages");
	assert.equal(first.api, ADAPTIVE_RETRY_API);
	assert.notEqual(restoredFirst, first);
});

test("wrapping is idempotent and cloned request models recover their original API", () => {
	const model = {
		provider: "tokenking",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
	};
	const retry = new UniversalProviderRetry();

	assert.equal(retry.wrapModel(model), true);
	assert.equal(retry.wrapModel(model), false);
	assert.equal(retry.restoreOriginalModel({ ...model }).api, "openai-responses");
});

test("a wrapped model without original transport metadata fails closed", () => {
	const retry = new UniversalProviderRetry();
	assert.throws(
		() => retry.restoreOriginalModel({ provider: "unknown", id: "model", api: ADAPTIVE_RETRY_API }),
		/Missing original provider API/,
	);
});

test("Anthropic model beta headers reach the final request without mutating options", async () => {
	const model = {
		provider: "anyrouter",
		id: "claude-opus-4-8",
		api: "anthropic-messages",
		headers: { "Anthropic-Beta": "context-1m-2025-08-07,effort-2025-11-24" },
	};
	let finalHeaders: Headers | undefined;
	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		finalHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
		return new Response("ok");
	};
	const options = {
		betas: ["effort-2025-11-24", "custom-beta"],
		fetch: fakeFetch,
		sessionId: "session",
	};
	const requestOptions = modelRequestOptions(model, options);

	assert.equal(requestOptions.betas, "effort-2025-11-24,custom-beta,context-1m-2025-08-07");
	assert.notEqual(requestOptions.fetch, fakeFetch);
	await requestOptions.fetch?.(
		new Request("https://example.test/v1/messages", {
			headers: { "anthropic-beta": "request-beta", authorization: "Bearer secret" },
		}),
		{ headers: { "anthropic-beta": "init-beta", "x-test": "kept" } },
	);
	assert.equal(
		finalHeaders?.get("anthropic-beta"),
		"request-beta,init-beta,effort-2025-11-24,custom-beta,context-1m-2025-08-07",
	);
	assert.equal(finalHeaders?.get("authorization"), "Bearer secret");
	assert.equal(finalHeaders?.get("x-test"), "kept");
	assert.equal(options.fetch, fakeFetch);
	assert.deepEqual(options.betas, ["effort-2025-11-24", "custom-beta"]);
});

test("non-Anthropic transports do not receive configured beta headers", () => {
	const options = { sessionId: "session" };
	assert.equal(modelRequestOptions({
		provider: "anyrouter",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		headers: { "anthropic-beta": "context-1m-2025-08-07" },
	}, options), options);
});
