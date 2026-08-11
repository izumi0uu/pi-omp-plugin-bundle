import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
	AdaptiveProviderQueue,
	createLaneId,
	sleepWithSignal,
	type LaneRetryState,
} from "../src/queue.ts";
import { toOpenAIResponsesModel } from "../src/responses-model.ts";
import type { AdaptiveRetryProgress } from "../src/retry-progress.ts";
import {
	AdaptiveRetryExhaustedError,
	createAdaptiveStream,
	isAdaptiveRateLimit,
	isAdaptiveTransientTransport,
	isAdaptiveTransientUpstream,
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

test("transient concurrency limits queue while quota and unavailable errors pass through", () => {
	assert.equal(
		isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "rate_limit_exceeded: Concurrency limit exceeded for account" }),
		true,
	);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "Too many pending requests, retry later" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 429, errorMessage: "" }), true);
	assert.equal(isAdaptiveRateLimit({ errorMessage: "Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorMessage: "Error Code server_error: Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 503, errorMessage: "Our servers are currently overloaded. Please try again later." }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 502, errorMessage: "server_is_overloaded" }), true);
	assert.equal(isAdaptiveRateLimit({ errorStatus: 504, errorMessage: "server_is_overloaded" }), true);
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

test("transport and generic upstream errors use distinct adaptive retry classes", () => {
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "Error Code stream_read_error: stream_read_error" }), true);
	assert.equal(isAdaptiveTransientTransport(new Error("socket connection was closed unexpectedly")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("OpenAI responses stream timed out while waiting for the first event")), true);
	assert.equal(isAdaptiveTransientTransport(new Error("responses stream ended without response.completed: missing_terminal")), true);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 502, errorMessage: "Bad gateway" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 504, errorMessage: "Gateway timeout" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 500, errorMessage: "Internal server error" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorStatus: 503, errorMessage: "model unavailable" }), false);
	assert.equal(isAdaptiveTransientTransport({ errorMessage: "model overloaded" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 502, errorMessage: "Bad gateway" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "Service temporarily unavailable" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 504, errorMessage: "Gateway timeout" }), true);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 500, errorMessage: "Internal server error" }), false);
	assert.equal(isAdaptiveTransientUpstream({ errorStatus: 503, errorMessage: "model unavailable" }), false);
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
		createOutputStream: () => new FakeOutputStream(),
		createInputStream: () => firstFactory.create(),
		logger,
	});
	const secondOutput = createAdaptiveStream({
		model,
		requestOptions,
		queue: secondQueue,
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
