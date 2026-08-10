import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { AdaptiveProviderQueue, createLaneId, sleepWithSignal } from "../src/queue.ts";
import { toOpenAIResponsesModel } from "../src/responses-model.ts";
import {
	createAdaptiveStream,
	isAdaptiveRateLimit,
	isAdaptiveTransientTransport,
	retryAfterMsFromError,
} from "../src/stream-wrapper.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-adaptive-queue-test-"));
	tempDirs.push(dir);
	return dir;
}

test("lane identity shares an endpoint only when the credential also matches", () => {
	const first = createLaneId({ provider: "one", baseUrl: "https://example.test/v1", apiKey: "same" });
	const alias = createLaneId({ provider: "two", baseUrl: "https://example.test/other", apiKey: "same" });
	const otherAccount = createLaneId({ provider: "one", baseUrl: "https://example.test/v1", apiKey: "different" });
	assert.equal(first, alias);
	assert.notEqual(first, otherAccount);
});

test("transient concurrency limits queue while quota and unavailable errors pass through", () => {
	assert.equal(
		isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "rate_limit_exceeded: Concurrency limit exceeded for account" }),
		true,
	);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "Too many pending requests, retry later" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "insufficient_quota: add credits" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "resource_exhausted: quota exceeded" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "model overloaded: no capacity" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "model unavailable" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "rate limit exceeded" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 401, errorMessage: "authentication failed" }), false);
});

test("retry-after hints are parsed without turning quota errors into queue waits", () => {
	assert.equal(retryAfterMsFromError({ errorMessage: "retry after 2.5 seconds" }), 2_500);
	assert.equal(retryAfterMsFromError({ errorMessage: "try again in 750ms" }), 750);
});

test("transient transport errors join the adaptive retry class", () => {
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "Error Code stream_read_error: stream_read_error" }), true);
	assert.equal(isAdaptiveTransientTransport(new Error("socket connection was closed unexpectedly")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("OpenAI responses stream timed out while waiting for the first event")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("responses stream ended without response.completed: missing_terminal")), true);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 502, errorMessage: "stream_read_error" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "model overloaded" }), false);
});

test("retry backoff uses ten-attempt stages and caps every wait at five minutes", () => {
	const queue = new AdaptiveProviderQueue({ baseDelayMs: 2_000, maxDelayMs: 300_000, random: () => 0 });
	const expected = new Map([
		[1, 2_000],
		[2, 4_000],
		[3, 8_000],
		[4, 16_000],
		[5, 30_000],
		[10, 30_000],
		[11, 60_000],
		[20, 60_000],
		[21, 120_000],
		[30, 120_000],
		[31, 180_000],
		[40, 180_000],
		[41, 300_000],
		[50, 300_000],
	]);
	for (const [attempt, delay] of expected) assert.equal(queue.backoffDelayMs(attempt), delay);
	assert.equal(queue.backoffDelayMs(1, 900_000), 300_000);
	assert.equal(new AdaptiveProviderQueue({ baseDelayMs: 2_000, maxDelayMs: 300_000, random: () => 1 }).backoffDelayMs(41), 300_000);
});

test("queued custom models regain Responses compat without downgrading reasoning effort", () => {
	const source = {
		provider: "aiinput-queued",
		id: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		reasoning: true,
		compat: undefined,
	};
	const gpt = toOpenAIResponsesModel(source);
	assert.equal(gpt.api, "openai-responses");
	assert.equal(gpt.compat.supportsReasoningEffort, true);
	assert.equal(gpt.compat.omitReasoningEffort, false);
	assert.equal(gpt.compat.supportsSamplingParams, false);
	assert.equal(source.compat, undefined);

	const grok = toOpenAIResponsesModel({
		provider: "tokenking-grok-queued",
		id: "grok-4.5",
		name: "Grok 4.5",
		reasoning: true,
		compatConfig: { supportsStrictMode: true },
	});
	assert.equal(grok.compat.supportsSamplingParams, true);
	assert.equal(grok.compat.supportsStrictMode, true);
});

test("tickets are ordered across queue instances and the next waiter wakes after release", async () => {
	const rootDir = await tempRoot();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const first = await firstQueue.acquire("lane");
	await sleepWithSignal(2);
	const second = await secondQueue.acquire("lane");
	assert.equal(await firstQueue.waitForTurn(first), 2);

	let secondReachedFront = false;
	const waiting = secondQueue.waitForTurn(second).then(() => {
		secondReachedFront = true;
	});
	await sleepWithSignal(30);
	assert.equal(secondReachedFront, false);
	await firstQueue.release(first);
	await waiting;
	assert.equal(secondReachedFront, true);
	await secondQueue.release(second);
	assert.equal(await firstQueue.hasWaiters("lane"), false);
});

test("queue waits honor cancellation and release remains idempotent", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const first = await queue.acquire("lane");
	await sleepWithSignal(2);
	const second = await queue.acquire("lane");
	const controller = new AbortController();
	const waiting = queue.waitForTurn(second, controller.signal);
	controller.abort();
	await assert.rejects(waiting, error => (error as Error).name === "AbortError");
	await queue.release(second);
	await queue.release(second);
	await queue.release(first);
});

test("separate processes share one FIFO retry lane", async () => {
	const rootDir = await tempRoot();
	const auditPath = path.join(rootDir, "audit.log");
	const childPath = path.join(import.meta.dirname, "queue-child.ts");
	const runChild = () =>
		new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", childPath, rootDir, "shared-lane", auditPath, "35"],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", chunk => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("exit", code => {
				if (code === 0) resolve();
				else reject(new Error(`queue child exited ${code}: ${stderr}`));
			});
		});
	await Promise.all([runChild(), runChild(), runChild()]);
	const rows = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map(line => line.split("\t"));
	assert.equal(rows.length, 6);
	for (let index = 0; index < rows.length; index += 2) {
		assert.equal(rows[index][0], "start");
		assert.equal(rows[index + 1][0], "end");
		assert.equal(rows[index][1], rows[index + 1][1]);
	}
});

class FakeInputStream implements AsyncIterable<any> {
	readonly events: any[];
	constructor(events: any[]) {
		this.events = events;
	}
	async *[Symbol.asyncIterator]() {
		for (const event of this.events) yield event;
	}
	async result() {
		const terminal = this.events.at(-1);
		return terminal?.message ?? terminal?.error ?? { stopReason: "error" };
	}
}

class FakeOutputStream {
	events: any[] = [];
	done = false;
	readonly completion = Promise.withResolvers<void>();
	push(event: any) {
		if (this.done) return;
		this.events.push(event);
		if (event.type === "done" || event.type === "error") {
			this.done = true;
			this.completion.resolve();
		}
	}
	fail(error: unknown) {
		if (this.done) return;
		this.done = true;
		this.completion.reject(error);
	}
}

function assistant(overrides: Record<string, unknown> = {}) {
	return { stopReason: "error", content: [], ...overrides };
}

test("stream wrapper discards pre-content 429 attempts and emits only the successful lifecycle", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([
			{ type: "start", partial: assistant() },
			{ type: "text_start", contentIndex: 0, partial: assistant() },
			{ type: "error", reason: "error", error: failed },
		]),
		new FakeInputStream([
			{ type: "start", partial: succeeded },
			{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
			{ type: "done", reason: "stop", message: succeeded },
		]),
	];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});
	await output.completion.promise;
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
	assert.equal(attempts.length, 0);
});

test("stream wrapper forwards the last rate-limit error after the retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "text_start", contentIndex: 0, partial: assistant() },
				{ type: "error", reason: "error", error: failed },
			]);
		},
	});
	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error, failed);
});

test("stream wrapper retries a thinking-only transport drop without duplicating thinking", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({
		errorMessage: "Error Code stream_read_error: stream_read_error",
		content: [{ type: "thinking", thinking: "check" }],
	});
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([
			{ type: "start", partial: assistant() },
			{ type: "thinking_start", contentIndex: 0, partial: assistant() },
			{ type: "thinking_delta", contentIndex: 0, delta: "check", partial: assistant() },
			{ type: "error", reason: "error", error: failed },
		]),
		new FakeInputStream([
			{ type: "start", partial: succeeded },
			{ type: "thinking_start", contentIndex: 0, partial: succeeded },
			{ type: "thinking_delta", contentIndex: 0, delta: "check again", partial: succeeded },
			{ type: "text_start", contentIndex: 0, partial: succeeded },
			{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
			{ type: "done", reason: "stop", message: succeeded },
		]),
	];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});
	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.deepEqual(output.events.map(event => event.type), ["start", "thinking_start", "thinking_delta", "text_start", "text_delta", "done"]);
	assert.equal(output.events.filter(event => event.type === "thinking_delta").length, 1);
});

test("rate limits and transport failures consume one shared retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const limited = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const interrupted = assistant({ errorMessage: "Error Code stream_read_error: stream_read_error" });
	const attempts = [
		new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: limited }]),
		new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: interrupted }]),
	];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});
	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.equal(output.events.at(-1).error, interrupted);
});

test("stream wrapper does not replay a transport drop after substantive text", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({ errorMessage: "Error Code stream_read_error: stream_read_error" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "text_delta", contentIndex: 0, delta: "partial", partial: failed },
				{ type: "error", reason: "error", error: failed },
			]);
		},
	});
	await output.completion.promise;
	assert.equal(attempts, 1);
	assert.equal(output.events.at(-1).error, failed);
});

test("stream wrapper never replays a rate limit after substantive content", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const error = assistant({
		errorStatus: 429,
		errorMessage: "Concurrency limit exceeded for account",
		content: [{ type: "text", text: "partial" }],
	});
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "text_delta", contentIndex: 0, delta: "partial", partial: error },
				{ type: "error", reason: "error", error },
			]);
		},
	});
	await output.completion.promise;
	assert.equal(attempts, 1);
	assert.equal(output.events.at(-1).error, error);
});

test("stream wrapper forwards unavailable errors unchanged for OMP fallback", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "model unavailable", errorId: 123 });
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]),
	});
	await output.completion.promise;
	assert.equal(output.events.length, 1);
	assert.equal(output.events[0].error, unavailable);
});
