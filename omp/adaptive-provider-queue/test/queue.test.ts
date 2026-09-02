import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
	AIINPUT_ENDPOINTS,
	AiInputEndpointRouter,
} from "../src/aiinput-router.ts";
import {
	AdaptiveProviderQueue,
	createLaneId,
	sleepWithSignal,
	type LaneRetryState,
} from "../src/queue.ts";
import type { AdaptiveRetryProgress } from "../src/retry-progress.ts";
import {
	AdaptiveRetryExhaustedError,
	ADAPTIVE_RETRY_EXHAUSTED_CODE,
	ADAPTIVE_TERMINAL_ABORT_ERROR_ID,
	adaptiveRetryExhaustedReport,
	adaptiveRetryStopMessage,
	createAdaptiveStream,
	isAdaptiveQuotaFailure,
	isAdaptiveProviderFailure,
	isAdaptiveRateLimit,
	isAdaptiveTransientTransport,
	isAdaptiveTransientUpstream,
	retryAfterMsFromError,
} from "../src/stream-wrapper.ts";
import {
	findProviderConfigReferences,
	parseProviderConfigCommand,
	removeProviderConfig,
} from "../src/provider-config.ts";

const tempDirs: string[] = [];

test("provider removal command parses safe provider and model targets", () => {
	assert.deepEqual(parseProviderConfigCommand("list"), { action: "list" });
	assert.deepEqual(parseProviderConfigCommand("aiinput/gpt-5.6-sol --dry-run"), {
		action: "model", provider: "aiinput", model: "gpt-5.6-sol", yes: false, force: false, dryRun: true,
	});
	assert.deepEqual(parseProviderConfigCommand("provider justworker --yes --force"), {
		action: "provider", provider: "justworker", yes: true, force: true, dryRun: false,
	});
	assert.deepEqual(parseProviderConfigCommand(""), { action: "list" });
});

test("provider config removal edits only the selected model and creates a backup", async () => {
	const root = await tempRoot();
	const models = [
		"providers:",
		"  alpha:",
		"    baseUrl: https://alpha.test/v1",
		"    models:",
		"      - id: one",
		"        name: One",
		"      - id: two",
		"        name: Two",
		"  beta:",
		"    baseUrl: https://beta.test/v1",
		"",
	].join("\n");
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "models.yml"), models, "utf8");
	const result = await removeProviderConfig({ kind: "model", provider: "alpha", model: "one", yes: true }, { PI_CODING_AGENT_DIR: root });
	assert.equal(result.removed, "alpha/one");
	assert.ok(result.backupPath);
	const next = await fs.readFile(path.join(root, "models.yml"), "utf8");
	assert.doesNotMatch(next, /id: one/);
	assert.match(next, /id: two/);
	assert.match(next, /^  beta:/m);
	assert.equal((await fs.stat(result.backupPath!)).mode & 0o777, 0o600);
});

test("provider removal blocks references unless forced", async () => {
	const root = await tempRoot();
	await fs.mkdir(root, { recursive: true });
	await fs.writeFile(path.join(root, "models.yml"), "providers:\n  alpha:\n    models:\n      - id: one\n", "utf8");
	await fs.writeFile(path.join(root, "config.yml"), "modelRoles:\n  default: alpha/one\n", "utf8");
	await assert.rejects(
		removeProviderConfig({ kind: "provider", provider: "alpha", yes: true }, { PI_CODING_AGENT_DIR: root }),
		/referenced/,
	);
	assert.deepEqual(findProviderConfigReferences("default: alpha/one:max\n", { provider: "alpha", model: "one" }), ["default: alpha/one:max"]);
});

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-adaptive-queue-test-"));
	tempDirs.push(dir);
	return dir;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
		await sleepWithSignal(10);
	}
}

test("lane identity shares an endpoint only when the credential also matches", () => {
	const first = createLaneId({ provider: "one", baseUrl: "https://example.test/v1", apiKey: "same" });
	const alias = createLaneId({ provider: "two", baseUrl: "https://example.test/other", apiKey: "same" });
	const otherAccount = createLaneId({ provider: "one", baseUrl: "https://example.test/v1", apiKey: "different" });
	assert.equal(first, alias);
	assert.notEqual(first, otherAccount);
});

test("an explicit logical lane shares one provider account across routed endpoints", () => {
	const main = createLaneId({
		provider: "aiinput",
		baseUrl: "https://ai.input.im/v1",
		laneScope: "aiinput-account",
		apiKey: "same",
	});
	const edge = createLaneId({
		provider: "aiinput",
		baseUrl: "https://eo.input.codes/v1",
		laneScope: "aiinput-account",
		apiKey: "same",
	});
	const otherAccount = createLaneId({
		provider: "aiinput",
		baseUrl: "https://eo.input.codes/v1",
		laneScope: "aiinput-account",
		apiKey: "different",
	});
	assert.equal(main, edge);
	assert.notEqual(main, otherAccount);
});

test("transient concurrency limits remain distinct from provider-account failures", () => {
	assert.equal(
		isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "rate_limit_exceeded: Concurrency limit exceeded for account" }),
		true,
	);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "Too many pending requests, retry later" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "" }), true);
	assert.equal(isAdaptiveRateLimit({ errorMessage: "Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorMessage: "Error Code server_error: Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 500, errorMessage: "Error Code server_error: Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 502, errorMessage: "server_is_overloaded" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 504, errorMessage: "server_is_overloaded" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 524, errorMessage: "server_is_overloaded" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 502, errorMessage: "Concurrency limit exceeded for account" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "rate limit exceeded" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 504, errorMessage: "Too many pending requests" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "insufficient_quota: add credits" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "resource_exhausted: quota exceeded" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "model overloaded: no capacity" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "model unavailable" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 401, errorMessage: "Concurrency limit exceeded" }), false);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 401, errorMessage: "authentication failed" }), false);
});

test("retry-after hints are parsed without turning quota errors into queue waits", () => {
	assert.equal(retryAfterMsFromError({ errorMessage: "retry after 2.5 seconds" }), 2_500);
	assert.equal(retryAfterMsFromError({ errorMessage: "try again in 750ms" }), 750);
});

test("authentication, quota, billing and explicit model failures enter the provider retry class", () => {
	for (const error of [
		{ errorStatus: 401, errorMessage: "OAuth access token has been revoked" },
		{ errorStatus: 402, errorMessage: "billing balance exhausted" },
		{ errorStatus: 403, errorMessage: "Forbidden" },
		{ errorStatus: 429, errorMessage: "insufficient_quota: add credits" },
		{ errorStatus: 503, errorMessage: "model unavailable" },
		{ errorMessage: "no available route for this model" },
		{ errorMessage: "Error: 401 OAuth access token has been revoked" },
		{ errorMessage: "The quota has been exceeded." },
		{ errorMessage: "You exceeded your current quota, please check your plan and billing details." },
		{ errorMessage: "Insufficient funds." },
		{ errorMessage: "Your credit balance is too low to access the API." },
		{ errorMessage: "Billing hard limit has been reached." },
		{ errorMessage: "API key expired" },
		{ errorMessage: "credential revoked" },
		{ errorMessage: "Request failed with status code 401" },
		{ errorMessage: "HTTPError: 401 Client Error" },
		{ errorMessage: "error_code=401" },
		{ errorMessage: "status=403" },
		{ errorStatus: 404, errorMessage: "The model gpt-x does not exist or you do not have access to it" },
		{ errorStatus: 503, errorMessage: "Model gpt-x is unavailable" },
		{ errorStatus: 400, errorMessage: "The requested model is not supported" },
		{ errorStatus: 400, errorMessage: "invalid_request_error: model not supported with this account" },
		{ errorStatus: 503, errorMessage: "route unavailable" },
		{ errorStatus: 503, errorMessage: "no route available for this model" },
		{ errorStatus: 503, errorMessage: "capacity unavailable" },
		{ error: { type: "model_not_found", message: "Requested model was not found" } },
	]) {
		assert.equal(isAdaptiveProviderFailure(error), true);
	}
	for (const error of [
		{ errorStatus: 400, errorMessage: "invalid request schema" },
		{ errorStatus: 400, errorMessage: "max_tokens is invalid" },
		{ errorStatus: 400, errorMessage: "Invalid request: unbalanced delimiter" },
		{ errorStatus: 400, errorMessage: "Invalid prompt: billing address is malformed" },
		{ errorStatus: 400, errorMessage: "token count is invalid for this request" },
		{ errorStatus: 400, errorMessage: "invalid token count for this request" },
		{ errorStatus: 400, errorMessage: "unsupported model output format" },
		{ errorStatus: 400, errorMessage: "credit card field is invalid" },
		{ errorStatus: 404, errorMessage: "resource not found" },
		{ errorStatus: 503, errorMessage: "Service temporarily unavailable" },
		{ errorStatus: 503, errorMessage: "upstream unavailable" },
	]) {
		assert.equal(isAdaptiveProviderFailure(error), false);
	}
});

test("quota classification stays narrower than generic provider failures", () => {
	for (const error of [
		{ errorStatus: 403, errorMessage: "insufficient_user_quota: user quota is not enough" },
		{ errorStatus: 429, errorMessage: "insufficient_quota" },
		{ errorMessage: "billing balance exhausted" },
		{ errorMessage: "resource_exhausted" },
		{ errorStatus: 403, errorMessage: "用户额度不足, 剩余额度: $-0.65" },
	]) {
		assert.equal(isAdaptiveQuotaFailure(error), true);
	}
	for (const error of [
		{ errorStatus: 403, errorMessage: "Forbidden" },
		{ errorStatus: 401, errorMessage: "OAuth access token has been revoked" },
		{ errorMessage: "Codex stream ended before terminal completion event" },
	]) {
		assert.equal(isAdaptiveQuotaFailure(error), false);
	}
});

test("transport and generic upstream errors use distinct adaptive retry classes", () => {
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "Error Code stream_read_error: stream_read_error" }), true);
	assert.equal(isAdaptiveTransientTransport(new Error("socket connection was closed unexpectedly")), true);
	assert.equal(
		isAdaptiveTransientTransport(
			new Error(
				"Tool call was not executed because the provider stream ended with an error before the tool could run: The socket connection was closed unexpectedly",
			),
		),
		true,
	);
	assert.equal(
		isAdaptiveTransientTransport(new Error("Unable to connect. Is the computer able to access the url?")),
		true,
	);
	assert.equal(isAdaptiveTransientTransport(new Error("OpenAI responses stream timed out while waiting for the first event")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("responses stream ended without response.completed: missing_terminal")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("Anthropic stream envelope error: stream ended before message_stop")), true);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 502, errorMessage: "Bad gateway" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 504, errorMessage: "Gateway timeout" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 524, errorMessage: "524 status code (no body)" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 503, errorMessage: "stream_read_error" }), true);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 502, errorMessage: "socket connection was closed unexpectedly" }), true);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 500, errorMessage: "Internal server error" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 503, errorMessage: "model unavailable" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "model overloaded" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 502, errorMessage: "Bad gateway" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 504, errorMessage: "Gateway timeout" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 524, errorMessage: "524 status code (no body)" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "stream_read_error" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 502, errorMessage: "socket connection was closed unexpectedly" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 500, errorMessage: "Internal server error" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "model unavailable" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "authentication_error: credentials revoked" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "Our servers are currently overloaded" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "Concurrency limit exceeded" }), false);
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

test("tickets are ordered across queue instances and the next waiter wakes after release", async () => {
	const rootDir = await tempRoot();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const first = await firstQueue.acquire("lane");
	await sleepWithSignal(2);
	const second = await secondQueue.acquire("lane");
	assert.equal(await firstQueue.waitForTurn(first), 2);

	let secondReachedFront = false;
	const positions: Array<{ position: number; depth: number }> = [];
	const waiting = secondQueue.waitForTurn(second, undefined, position => positions.push(position)).then(() => {
		secondReachedFront = true;
	});
	await sleepWithSignal(30);
	assert.equal(secondReachedFront, false);
	await firstQueue.release(first);
	await waiting;
	assert.equal(secondReachedFront, true);
	assert.deepEqual(positions, [
		{ position: 2, depth: 2 },
		{ position: 1, depth: 1 },
	]);
	await secondQueue.release(second);
	assert.equal(await firstQueue.hasWaiters("lane"), false);
});

test("later tickets stay behind earlier tickets when process-relative clocks run backwards", async () => {
	const rootDir = await tempRoot();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	(firstQueue as unknown as { queueOrderFloor(): bigint }).queueOrderFloor = () => 200n;
	(secondQueue as unknown as { queueOrderFloor(): bigint }).queueOrderFloor = () => 100n;

	const first = await firstQueue.acquire("lane");
	const second = await secondQueue.acquire("lane");
	assert.ok(first.fileName < second.fileName);
	assert.equal(await firstQueue.position(first), 0);
	assert.equal(await secondQueue.position(second), 1);
	await firstQueue.release(first);
	await secondQueue.release(second);
});

test("new queue ordering remains behind a live legacy hrtime ticket", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	await fs.mkdir(laneDir, { recursive: true });
	const legacyName = "00000000000000000999-0000000001-00000001-legacy.ticket";
	await fs.writeFile(path.join(laneDir, legacyName), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	(queue as unknown as { queueOrderFloor(): bigint }).queueOrderFloor = () => 1n;

	const ticket = await queue.acquire("lane");
	assert.ok(ticket.fileName > legacyName);
	await queue.release(ticket);
	await fs.unlink(path.join(laneDir, legacyName));
});

test("a stabilized front ticket stays ahead when a legacy process publishes later", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	(queue as unknown as { queueOrderFloor(): bigint }).queueOrderFloor = () => 200n;
	const ticket = await queue.acquire("lane");
	await queue.waitForTurn(ticket);
	assert.match(ticket.fileName, /^00000000000000000000-/);

	const legacyName = "00000000000000000100-0000000001-00000001-late-legacy.ticket";
	await fs.writeFile(path.join(laneDir, legacyName), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
	assert.equal(await queue.position(ticket), 0);
	await queue.release(ticket);
	await fs.unlink(path.join(laneDir, legacyName));
});

test("new waiters use low lane orders so a later legacy ticket stays behind", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const owner = await queue.acquire("lane");
	await queue.waitForTurn(owner);
	const waiter = await queue.acquire("lane");

	const legacyName = "00000000000000000100-0000000001-00000001-late-legacy.ticket";
	await fs.writeFile(path.join(laneDir, legacyName), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
	assert.equal(await queue.position(owner), 0);
	assert.equal(await queue.position(waiter), 1);
	await queue.release(owner);
	await queue.release(waiter);
	await fs.unlink(path.join(laneDir, legacyName));
});

async function assertQueueFilePublicationIsSerialized(suffix: ".ticket" | ".state-lock"): Promise<void> {
	const rootDir = await tempRoot();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, random: () => 0 });
	const firstReachedWrite = Promise.withResolvers<void>();
	const allowFirstWrite = Promise.withResolvers<void>();
	type QueueInternals = {
		createQueueFile(laneId: string, targetSuffix: string): Promise<Awaited<ReturnType<AdaptiveProviderQueue["acquire"]>>>;
		waitForQueueFileTurn(
			ticket: Awaited<ReturnType<AdaptiveProviderQueue["acquire"]>>,
			targetSuffix: string,
		): Promise<number>;
		writeQueueFile(filePath: string, payload: string): Promise<void>;
	};
	const firstInternals = firstQueue as unknown as QueueInternals;
	const secondInternals = secondQueue as unknown as QueueInternals;
	const writeQueueFile = firstInternals.writeQueueFile.bind(firstQueue);
	firstInternals.writeQueueFile = async (filePath, payload) => {
		firstReachedWrite.resolve();
		await allowFirstWrite.promise;
		await writeQueueFile(filePath, payload);
	};

	const firstAcquire = firstInternals.createQueueFile("lane", suffix);
	await firstReachedWrite.promise;
	let secondPublished = false;
	const secondAcquire = secondInternals.createQueueFile("lane", suffix).then(ticket => {
		secondPublished = true;
		return ticket;
	});
	try {
		await sleepWithSignal(30);
		assert.equal(secondPublished, false);
	} finally {
		allowFirstWrite.resolve();
	}

	const [first, second] = await Promise.all([firstAcquire, secondAcquire]);
	assert.ok(first.fileName < second.fileName);
	assert.equal(await firstInternals.waitForQueueFileTurn(first, suffix), 2);
	let secondReachedFront = false;
	const waiting = secondInternals.waitForQueueFileTurn(second, suffix).then(() => {
		secondReachedFront = true;
	});
	await sleepWithSignal(30);
	assert.equal(secondReachedFront, false);
	await firstQueue.release(first);
	await waiting;
	assert.equal(secondReachedFront, true);
	await secondQueue.release(second);
}

test("ticket publication is serialized before sortable names become visible", async () => {
	await assertQueueFilePublicationIsSerialized(".ticket");
});

test("state-lock publication is serialized before sortable names become visible", async () => {
	await assertQueueFilePublicationIsSerialized(".state-lock");
});

test("a live ticket is not reaped only because its heartbeat timestamp is old", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 1_000, random: () => 0 });
	const ticket = await queue.acquire("lane");
	if (ticket.heartbeat) clearInterval(ticket.heartbeat);
	ticket.heartbeat = undefined;
	const old = new Date(Date.now() - 5_000);
	await fs.utimes(ticket.filePath, old, old);
	assert.equal(await queue.hasWaiters("lane"), true);
	assert.equal(await queue.position(ticket), 0);
	await queue.release(ticket);
});

test("a live publication gate is preserved even when its timestamp is old", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	const gatePath = path.join(laneDir, ".queue-publication.lock");
	await fs.mkdir(laneDir, { recursive: true });
	await fs.writeFile(gatePath, JSON.stringify({ pid: process.pid, token: "live-owner" }));
	const old = new Date(Date.now() - 5_000);
	await fs.utimes(gatePath, old, old);

	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 1_000, random: () => 0 });
	let acquired = false;
	const pending = queue.acquire("lane").then(ticket => {
		acquired = true;
		return ticket;
	});
	await sleepWithSignal(30);
	assert.equal(acquired, false);
	await fs.unlink(gatePath);
	const ticket = await pending;
	await queue.release(ticket);
});

test("an old incomplete publication gate is reclaimed", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	const gatePath = path.join(laneDir, ".queue-publication.lock");
	await fs.mkdir(laneDir, { recursive: true });
	await fs.writeFile(gatePath, "");
	const old = new Date(Date.now() - 5_000);
	await fs.utimes(gatePath, old, old);

	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 1_000, random: () => 0 });
	const ticket = await queue.acquire("lane");
	await queue.release(ticket);
	await assert.rejects(fs.stat(gatePath), error => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("a failed coordination-file write releases its publication gate", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 1_000, random: () => 0 });
	const internals = queue as unknown as {
		writeQueueFile(filePath: string, payload: string): Promise<void>;
	};
	const writeQueueFile = internals.writeQueueFile.bind(queue);
	internals.writeQueueFile = async () => {
		throw new Error("simulated coordination write failure");
	};
	await assert.rejects(queue.acquire("lane"), /simulated coordination write failure/);
	internals.writeQueueFile = writeQueueFile;

	const ticket = await queue.acquire("lane");
	await queue.release(ticket);
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

test("retry attempts are shared when the next ticket takes over an active campaign", async () => {
	const rootDir = await tempRoot();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const first = await firstQueue.acquire("lane");
	await firstQueue.waitForTurn(first);
	assert.deepEqual(
		await firstQueue.recordRetryFailure(first, { maxRetries: 50, kind: "rate-limit" }),
		{ status: "retry", attempt: 1, maxRetries: 50, delayMs: 0 },
	);
	await firstQueue.release(first);

	const second = await secondQueue.acquire("lane");
	await secondQueue.waitForTurn(second);
	const takeover = await secondQueue.waitForRetryWindow(second);
	assert.equal(takeover.status, "ready");
	assert.equal(takeover.status === "ready" && takeover.claimed, true);
	assert.equal(takeover.status === "ready" && takeover.state?.attempt, 1);
	assert.deepEqual(
		await secondQueue.recordRetryFailure(second, { maxRetries: 10, kind: "transport" }),
		{ status: "retry", attempt: 2, maxRetries: 50, delayMs: 0 },
	);
	await secondQueue.release(second);
});

test("exhaustion persists for later tickets without resetting or incrementing the counter", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const owner = await queue.acquire("lane");
	await queue.waitForTurn(owner);
	assert.equal((await queue.recordRetryFailure(owner, { maxRetries: 1, kind: "rate-limit" })).status, "retry");
	assert.deepEqual(
		await queue.recordRetryFailure(owner, { maxRetries: 1, kind: "transport" }),
		{ status: "exhausted", attempt: 1, maxRetries: 1 },
	);
	await queue.release(owner);

	const follower = await queue.acquire("lane");
	await queue.waitForTurn(follower);
	const exhausted = await queue.waitForRetryWindow(follower);
	assert.equal(exhausted.status, "exhausted");
	assert.equal(exhausted.state.attempt, 1);
	assert.equal(exhausted.state.maxRetries, 1);
	assert.deepEqual(
		await queue.recordRetryFailure(follower, { maxRetries: 50, kind: "rate-limit" }),
		{ status: "exhausted", attempt: 1, maxRetries: 1 },
	);
	await queue.release(follower);
});

test("a successful probe clears the lane retry state", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const ticket = await queue.acquire("lane");
	await queue.waitForTurn(ticket);
	await queue.recordRetryFailure(ticket, { maxRetries: 50, kind: "rate-limit" });
	assert.equal((await queue.getRetryState("lane"))?.attempt, 1);
	await queue.clearRetryState(ticket);
	assert.equal(await queue.getRetryState("lane"), undefined);
	await queue.release(ticket);
});

test("a recovery marker only classifies attempts that started before the successful recovery", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const owner = await queue.acquire("lane");
	await queue.waitForTurn(owner);
	await queue.recordRetryFailure(owner, { maxRetries: 50, kind: "rate-limit" });
	const staleAttempt = await queue.captureRetryAttempt("lane");
	await queue.clearRetryState(owner);
	await queue.release(owner);

	const staleFollower = await queue.acquire("lane");
	await queue.waitForTurn(staleFollower);
	const staleWindow = await queue.waitForRetryWindow(staleFollower, undefined, staleAttempt);
	assert.equal(staleWindow.status === "ready" && staleWindow.recoveredSinceRequest, true);
	await queue.release(staleFollower);

	const freshAttempt = await queue.captureRetryAttempt("lane");
	const freshFollower = await queue.acquire("lane");
	await queue.waitForTurn(freshFollower);
	const freshWindow = await queue.waitForRetryWindow(freshFollower, undefined, freshAttempt);
	assert.equal(freshWindow.status === "ready" && freshWindow.recoveredSinceRequest, false);
	await queue.release(freshFollower);
});

test("version-one recovery markers remain readable during a rolling upgrade", async () => {
	const rootDir = await tempRoot();
	const laneDir = path.join(rootDir, "lane");
	await fs.mkdir(laneDir, { recursive: true });
	await fs.writeFile(
		path.join(laneDir, "retry-recovery.json"),
		JSON.stringify({
			version: 1,
			recoveredAt: 123,
			recoveredAtNs: "456",
			expiresAt: Date.now() + 60_000,
		}),
	);
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10 });
	assert.equal((await queue.captureRetryAttempt("lane")).recoveryGeneration, "legacy:123:456");
});

test("new recovery markers remain readable by a version-one process during reload", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, random: () => 0 });
	const ticket = await queue.acquire("lane");
	await queue.waitForTurn(ticket);
	await queue.recordRetryFailure(ticket, { maxRetries: 50, kind: "transport" });
	const requestStartedAt = { wallMs: Date.now(), monotonicNs: process.hrtime.bigint() };
	await queue.clearRetryState(ticket);

	const marker = JSON.parse(
		await fs.readFile(path.join(rootDir, "lane", "retry-recovery.json"), "utf8"),
	) as { version: unknown; recoveredAt: unknown; recoveredAtNs: unknown; generation: unknown };
	assert.equal(marker.version, 1);
	assert.equal(typeof marker.generation, "string");
	assert.equal(typeof marker.recoveredAtNs, "string");
	assert.equal(
		typeof marker.recoveredAt === "number" &&
			marker.recoveredAt >= requestStartedAt.wallMs &&
			BigInt(marker.recoveredAtNs as string) > requestStartedAt.monotonicNs,
		true,
	);
	await queue.release(ticket);
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

test("the next process claims retry state after the probe owner exits", async () => {
	const rootDir = await tempRoot();
	const childPath = path.join(import.meta.dirname, "retry-owner-child.ts");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", childPath, rootDir, "crash-lane"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", code => {
			if (code === 0) resolve();
			else reject(new Error(`retry owner child exited ${code}: ${stderr}`));
		});
	});

	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 5_000, baseDelayMs: 0, maxDelayMs: 0 });
	const successor = await queue.acquire("crash-lane");
	await queue.waitForTurn(successor);
	const takeover = await queue.waitForRetryWindow(successor);
	assert.equal(takeover.status, "ready");
	assert.equal(takeover.status === "ready" && takeover.claimed, true);
	assert.equal(takeover.status === "ready" && takeover.state?.attempt, 1);
	assert.equal((await queue.getRetryState("crash-lane"))?.ownerFileName, successor.fileName);
	await queue.release(successor);
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

function abortableHangingInput(signal?: AbortSignal) {
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise<never>((_resolve, reject) => {
				const rejectFromSignal = () => reject(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
				if (signal?.aborted) rejectFromSignal();
				else signal?.addEventListener("abort", rejectFromSignal, { once: true });
			});
		},
		async result() {
			return assistant();
		},
	};
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

const ROUTED_AIINPUT_ENDPOINTS = AIINPUT_ENDPOINTS.map(endpoint => endpoint.baseUrl);

interface RoutedRetryObservation {
	attempt: number;
	baseUrl: string;
	excluded: string[];
}

interface RoutedRetryRun {
	observations: RoutedRetryObservation[];
	rankedBaseUrls: string[];
}

type RoutedFailure =
	| { kind: "event"; error: unknown }
	| { kind: "throw"; error: unknown };

async function runRoutedRetry(
	failures: readonly RoutedFailure[],
	pinnedBaseUrl?: string,
): Promise<RoutedRetryRun> {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0, random: () => 0 });
	const router = new AiInputEndpointRouter({
		stateDir: path.join(rootDir, "router"),
		probeIntervalMs: 60_000,
		proxyUrl: "",
		fetchImpl: async input => {
			const baseUrl = String(input).replace(/\/models$/, "");
			const index = ROUTED_AIINPUT_ENDPOINTS.indexOf(baseUrl as (typeof ROUTED_AIINPUT_ENDPOINTS)[number]);
			await sleepWithSignal((index + 1) * 5);
			return new Response();
		},
	});
	await router.selectEndpoint({ apiKey: "test-key", forceRefresh: true });
	const rankedBaseUrls = (await router.snapshot()).endpoints
		.filter(endpoint => endpoint.score !== undefined)
		.sort((left, right) => (left.score ?? Infinity) - (right.score ?? Infinity))
		.map(endpoint => endpoint.baseUrl);
	assert.equal(rankedBaseUrls.length, ROUTED_AIINPUT_ENDPOINTS.length);
	const observations: RoutedRetryObservation[] = [];
	let requestCount = 0;
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const output = createAdaptiveStream({
		model: {
			provider: "aiinput",
			id: "gpt-5.6-sol",
			baseUrl: ROUTED_AIINPUT_ENDPOINTS[0],
		},
		requestOptions: { apiKey: "test-key" },
		queue,
		maxRetries: failures.length,
		endpointPoolSize: ROUTED_AIINPUT_ENDPOINTS.length,
		rotateEndpointOnError: error => isAdaptiveTransientTransport(error) || isAdaptiveTransientUpstream(error),
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: async (_signal, context) => {
			if (!context) throw new Error("adaptive attempt context was not provided");
			const excluded = [...context.excludeBaseUrls];
			const routed = await router.routeModel(
				{ provider: "aiinput", id: "gpt-5.6-sol", baseUrl: ROUTED_AIINPUT_ENDPOINTS[0] },
				{ apiKey: "test-key", exclude: context.excludeBaseUrls, pinnedBaseUrl },
			);
			if (!routed.baseUrl) throw new Error("AI Input router did not select a base URL");
			const baseUrl = routed.baseUrl;
			context.setBaseUrl(baseUrl);
			observations.push({ attempt: context.number, baseUrl, excluded });
			const failure = failures[requestCount++];
			if (failure?.kind === "throw") throw failure.error;
			if (failure?.kind === "event") {
				return new FakeInputStream([{ type: "error", reason: "error", error: failure.error }]);
			}
			return new FakeInputStream([
				{ type: "start", partial: succeeded },
				{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
				{ type: "done", reason: "stop", message: succeeded },
			]);
		},
	});

	try {
		await output.completion.promise;
		assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
		return { observations, rankedBaseUrls };
	} finally {
		router.stop();
	}
}

test("transport and generic 502/503/504/524 failures exclude the current URL before retrying", async () => {
	for (const failure of [
		{
			kind: "event",
			error: new Error(
				"Tool call was not executed because the provider stream ended with an error before the tool could run: The socket connection was closed unexpectedly",
			),
		},
		{ kind: "event", error: assistant({ errorStatus: 502, errorMessage: "Bad gateway" }) },
		{ kind: "event", error: assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }) },
		{ kind: "throw", error: assistant({ errorStatus: 504, errorMessage: "Gateway timeout" }) },
		{ kind: "event", error: assistant({ errorStatus: 524, errorMessage: "524 status code (no body)" }) },
		{ kind: "throw", error: new Error("fetch failed: ECONNRESET") },
	] satisfies readonly RoutedFailure[]) {
		const { observations, rankedBaseUrls } = await runRoutedRetry([failure]);
		assert.equal(observations.length, 2);
		assert.equal(observations[0].baseUrl, rankedBaseUrls[0]);
		assert.deepEqual(observations[0].excluded, []);
		assert.equal(observations[1].baseUrl, rankedBaseUrls[1]);
		assert.deepEqual(observations[1].excluded, [rankedBaseUrls[0]]);
	}
});

test("429 authentication and quota failures stay on the current URL", async () => {
	const { observations, rankedBaseUrls } = await runRoutedRetry([
		{ kind: "event", error: assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" }) },
		{ kind: "throw", error: assistant({ errorStatus: 401, errorMessage: "OAuth access token has been revoked" }) },
		{ kind: "event", error: assistant({ errorStatus: 402, errorMessage: "billing balance exhausted" }) },
	]);
	assert.equal(observations.length, 4);
	assert.deepEqual(observations.map(observation => observation.baseUrl), Array(4).fill(rankedBaseUrls[0]));
	assert.ok(observations.every(observation => observation.excluded.length === 0));
});

test("a session pin keeps Retry on one URL even after transport and upstream exclusions", async () => {
	const pinnedBaseUrl = ROUTED_AIINPUT_ENDPOINTS[1];
	const { observations } = await runRoutedRetry([
		{ kind: "event", error: new Error("socket connection was closed unexpectedly") },
		{ kind: "event", error: assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }) },
	], pinnedBaseUrl);
	assert.deepEqual(observations.map(observation => observation.baseUrl), Array(3).fill(pinnedBaseUrl));
	assert.deepEqual(observations.map(observation => observation.excluded), [
		[],
		[pinnedBaseUrl],
		[pinnedBaseUrl],
	]);
});

test("excluding all three URLs resets the request-local endpoint cycle", async () => {
	const { observations, rankedBaseUrls } = await runRoutedRetry([
		{ kind: "event", error: assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }) },
		{ kind: "event", error: assistant({ errorStatus: 502, errorMessage: "Bad gateway" }) },
		{ kind: "event", error: assistant({ errorStatus: 504, errorMessage: "Gateway timeout" }) },
	]);
	assert.deepEqual(observations.map(observation => observation.baseUrl), [
		...rankedBaseUrls,
		rankedBaseUrls[0],
	]);
	assert.deepEqual(observations.map(observation => observation.excluded), [
		[],
		[rankedBaseUrls[0]],
		[rankedBaseUrls[0], rankedBaseUrls[1]],
		[],
	]);
});

function rejectSharedRetryCalls(queue: AdaptiveProviderQueue): string[] {
	const calls: string[] = [];
	const methods = [
		"hasWaiters",
		"getRetryState",
		"acquire",
		"position",
		"waitForTurn",
		"captureRetryAttempt",
		"waitForRetryWindow",
		"recordRetryFailure",
		"markRetryStateExhausted",
		"clearRetryState",
		"clearRetryStateSnapshot",
		"release",
	] as const;
	const target = queue as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const method of methods) {
		target[method] = async () => {
			calls.push(method);
			throw new Error(`isolated retry called shared queue method: ${method}`);
		};
	}
	return calls;
}

test("retries default to a local budget without touching shared recovery state", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const limited = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: limited }]),
		new FakeInputStream([
			{ type: "start", partial: succeeded },
			{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
			{ type: "done", reason: "stop", message: succeeded },
		]),
	];
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
		onProgress: value => progress.push(value),
	});

	await output.completion.promise;
	await waitUntil(async () => progress.at(-1) === undefined);
	assert.deepEqual(sharedCalls, []);
	assert.equal(attempts.length, 0);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
	assert.equal(
		progress.some(value =>
			value?.attempt === 1 &&
			value.kind === "rate-limit" &&
			value.queuePosition === undefined &&
			value.queueDepth === undefined
		),
		true,
	);
	assert.equal(progress.at(-1), undefined);
});

test("simultaneous isolated streams keep separate counters and create no coordination files", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const limited = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const firstAttemptsReady = Promise.withResolvers<void>();
	let firstAttemptsStarted = 0;
	const loggedAttempts: number[] = [];
	const makeFactory = () => {
		let calls = 0;
		return {
			get calls() {
				return calls;
			},
			create(): FakeInputStream | AsyncIterable<{ type: string; error?: Record<string, unknown> }> & { result(): Promise<Record<string, unknown>> } {
				calls += 1;
				if (calls > 1) {
					return new FakeInputStream([
						{ type: "start", partial: succeeded },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
						{ type: "done", reason: "stop", message: succeeded },
					]);
				}
				return {
					async *[Symbol.asyncIterator]() {
						firstAttemptsStarted += 1;
						if (firstAttemptsStarted === 2) firstAttemptsReady.resolve();
						await firstAttemptsReady.promise;
						yield { type: "start" };
						yield { type: "error", error: limited };
					},
					async result() {
						return limited;
					},
				};
			},
		};
	};
	const firstFactory = makeFactory();
	const secondFactory = makeFactory();
	const createOutput = (factory: ReturnType<typeof makeFactory>) =>
		createAdaptiveStream({
			model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
			requestOptions: { apiKey: "test" },
			queue,
			maxRetries: 1,
			sharedRetryRecovery: false,
			createOutputStream: () => new FakeOutputStream(),
			createInputStream: () => factory.create(),
			logger: {
				warn(message, fields) {
					if (message === "adaptive provider isolated retry caught retryable error") {
						loggedAttempts.push(Number(fields?.attempt));
					}
				},
			},
		});

	const firstOutput = createOutput(firstFactory);
	const secondOutput = createOutput(secondFactory);
	await Promise.all([firstOutput.completion.promise, secondOutput.completion.promise]);

	assert.deepEqual(sharedCalls, []);
	assert.equal(firstFactory.calls, 2);
	assert.equal(secondFactory.calls, 2);
	assert.deepEqual(loggedAttempts, [1, 1]);
	assert.deepEqual(await fs.readdir(rootDir), []);
});

test("isolated retries forward the final error after the local budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const failed = assistant({ errorMessage: "Error Code stream_read_error: stream_read_error" });
	let attempts = 0;
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		retryTransientUpstream5xx: false,
		sharedRetryRecovery: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: failed }]);
		},
		onProgress: value => progress.push(value),
	});

	await output.completion.promise;
	await waitUntil(async () => progress.at(-1) === undefined);
	assert.deepEqual(sharedCalls, []);
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error, failed);
	assert.deepEqual(
		progress.filter((value): value is AdaptiveRetryProgress => value !== undefined).map(value => value.attempt),
		[1, 1, 2, 2, 2],
	);
	assert.equal(
		progress.filter(value => value !== undefined).every(value =>
			value.queuePosition === undefined && value.queueDepth === undefined
		),
		true,
	);
	assert.equal(progress.at(-1), undefined);
});

test("retry-stop reports a structured terminal error after the local retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const failed = assistant({
		role: "assistant",
		api: "openai-responses",
		provider: "primary",
		model: "model",
		errorStatus: 503,
		errorId: 12345,
		errorMessage: "Service temporarily unavailable",
		usage: { input: 7, output: 0 },
	});
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", api: "openai-responses", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		transientUpstream5xxMode: "retry-stop",
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: failed }]);
		},
	});

	await output.completion.promise;
	assert.deepEqual(sharedCalls, []);
	assert.equal(attempts, 3);
	assert.deepEqual(output.events.map(event => event.type), ["error"]);
	const stopped = output.events[0];
	assert.equal(stopped.reason, "error");
	assert.equal(stopped.error.stopReason, "error");
	assert.equal(stopped.error.errorMessage, adaptiveRetryStopMessage(2));
	assert.equal(stopped.error.errorId, ADAPTIVE_TERMINAL_ABORT_ERROR_ID);
	assert.equal(stopped.error.errorMessage.startsWith(ADAPTIVE_RETRY_EXHAUSTED_CODE), true);
	assert.equal(stopped.error.provider, "primary");
	assert.equal(stopped.error.model, "model");
	assert.equal(stopped.error.content.length, 1);
	assert.match(stopped.error.content[0].text, /provider: primary/);
	assert.match(stopped.error.content[0].text, /status: 503/);
	assert.match(stopped.error.content[0].text, /last_error: Service temporarily unavailable/);
	assert.deepEqual(stopped.error.usage, { input: 7, output: 0 });
	assert.equal("errorStatus" in stopped.error, false);
	assert.equal(stopped.adaptiveRetry.code, ADAPTIVE_RETRY_EXHAUSTED_CODE);
});

test("retry-stop also suppresses fallback when a retryable failure is thrown", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = { errorMessage: "socket connection was closed unexpectedly" };
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", api: "openai-responses", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		transientUpstream5xxMode: "retry-stop",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			throw failed;
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 2);
	assert.equal(output.events[0].reason, "error");
	assert.equal(output.events[0].error.errorMessage, adaptiveRetryStopMessage(1));
	assert.equal(output.events[0].error.stopReason, "error");
});

test("retry-stop retries OMP's normalized unable-to-connect stream error", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({ errorMessage: "Unable to connect. Is the computer able to access the url?" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", api: "openai-responses", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		transientUpstream5xxMode: "retry-stop",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: failed }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 2);
	assert.equal(output.events.length, 1);
	assert.equal(output.events[0].reason, "error");
	assert.equal(output.events[0].error.errorMessage, adaptiveRetryStopMessage(1));
});

test("retry-stop never replays or sanitizes a thrown failure that already contains substantive output", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const partial = assistant({
		errorMessage: "socket connection was closed unexpectedly",
		content: [{ type: "text", text: "already emitted" }],
	});
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", api: "openai-responses", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		transientUpstream5xxMode: "retry-stop",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			throw partial;
		},
	});

	await assert.rejects(output.completion.promise, error => error === partial);
	assert.equal(attempts, 1);
	assert.equal(output.events.length, 0);
});

test("retry-stop lets user cancellation win when a thrown failure exhausts the retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const controller = new AbortController();
	const failed = { errorMessage: "socket connection was closed unexpectedly" };
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", api: "openai-responses", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test", signal: controller.signal },
		queue,
		maxRetries: 1,
		transientUpstream5xxMode: "retry-stop",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			throw failed;
		},
		onProgress: progress => {
			if (attempts === 2 && progress?.phase === "backoff") controller.abort();
		},
	});

	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	assert.equal(attempts, 2);
	assert.equal(output.events.length, 0);
});

test("retry-stop retries authentication failures and stops without fallback after exhaustion", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const authFailure = assistant({ errorStatus: 401, errorMessage: "OAuth access token has been revoked" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		transientUpstream5xxMode: "retry-stop",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: authFailure }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error.stopReason, "error");
	assert.equal(output.events.at(-1).error.errorMessage, adaptiveRetryStopMessage(2));
	assert.equal(output.events.at(-1).reason, "error");
});

test("account-provider quota failures forward to OMP fallback immediately", async () => {
	for (const provider of ["agentrouter", "agentrouter-2", "agentrouter-3", "justworker", "justworker-2", "justworker-3"]) {
		const rootDir = await tempRoot();
		const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
		const quotaFailure = assistant({
			errorStatus: 403,
			errorMessage: "user quota is not enough (insufficient_user_quota)",
		});
		let attempts = 0;
		const output = createAdaptiveStream({
			model: { provider, id: "gpt-5.6-sol", baseUrl: "https://agentrouter.org" },
			requestOptions: { apiKey: "test" },
			queue,
			maxRetries: 50,
			transientUpstream5xxMode: "retry-stop",
			forwardQuotaToFallback: true,
			createOutputStream: () => new FakeOutputStream(),
			createInputStream: () => {
				attempts += 1;
				return new FakeInputStream([{ type: "error", reason: "error", error: quotaFailure }]);
			},
		});

		await output.completion.promise;
		assert.equal(attempts, 1, provider);
		assert.equal(output.events.at(-1).error, quotaFailure, provider);
		assert.equal(output.events.at(-1).reason, "error", provider);
	}
});

test("terminal retry report redacts credentials and bounds provider details", () => {
	const report = adaptiveRetryExhaustedReport(
		{
			provider: "primary",
			model: "model",
			errorStatus: 503,
			errorMessage: `Bearer sk-secret-token-1234567890 ${"x".repeat(2000)}`,
		},
		{ provider: "primary", id: "model" },
		50,
	);
	assert.match(report, /ADAPTIVE_RETRY_EXHAUSTED/);
	assert.match(report, /\[REDACTED\]/);
	assert.doesNotMatch(report, /sk-secret-token/);
	assert.ok(report.length < 1_200);
});

test("retry mode forwards quota failures only after the retry budget is exhausted", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const quotaFailure = assistant({ errorStatus: 429, errorMessage: "insufficient_quota: add credits" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		transientUpstream5xxMode: "retry",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: quotaFailure }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error, quotaFailure);
	assert.equal(output.events.at(-1).reason, "error");
});

test("fallback mode still gives authentication failures the 50-retry campaign", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const authFailure = assistant({ errorStatus: 403, errorMessage: "Forbidden" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		transientUpstream5xxMode: "fallback",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: authFailure }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 2);
	assert.equal(output.events.at(-1).error, authFailure);
});

test("retry-5m keeps model failures on the 50-retry budget rather than its wall-clock window", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const modelFailure = assistant({ errorStatus: 503, errorMessage: "no capacity for model" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 0,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: modelFailure }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error, modelFailure);
});

test("retry-5m keeps 503 authentication failures on the 50-retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const authFailure = assistant({ errorStatus: 503, errorMessage: "authentication_error: credentials revoked" });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 0,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: authFailure }]);
		},
	});

	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.at(-1).error, authFailure);
});

test("isolated retry backoff honors cancellation without touching shared recovery state", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 1_000, maxDelayMs: 1_000 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const controller = new AbortController();
	const failed = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test", signal: controller.signal },
		queue,
		sharedRetryRecovery: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () =>
			new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: failed }]),
		onProgress: value => progress.push(value),
	});

	await waitUntil(async () => progress.some(value => value?.phase === "backoff" && value.attempt === 1));
	controller.abort();
	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	await waitUntil(async () => progress.at(-1) === undefined);
	assert.deepEqual(sharedCalls, []);
	assert.equal(
		progress.filter(value => value !== undefined).every(value =>
			value.queuePosition === undefined && value.queueDepth === undefined
		),
		true,
	);
});

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
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	let progressFailureInjected = false;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
		onProgress: value => {
			progress.push(value);
			if (value && !progressFailureInjected) {
				progressFailureInjected = true;
				throw new Error("temporary retry status failure");
			}
		},
	});
	await output.completion.promise;
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
	assert.equal(attempts.length, 0);
	assert.equal(progress.some(value => value?.attempt === 1 && value.kind === "rate-limit"), true);
	assert.equal(progress.at(-1), undefined);
	assert.equal(progressFailureInjected, true);
});

test("successful substantive output clears a retry campaign inherited from another window", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const probeQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "rate-limit" });
	await ownerQueue.release(owner);

	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: probeQueue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () =>
			new FakeInputStream([
				{ type: "start", partial: succeeded },
				{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
				{ type: "done", reason: "stop", message: succeeded },
			]),
	});
	await output.completion.promise;
	assert.equal(await probeQueue.getRetryState(laneId), undefined);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("a generic 503 continues an inherited retry campaign instead of exhausting it at one of fifty", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const probeQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "transport", status: 503 });
	await ownerQueue.release(owner);

	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([
			{ type: "start", partial: assistant() },
			{ type: "error", reason: "error", error: unavailable },
		]),
		new FakeInputStream([
			{ type: "start", partial: succeeded },
			{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
			{ type: "done", reason: "stop", message: succeeded },
		]),
	];
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: probeQueue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});

	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.equal(await probeQueue.getRetryState(laneId), undefined);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("a generic 503 uses adaptive retry by default", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: unavailable }]),
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
		maxRetries: 1,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});

	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("retry-5m retries a generic 524 only until its wall-clock window expires", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 30, maxDelayMs: 30, random: () => 0 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const unavailable = assistant({ errorStatus: 524, errorMessage: "524 status code (no body)" });
	let upstreamCalls = 0;
	let clockMs = 0;
	const sleeps: number[] = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 50,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 100,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "error", reason: "error", error: unavailable },
			]);
		},
		now: () => clockMs,
		sleep: async delayMs => {
			sleeps.push(delayMs);
			clockMs += delayMs;
		},
	});

	await output.completion.promise;
	assert.deepEqual(sharedCalls, []);
	assert.equal(upstreamCalls, 4);
	assert.deepEqual(sleeps, [30, 30, 30, 10]);
	assert.equal(output.events.at(-1).error, unavailable);
});

test("retry-5m keeps the current provider when generic 5xx recovers inside the window", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 20, maxDelayMs: 20, random: () => 0 });
	const unavailable = assistant({ errorStatus: 502, errorMessage: "Bad gateway" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	let upstreamCalls = 0;
	let clockMs = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 100,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return upstreamCalls < 3
				? new FakeInputStream([{ type: "error", reason: "error", error: unavailable }])
				: new FakeInputStream([
						{ type: "start", partial: succeeded },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
						{ type: "done", reason: "stop", message: succeeded },
					]);
		},
		now: () => clockMs,
		sleep: async delayMs => {
			clockMs += delayMs;
		},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 3);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("retry-5m applies the same deadline when generic 5xx is thrown before streaming", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 25, maxDelayMs: 25, random: () => 0 });
	const unavailable = assistant({ errorStatus: 504, errorMessage: "Gateway timeout" });
	let upstreamCalls = 0;
	let clockMs = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 60,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			throw unavailable;
		},
		now: () => clockMs,
		sleep: async delayMs => {
			clockMs += delayMs;
		},
	});

	await assert.rejects(output.completion.promise, error => error === unavailable);
	assert.equal(upstreamCalls, 3);
});

test("retry-5m cancellation stops before fallback and never touches shared state", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 1_000, maxDelayMs: 1_000 });
	const sharedCalls = rejectSharedRetryCalls(queue);
	const controller = new AbortController();
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test", signal: controller.signal },
		queue,
		transientUpstream5xxMode: "retry-5m",
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
		},
		onProgress: value => progress.push(value),
	});

	await waitUntil(async () => progress.some(value => value?.phase === "backoff"));
	controller.abort();
	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	assert.deepEqual(sharedCalls, []);
	assert.equal(upstreamCalls, 1);
	assert.equal(output.events.some(event => event.type === "error"), false);
});

test("retry-5m aborts an in-flight retry at the deadline and forwards the last 503 event", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	let upstreamCalls = 0;
	let retrySignal: AbortSignal | undefined;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 20,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: signal => {
			upstreamCalls += 1;
			if (upstreamCalls === 1) {
				return new FakeInputStream([
					{ type: "start", partial: assistant() },
					{ type: "error", reason: "error", error: unavailable },
				]);
			}
			retrySignal = signal;
			return abortableHangingInput(signal);
		},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 2);
	assert.equal(retrySignal?.aborted, true);
	assert.deepEqual(output.events.map(event => event.type), ["start", "error"]);
	assert.equal(output.events.at(-1).error, unavailable);
});

test("retry-5m preserves a thrown 504 when an in-flight retry reaches the deadline", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 504, errorMessage: "Gateway timeout" });
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 20,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: signal => {
			upstreamCalls += 1;
			if (upstreamCalls === 1) throw unavailable;
			return abortableHangingInput(signal);
		},
	});

	await assert.rejects(output.completion.promise, error => error === unavailable);
	assert.equal(upstreamCalls, 2);
});

test("retry-5m does not start another request when the wall clock expires before timer dispatch", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 20, maxDelayMs: 20, random: () => 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	let upstreamCalls = 0;
	let clockMs = 0;
	const scheduledDelays: number[] = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 100,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			if (upstreamCalls > 1) throw new Error("request started after the retry deadline");
			return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
		},
		now: () => clockMs,
		sleep: async delayMs => {
			clockMs += delayMs;
		},
		scheduleTimeout: (_callback, delayMs) => {
			scheduledDelays.push(delayMs);
			clockMs += delayMs;
			return () => {};
		},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 1);
	assert.deepEqual(scheduledDelays, [80]);
	assert.equal(output.events.at(-1).error, unavailable);
});

test("retry-5m rejects substantive output observed after the wall-clock deadline", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 20, maxDelayMs: 20, random: () => 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "late" }] });
	let upstreamCalls = 0;
	let clockMs = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 100,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			if (upstreamCalls === 1) {
				return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
			}
			return {
				async *[Symbol.asyncIterator]() {
					clockMs = 101;
					yield { type: "start", partial: succeeded };
					yield { type: "text_delta", contentIndex: 0, delta: "late", partial: succeeded };
					yield { type: "done", reason: "stop", message: succeeded };
				},
				async result() {
					return succeeded;
				},
			};
		},
		now: () => clockMs,
		sleep: async delayMs => {
			clockMs += delayMs;
		},
		scheduleTimeout: () => () => {},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 2);
	assert.deepEqual(output.events.map(event => event.type), ["error"]);
	assert.equal(output.events.at(-1).error, unavailable);
});

test("retry-5m keeps explicit overload, rate limit and stream failures on their separate retry budget", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 1, maxDelayMs: 1, random: () => 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const limited = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const overloaded = assistant({
		errorStatus: 503,
		errorMessage: "Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.",
	});
	const interrupted = assistant({
		errorStatus: 503,
		errorMessage: "Error Code stream_read_error: stream_read_error",
	});
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const failures = [unavailable, limited, overloaded, interrupted];
	let upstreamCalls = 0;
	let clockMs = 0;
	const progress: Array<AdaptiveRetryProgress | undefined> = [];
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 3,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 2,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			const failure = failures.shift();
			return failure
				? new FakeInputStream([{ type: "error", reason: "error", error: failure }])
				: new FakeInputStream([
						{ type: "start", partial: succeeded },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
						{ type: "done", reason: "stop", message: succeeded },
					]);
		},
		now: () => clockMs,
		sleep: async delayMs => {
			clockMs += delayMs;
		},
		onProgress: value => progress.push(value),
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 5);
	assert.equal(clockMs > 2, true);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
	assert.equal(
		progress.some(value => value?.kind === "rate-limit" && value.retryWindowMs !== undefined),
		false,
	);
	assert.equal(
		progress.some(value => value?.attempt === 3 && value.kind === "transport" && value.retryWindowMs === undefined),
		true,
	);
});

test("retry-5m user cancellation wins when a 503 event arrives in the abort race", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const controller = new AbortController();
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test", signal: controller.signal },
		queue,
		transientUpstream5xxMode: "retry-5m",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => ({
			async *[Symbol.asyncIterator]() {
				controller.abort();
				yield { type: "error", reason: "error", error: unavailable };
			},
			async result() {
				return unavailable;
			},
		}),
	});

	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	assert.equal(output.events.length, 0);
});

test("retry-5m user cancellation wins when createInputStream throws a 503 in the abort race", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const controller = new AbortController();
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test", signal: controller.signal },
		queue,
		transientUpstream5xxMode: "retry-5m",
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			controller.abort();
			throw unavailable;
		},
	});

	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	assert.equal(output.events.length, 0);
});

test("retry-5m disables its deadline after substantive output starts", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		transientUpstream5xxMode: "retry-5m",
		upstream5xxRetryWindowMs: 20,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			if (upstreamCalls === 1) {
				return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: succeeded };
					yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded };
					await sleepWithSignal(35);
					yield { type: "done", reason: "stop", message: succeeded };
				},
				async result() {
					return succeeded;
				},
			};
		},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 2);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("fallback mode forwards a generic 503 after one request", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		retryTransientUpstream5xx: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "error", reason: "error", error: unavailable },
			]);
		},
	});

	await output.completion.promise;
	assert.equal(upstreamCalls, 1);
	assert.equal(output.events.at(-1).error, unavailable);
});

test("fallback mode also forwards a generic 503 thrown before streaming starts", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		retryTransientUpstream5xx: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			throw unavailable;
		},
	});

	await assert.rejects(output.completion.promise, error => error === unavailable);
	assert.equal(upstreamCalls, 1);
});

test("fallback mode bypasses but does not exhaust an active generic 503 campaign", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const fallbackQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "transport", status: 503 });
	await ownerQueue.release(owner);

	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: fallbackQueue,
		retryTransientUpstream5xx: false,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
		},
	});

	await output.completion.promise;
	const preserved = await fallbackQueue.getRetryState(laneId);
	assert.equal(upstreamCalls, 1);
	assert.equal(preserved?.status, "active");
	assert.equal(preserved?.attempt, 1);
	assert.equal(preserved?.lastStatus, 503);
	assert.equal(await fallbackQueue.hasWaiters(laneId), false);
});

test("a successful fallback-mode health probe clears the generic 503 campaign it observed", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const fallbackQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "transport", status: 503 });
	await ownerQueue.release(owner);

	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: fallbackQueue,
		retryTransientUpstream5xx: false,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () =>
			new FakeInputStream([
				{ type: "start", partial: succeeded },
				{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
				{ type: "done", reason: "stop", message: succeeded },
			]),
	});

	await output.completion.promise;
	assert.equal(await fallbackQueue.getRetryState(laneId), undefined);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("retry-state locking preserves a campaign that advances while an observed snapshot is cleared", async () => {
	const rootDir = await tempRoot();
	const writerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const clearingQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const laneId = createLaneId({ provider: "primary", baseUrl: "https://example.test/v1", apiKey: "test" });
	const owner = await writerQueue.acquire(laneId);
	await writerQueue.waitForTurn(owner);
	await writerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "transport", status: 503 });
	const observed = await writerQueue.getRetryState(laneId);
	assert.ok(observed);

	const writerReachedStateWrite = Promise.withResolvers<void>();
	const allowStateWrite = Promise.withResolvers<void>();
	const writerInternals = writerQueue as unknown as {
		writeRetryState(laneId: string, state: LaneRetryState): Promise<void>;
	};
	const writeRetryState = writerInternals.writeRetryState.bind(writerQueue);
	writerInternals.writeRetryState = async (targetLaneId, state) => {
		if (state.attempt === 2) {
			writerReachedStateWrite.resolve();
			await allowStateWrite.promise;
		}
		await writeRetryState(targetLaneId, state);
	};

	const advance = writerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "transport", status: 503 });
	await writerReachedStateWrite.promise;
	let clearSettled = false;
	const clear = clearingQueue.clearRetryStateSnapshot(laneId, observed).then(result => {
		clearSettled = true;
		return result;
	});
	await sleepWithSignal(30);
	assert.equal(clearSettled, false);
	allowStateWrite.resolve();

	assert.deepEqual(await advance, { status: "retry", attempt: 2, maxRetries: 50, delayMs: 0 });
	assert.equal(await clear, false);
	assert.equal((await clearingQueue.getRetryState(laneId))?.attempt, 2);
	await writerQueue.release(owner);
});

test("fallback mode releases a claimed campaign when its probe receives a generic 503", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const fallbackQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "rate-limit" });
	await ownerQueue.release(owner);

	const unavailable = assistant({ errorStatus: 503, errorMessage: "Service temporarily unavailable" });
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: fallbackQueue,
		retryTransientUpstream5xx: false,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]),
	});

	await output.completion.promise;
	const preserved = await fallbackQueue.getRetryState(laneId);
	assert.equal(preserved?.status, "active");
	assert.equal(preserved?.attempt, 1);
	assert.equal(preserved?.lastKind, "rate-limit");
	assert.equal(await fallbackQueue.hasWaiters(laneId), false);
});

test("two concurrent windows share one retry attempt and discard the follower's stale failure", async () => {
	const rootDir = await tempRoot();
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const failed = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const firstAttemptsReady = Promise.withResolvers<void>();
	let firstAttemptsStarted = 0;
	const loggedAttempts: number[] = [];
	const logger = {
		warn(message: string, fields?: Record<string, unknown>) {
			if (message === "adaptive provider queue caught retryable error") {
				loggedAttempts.push(Number(fields?.attempt));
			}
		},
	};
	const makeFactory = () => {
		let calls = 0;
		return {
			get calls() {
				return calls;
			},
			create() {
				calls += 1;
				if (calls > 1) {
					return new FakeInputStream([
						{ type: "start", partial: succeeded },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: succeeded },
						{ type: "done", reason: "stop", message: succeeded },
					]);
				}
				return {
					async *[Symbol.asyncIterator]() {
						firstAttemptsStarted += 1;
						if (firstAttemptsStarted === 2) firstAttemptsReady.resolve();
						await firstAttemptsReady.promise;
						yield { type: "start", partial: assistant() };
						yield { type: "error", reason: "error", error: failed };
					},
					async result() {
						return failed;
					},
				};
			},
		};
	};
	const firstFactory = makeFactory();
	const secondFactory = makeFactory();
	const firstQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const secondQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const firstOutput = createAdaptiveStream({
		model,
		requestOptions,
		queue: firstQueue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => firstFactory.create(),
		logger,
	});
	const secondOutput = createAdaptiveStream({
		model,
		requestOptions,
		queue: secondQueue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => secondFactory.create(),
		logger,
	});

	await Promise.all([firstOutput.completion.promise, secondOutput.completion.promise]);
	assert.equal(firstFactory.calls, 2);
	assert.equal(secondFactory.calls, 2);
	assert.deepEqual(loggedAttempts, [1]);
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	assert.equal(await firstQueue.getRetryState(laneId), undefined);
	assert.equal(await firstQueue.hasWaiters(laneId), false);
});

test("a new request under exhausted shared state reaches fallback without contacting upstream", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await queue.acquire(laneId);
	await queue.waitForTurn(owner);
	assert.equal(
		(await queue.recordRetryFailure(owner, { maxRetries: 0, kind: "rate-limit" })).status,
		"exhausted",
	);
	await queue.release(owner);

	let upstreamCalls = 0;
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			upstreamCalls += 1;
			return new FakeInputStream([]);
		},
	});
	await assert.rejects(output.completion.promise, error => error instanceof AdaptiveRetryExhaustedError);
	assert.equal(upstreamCalls, 0);
	await waitUntil(async () => !(await queue.hasWaiters(laneId)));
});

test("cancelling the probe releases its ticket but preserves takeover state", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 100, maxDelayMs: 100 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test", signal: new AbortController().signal };
	const controller = new AbortController();
	requestOptions.signal = controller.signal;
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const failed = assistant({ errorStatus: 429, errorMessage: "Concurrency limit exceeded for account" });
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () =>
			new FakeInputStream([
				{ type: "start", partial: assistant() },
				{ type: "error", reason: "error", error: failed },
			]),
	});
	await waitUntil(async () => (await queue.getRetryState(laneId))?.attempt === 1);
	controller.abort();
	await assert.rejects(output.completion.promise, error => error instanceof Error && error.name === "AbortError");
	await waitUntil(async () => !(await queue.hasWaiters(laneId)));
	assert.equal((await queue.getRetryState(laneId))?.status, "active");

	const successor = await queue.acquire(laneId);
	await queue.waitForTurn(successor);
	const takeover = await queue.waitForRetryWindow(successor);
	assert.equal(takeover.status, "ready");
	assert.equal(takeover.status === "ready" && takeover.claimed, true);
	assert.equal(takeover.status === "ready" && takeover.state?.attempt, 1);
	await queue.clearRetryState(successor);
	await queue.release(successor);
});

test("an aborted stream event releases the probe without exhausting shared state", async () => {
	const rootDir = await tempRoot();
	const ownerQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const probeQueue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, baseDelayMs: 0, maxDelayMs: 0 });
	const model = { provider: "primary", id: "model", baseUrl: "https://example.test/v1" };
	const requestOptions = { apiKey: "test" };
	const laneId = createLaneId({ ...model, apiKey: requestOptions.apiKey });
	const owner = await ownerQueue.acquire(laneId);
	await ownerQueue.waitForTurn(owner);
	await ownerQueue.recordRetryFailure(owner, { maxRetries: 50, kind: "rate-limit" });
	await ownerQueue.release(owner);

	const aborted = assistant({ stopReason: "aborted", errorMessage: "Request was aborted" });
	const output = createAdaptiveStream({
		model,
		requestOptions,
		queue: probeQueue,
		sharedRetryRecovery: true,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => new FakeInputStream([{ type: "error", reason: "aborted", error: aborted }]),
	});
	await output.completion.promise;
	const preserved = await probeQueue.getRetryState(laneId);
	assert.equal(preserved?.status, "active");
	assert.equal(preserved?.attempt, 1);
	assert.equal(preserved?.lastKind, "rate-limit");
	await waitUntil(async () => !(await probeQueue.hasWaiters(laneId)));

	const successor = await probeQueue.acquire(laneId);
	await probeQueue.waitForTurn(successor);
	const takeover = await probeQueue.waitForRetryWindow(successor);
	assert.equal(takeover.status, "ready");
	assert.equal(takeover.status === "ready" && takeover.claimed, true);
	await probeQueue.clearRetryState(successor);
	await probeQueue.release(successor);
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
		retryTransientUpstream5xx: false,
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
		retryTransientUpstream5xx: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});
	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.equal(output.events.at(-1).error, interrupted);
});

test("explicit server overload retries instead of reaching fallback", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const overloaded = assistant({
		errorStatus: 504,
		errorMessage: "Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.",
	});
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	const attempts = [
		new FakeInputStream([{ type: "start", partial: assistant() }, { type: "error", reason: "error", error: overloaded }]),
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
		maxRetries: 1,
		retryTransientUpstream5xx: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});
	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("stream wrapper retries an Anthropic envelope drop before message_stop", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = new Error("Anthropic stream envelope error: stream ended before message_stop");
	const succeeded = assistant({ stopReason: "stop", content: [{ type: "text", text: "recovered" }] });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "agentrouter", id: "claude-opus-5", baseUrl: "https://agentrouter.org" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		retryTransientUpstream5xx: false,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			if (attempts === 1) throw failed;
			return new FakeInputStream([
				{ type: "start", partial: succeeded },
				{ type: "text_delta", contentIndex: 0, delta: "recovered", partial: succeeded },
				{ type: "done", reason: "stop", message: succeeded },
			]);
		},
	});
	await output.completion.promise;
	assert.equal(attempts, 2);
	assert.deepEqual(output.events.map(event => event.type), ["start", "text_delta", "done"]);
});

test("stream wrapper retries a transport drop after buffering an unexecuted tool call", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({
		provider: "justworker",
		model: "claude-opus-5",
		errorMessage: "The socket connection was closed unexpectedly",
		content: [
			{ type: "thinking", thinking: "delegate" },
			{ type: "text", text: "I will delegate this work." },
			{ type: "toolCall", id: "failed-task", name: "task", arguments: { prompt: "research" } },
		],
	});
	const succeeded = assistant({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "recovered-task", name: "task", arguments: { prompt: "research" } }],
	});
	const attempts = [
		new FakeInputStream([
			{ type: "start", partial: assistant() },
			{ type: "text_start", contentIndex: 1, partial: failed },
			{ type: "text_delta", contentIndex: 1, delta: "I will delegate this work.", partial: failed },
			{ type: "text_end", contentIndex: 1, content: "I will delegate this work.", partial: failed },
			{ type: "toolcall_start", contentIndex: 2, id: "failed-task", name: "task", partial: failed },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"prompt":"research"}', partial: failed },
			{ type: "toolcall_end", contentIndex: 2, partial: failed },
			{ type: "error", reason: "error", error: failed },
		]),
		new FakeInputStream([
			{ type: "start", partial: succeeded },
			{ type: "toolcall_start", contentIndex: 0, id: "recovered-task", name: "task", partial: succeeded },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"prompt":"research"}', partial: succeeded },
			{ type: "toolcall_end", contentIndex: 0, partial: succeeded },
			{ type: "done", reason: "toolUse", message: succeeded },
		]),
	];
	const output = createAdaptiveStream({
		model: { provider: "justworker", id: "claude-opus-5", baseUrl: "https://api.justwoker.icu/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 1,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => attempts.shift()!,
	});

	await output.completion.promise;
	assert.equal(attempts.length, 0);
	assert.deepEqual(output.events.map(event => event.type), [
		"start",
		"text_start",
		"text_delta",
		"text_end",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
	assert.equal(output.events.some(event => event.id === "failed-task"), false);
	assert.equal(output.events.some(event => event.id === "recovered-task"), true);
});

test("stream wrapper commits buffered tool calls only when the provider stream completes", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const completed = assistant({
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "task-1", name: "task", arguments: { prompt: "research" } }],
	});
	const output = createAdaptiveStream({
		model: { provider: "justworker", id: "claude-opus-5", baseUrl: "https://api.justwoker.icu/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () =>
			new FakeInputStream([
				{ type: "start", partial: completed },
				{ type: "toolcall_start", contentIndex: 0, id: "task-1", name: "task", partial: completed },
				{ type: "toolcall_delta", contentIndex: 0, delta: '{"prompt":"research"}', partial: completed },
				{ type: "toolcall_end", contentIndex: 0, partial: completed },
				{ type: "done", reason: "toolUse", message: completed },
			]),
	});

	await output.completion.promise;
	assert.deepEqual(output.events.map(event => event.type), [
		"start",
		"toolcall_start",
		"toolcall_delta",
		"toolcall_end",
		"done",
	]);
});

test("stream wrapper does not replay a transport drop after substantive text", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const failed = assistant({
		provider: "agentrouter-2",
		model: "claude-opus-5",
		errorMessage: "Anthropic stream envelope error: stream ended before message_stop",
		content: [{ type: "text", text: "partial" }],
	});
	let attempts = 0;
	const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
	const output = createAdaptiveStream({
		model: { provider: "agentrouter-2", id: "claude-opus-5", baseUrl: "https://agentrouter.org" },
		requestOptions: { apiKey: "test" },
		queue,
		logger: { warn: (message, fields) => warnings.push({ message, fields }) },
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
	assert.deepEqual(
		warnings.find(entry => entry.message === "adaptive provider queue did not replay a partial retryable stream")?.fields,
		{
			provider: "agentrouter-2",
			model: "claude-opus-5",
			kind: "transport",
			hasSubstantiveOutput: true,
			errorContentBlocks: 1,
		},
	);
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

test("stream wrapper retries model-unavailable errors before forwarding the final failure", async () => {
	const rootDir = await tempRoot();
	const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 2_000, baseDelayMs: 0, maxDelayMs: 0 });
	const unavailable = assistant({ errorStatus: 503, errorMessage: "model unavailable", errorId: 123 });
	let attempts = 0;
	const output = createAdaptiveStream({
		model: { provider: "primary", id: "model", baseUrl: "https://example.test/v1" },
		requestOptions: { apiKey: "test" },
		queue,
		maxRetries: 2,
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => {
			attempts += 1;
			return new FakeInputStream([{ type: "error", reason: "error", error: unavailable }]);
		},
	});
	await output.completion.promise;
	assert.equal(attempts, 3);
	assert.equal(output.events.length, 1);
	assert.equal(output.events[0].error, unavailable);
});
