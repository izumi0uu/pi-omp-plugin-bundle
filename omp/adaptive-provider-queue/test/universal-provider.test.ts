import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADAPTIVE_RETRY_API,
	isAgentRouterProvider,
	isQuotaFallbackProvider,
	modelForProviderRequest,
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

test("JustWorker models are registered with the universal retry transport", () => {
	const model = {
		provider: "justworker",
		id: "claude-opus-5",
		api: "openai-completions",
		baseUrl: "https://api.justwoker.icu/v1",
	};
	const retry = new UniversalProviderRetry();

	assert.equal(retry.wrapRegistry({ getAll: () => [model] }), 1);
	assert.equal(model.api, ADAPTIVE_RETRY_API);
	assert.equal(retry.restoreOriginalModel(model).api, "openai-completions");
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

test("AgentRouter Codex requests use its supported Responses endpoint", async () => {
	const requests: Request[] = [];
	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		requests.push(new Request(input, init));
		return new Response("ok");
	};
	for (const provider of ["agentrouter", "agentrouter-2", "agentrouter-3"]) {
		const options = { fetch: fakeFetch, sessionId: "session" };
		const requestOptions = modelRequestOptions({
			provider,
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
			baseUrl: "https://agentrouter.org",
		}, options);

		assert.notEqual(requestOptions.fetch, fakeFetch);
		for (const path of ["/codex/responses", "/v1/codex/responses"]) {
			await requestOptions.fetch?.(`https://agentrouter.org${path}?trace=${provider}`, {
				method: "POST",
				headers: { authorization: "Bearer secret", "x-codex-test": "kept" },
				body: "payload",
			});
		}
	}
	assert.equal(requests.length, 6);
	for (const request of requests) {
		assert.match(request.url, /^https:\/\/agentrouter\.org\/v1\/responses\?trace=agentrouter(?:-2|-3)?$/);
		assert.equal(request.method, "POST");
		assert.equal(request.headers.get("authorization"), "Bearer secret");
		assert.equal(request.headers.get("x-codex-test"), "kept");
		assert.equal(request.headers.get("user-agent"), "codex_cli_rs/0.1.0");
		assert.equal(await request.text(), "payload");
	}
});

test("AgentRouter Codex models use the ordinary Responses transport at the gateway endpoint", () => {
	for (const provider of ["agentrouter", "agentrouter-2", "agentrouter-3"]) {
		const source = {
			provider,
			id: "gpt-5.6-sol",
			api: "openai-codex-responses" as const,
			baseUrl: "https://agentrouter.org",
			headers: { "x-test": "kept" },
		};
		const routed = modelForProviderRequest(source);
		assert.equal(routed.api, "openai-responses");
		assert.equal(routed.baseUrl, "https://agentrouter.org/v1");
		assert.deepEqual(routed.headers, {
			...source.headers,
			"user-agent": "codex_cli_rs/0.1.0",
		});
		assert.equal(source.api, "openai-codex-responses");
	}
});

test("AgentRouter Responses models with a root URL are normalized to /v1", () => {
	const source = {
		provider: "agentrouter-3",
		id: "gpt-5.6-sol",
		api: "openai-responses" as const,
		baseUrl: "https://agentrouter.org",
	};
	const routed = modelForProviderRequest(source);
	assert.equal(routed.api, "openai-responses");
	assert.equal(routed.baseUrl, "https://agentrouter.org/v1");
	assert.equal(routed.headers?.["user-agent"], "codex_cli_rs/0.1.0");
	assert.equal(source.baseUrl, "https://agentrouter.org");
});

test("AgentRouter provider aliases are recognized without matching unrelated providers", () => {
	assert.equal(isAgentRouterProvider("agentrouter"), true);
	assert.equal(isAgentRouterProvider("agentrouter-2"), true);
	assert.equal(isAgentRouterProvider("agentrouter-3"), true);
	assert.equal(isAgentRouterProvider("agentrouter-20"), true);
	assert.equal(isAgentRouterProvider("agentrouterx"), false);
	assert.equal(isAgentRouterProvider("other-agentrouter"), false);
});

test("quota fallback recognizes numbered JustWorker accounts", () => {
	assert.equal(isQuotaFallbackProvider("justworker"), true);
	assert.equal(isQuotaFallbackProvider("justworker-2"), true);
	assert.equal(isQuotaFallbackProvider("justworker-3"), true);
	assert.equal(isQuotaFallbackProvider("justworker-20"), true);
	assert.equal(isQuotaFallbackProvider("justworkerx"), false);
	assert.equal(isQuotaFallbackProvider("other-provider"), false);
});

test("AgentRouter path bridge preserves Request semantics and cancellation", async () => {
	const controller = new AbortController();
	let request: Request | undefined;
	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return new Response("ok");
	};
	const requestOptions = modelRequestOptions({
		provider: "agentrouter-2",
		id: "gpt-5.6-sol",
		api: "openai-codex-responses",
		baseUrl: "https://agentrouter.org",
	}, { fetch: fakeFetch });
	const original = new Request("https://agentrouter.org/codex/responses?trace=1", {
		method: "POST",
		headers: { authorization: "Bearer secret", "x-codex-test": "kept" },
		body: "payload",
		signal: controller.signal,
	});

	await requestOptions.fetch?.(original);
	assert.ok(request);
	assert.equal(request.url, "https://agentrouter.org/v1/responses?trace=1");
	assert.equal(request.method, "POST");
	assert.equal(request.headers.get("authorization"), "Bearer secret");
	assert.equal(request.headers.get("x-codex-test"), "kept");
	assert.equal(request.headers.get("user-agent"), "codex_cli_rs/0.1.0");
	assert.equal(await request.text(), "payload");
	assert.equal(request.signal.aborted, false);
	controller.abort();
	assert.equal(request.signal.aborted, true);
});

test("AgentRouter path bridge leaves unrelated requests and transports untouched", async () => {
	const seen: Array<RequestInfo | URL> = [];
	const fakeFetch: typeof globalThis.fetch = async input => {
		seen.push(input);
		return new Response("ok");
	};
	const options = { fetch: fakeFetch };
	const bridged = modelRequestOptions({
		provider: "agentrouter",
		id: "gpt-5.6-sol",
		api: "openai-codex-responses",
		baseUrl: "https://agentrouter.org",
	}, options);
	const unrelated = [
		"https://agentrouter.org/v1/codex/responses/compact",
		"https://agentrouter.org/v1/models",
		"https://example.test/v1/codex/responses",
	];
	for (const url of unrelated) await bridged.fetch?.(url);

	assert.deepEqual(seen, unrelated);
	const ordinaryResponses = modelRequestOptions({
		provider: "agentrouter",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		baseUrl: "https://agentrouter.org",
	}, options);
	assert.notEqual(ordinaryResponses.fetch, options.fetch);
	await ordinaryResponses.fetch?.("https://agentrouter.org/v1/responses", { method: "POST" });
	assert.equal(String(seen.at(-1)), "https://agentrouter.org/v1/responses");
	assert.equal(modelRequestOptions({
		provider: "other",
		id: "gpt-5.6-sol",
		api: "openai-codex-responses",
		baseUrl: "https://agentrouter.org",
	}, options), options);
});
