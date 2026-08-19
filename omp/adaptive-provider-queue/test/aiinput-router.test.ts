import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
	AIINPUT_ENDPOINTS,
	AiInputEndpointRouter,
	formatAiInputRouteStatus,
	resolveAiInputEndpoint,
} from "../src/aiinput-router.ts";

const tempDirs: string[] = [];

after(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aiinput-route-test-"));
	tempDirs.push(dir);
	return dir;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

interface ProbeTestRequestInit extends RequestInit {
	proxy?: string;
}

const PROXY_ENV_KEYS = [
	"PI_PROXY_AIINPUT",
	"PI_PROXY",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
] as const;

async function withProxyEnvironment(
	values: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>,
	run: () => Promise<void>,
): Promise<void> {
	const previous = new Map(PROXY_ENV_KEYS.map(key => [key, process.env[key]] as const));
	for (const key of PROXY_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const key of PROXY_ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function delayedFetch(
	latencies: Map<string, number | "fail">,
	calls: string[],
	status = 200,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
	return async (input, init) => {
		const url = String(input);
		calls.push(url);
		const baseUrl = url.replace(/\/models$/, "");
		const delay = latencies.get(baseUrl) ?? 1;
		if (delay === "fail") throw new Error("probe did not complete");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, delay);
			init?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(new DOMException("aborted", "AbortError"));
			}, { once: true });
		});
		return new Response("", { status });
	};
}

test("the first request waits for three parallel measurements and caches the fastest URL", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	const router = new AiInputEndpointRouter({
		stateDir,
		probeIntervalMs: 60_000,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 30],
			[AIINPUT_ENDPOINTS[1].baseUrl, 2],
			[AIINPUT_ENDPOINTS[2].baseUrl, 15],
		]), calls),
	});

	assert.equal(await router.selectEndpoint({ apiKey: "secret-test-key" }), AIINPUT_ENDPOINTS[1].baseUrl);
	assert.equal(calls.length, 3);
	assert.equal(await router.selectEndpoint({ apiKey: "secret-test-key" }), AIINPUT_ENDPOINTS[1].baseUrl);
	assert.equal(calls.length, 3);
	const persisted = await fs.readFile(path.join(stateDir, "aiinput-route.json"), "utf8");
	assert.doesNotMatch(persisted, /secret-test-key/);
	router.stop();
});

test("jitter penalty lets a stable URL beat a faster but oscillating URL", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	const latencies = new Map<string, number | "fail">([
		[AIINPUT_ENDPOINTS[0].baseUrl, 5],
		[AIINPUT_ENDPOINTS[1].baseUrl, 30],
		[AIINPUT_ENDPOINTS[2].baseUrl, 90],
	]);
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		switchRatio: 1,
		switchWins: 1,
		fetchImpl: delayedFetch(latencies, calls),
	});
	assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[0].baseUrl);

	latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, 80);
	await router.selectEndpoint({ apiKey: "key", forceRefresh: true });
	latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, 5);
	assert.equal(
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
		AIINPUT_ENDPOINTS[1].baseUrl,
	);
	const snapshot = await router.snapshot();
	const oscillating = snapshot.endpoints.find(endpoint => endpoint.baseUrl === AIINPUT_ENDPOINTS[0].baseUrl);
	const stable = snapshot.endpoints.find(endpoint => endpoint.baseUrl === AIINPUT_ENDPOINTS[1].baseUrl);
	assert.ok((oscillating?.jitterEwmaMs ?? 0) > (stable?.jitterEwmaMs ?? 0));
	assert.ok((oscillating?.score ?? 0) > (stable?.score ?? Infinity));
	router.stop();
});

test("a missing probe sample is infinite only for that round and creates no failure state", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	const latencies = new Map<string, number | "fail">([
		[AIINPUT_ENDPOINTS[0].baseUrl, 2],
		[AIINPUT_ENDPOINTS[1].baseUrl, 15],
		[AIINPUT_ENDPOINTS[2].baseUrl, 30],
	]);
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		switchRatio: 1,
		switchWins: 1,
		fetchImpl: delayedFetch(latencies, calls),
	});
	assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[0].baseUrl);
	latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, "fail");
	assert.equal(
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
		AIINPUT_ENDPOINTS[1].baseUrl,
	);
	let missing = (await router.snapshot()).endpoints.find(endpoint => endpoint.baseUrl === AIINPUT_ENDPOINTS[0].baseUrl);
	assert.equal(missing?.measuredThisRound, false);
	assert.equal(missing?.score, undefined);
	assert.equal(missing?.samples.length, 1);

	latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, 1);
	assert.equal(
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
		AIINPUT_ENDPOINTS[0].baseUrl,
	);
	missing = (await router.snapshot()).endpoints.find(endpoint => endpoint.baseUrl === AIINPUT_ENDPOINTS[0].baseUrl);
	assert.equal(missing?.measuredThisRound, true);
	assert.equal(missing?.samples.length, 2);
	const persisted = JSON.parse(await fs.readFile(path.join(stateDir, "aiinput-route.json"), "utf8"));
	assert.equal("cooldownUntil" in persisted.endpoints[0], false);
	assert.equal("consecutiveFailures" in persisted.endpoints[0], false);
	router.stop();
});

test("a missing preferred endpoint is bypassed immediately but changes the default only after two rounds", async () => {
	const stateDir = await tempStateDir();
	const latencies = new Map<string, number | "fail">([
		[AIINPUT_ENDPOINTS[0].baseUrl, 2],
		[AIINPUT_ENDPOINTS[1].baseUrl, 12],
		[AIINPUT_ENDPOINTS[2].baseUrl, 30],
	]);
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		switchWins: 2,
		fetchImpl: delayedFetch(latencies, []),
	});
	try {
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[0].baseUrl);
		latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, "fail");

		assert.equal(
			await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
			AIINPUT_ENDPOINTS[1].baseUrl,
		);
		let snapshot = await router.snapshot();
		assert.equal(snapshot.selectedBaseUrl, AIINPUT_ENDPOINTS[0].baseUrl);
		assert.equal(
			snapshot.endpoints.find(endpoint => endpoint.baseUrl === AIINPUT_ENDPOINTS[1].baseUrl)?.challengerWins,
			1,
		);

		assert.equal(
			await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
			AIINPUT_ENDPOINTS[1].baseUrl,
		);
		snapshot = await router.snapshot();
		assert.equal(snapshot.selectedBaseUrl, AIINPUT_ENDPOINTS[1].baseUrl);
	} finally {
		router.stop();
	}
});

test("an all-missing probe round keeps the cached selected URL", async () => {
	const stateDir = await tempStateDir();
	const latencies = new Map<string, number | "fail">([
		[AIINPUT_ENDPOINTS[0].baseUrl, 30],
		[AIINPUT_ENDPOINTS[1].baseUrl, 2],
		[AIINPUT_ENDPOINTS[2].baseUrl, 15],
	]);
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(latencies, []),
	});
	try {
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[1].baseUrl);
		for (const endpoint of AIINPUT_ENDPOINTS) latencies.set(endpoint.baseUrl, "fail");

		assert.equal(
			await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
			AIINPUT_ENDPOINTS[1].baseUrl,
		);
		const snapshot = await router.snapshot();
		assert.equal(snapshot.selectedBaseUrl, AIINPUT_ENDPOINTS[1].baseUrl);
		assert.ok(snapshot.endpoints.every(endpoint => !endpoint.measuredThisRound && endpoint.score === undefined));
		assert.equal(
			await router.selectEndpoint({ apiKey: "key", exclude: [AIINPUT_ENDPOINTS[1].baseUrl] }),
			AIINPUT_ENDPOINTS[0].baseUrl,
		);
	} finally {
		router.stop();
	}
});

test("HTTP status is not classified by the router when the latency probe completes", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map(), [], 503),
	});
	await router.selectEndpoint({ apiKey: "key" });
	assert.ok((await router.snapshot()).endpoints.every(endpoint => endpoint.measuredThisRound));
	router.stop();
});

test("attempt exclusions select the best remaining measured URL without mutating scores", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 2],
			[AIINPUT_ENDPOINTS[1].baseUrl, 12],
			[AIINPUT_ENDPOINTS[2].baseUrl, 25],
		]), []),
	});
	assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[0].baseUrl);
	const before = await router.snapshot();
	assert.equal(
		await router.selectEndpoint({ apiKey: "key", exclude: new Set([AIINPUT_ENDPOINTS[0].baseUrl]) }),
		AIINPUT_ENDPOINTS[1].baseUrl,
	);
	assert.deepEqual((await router.snapshot()).endpoints, before.endpoints);
	router.stop();
});

test("the initial parallel probe is immediately cancellable", async () => {
	const stateDir = await tempStateDir();
	let started = 0;
	let aborted = 0;
	const allStarted = Promise.withResolvers<void>();
	const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
		started += 1;
		if (started === AIINPUT_ENDPOINTS.length) allStarted.resolve();
		await new Promise<never>((_resolve, reject) => {
			const signal = init?.signal;
			const onAbort = () => {
				aborted += 1;
				reject(new DOMException("probe aborted", "AbortError"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		throw new Error("unreachable");
	};
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeTimeoutMs: 5_000,
		fetchImpl,
	});
	const controller = new AbortController();
	const pending = router.selectEndpoint({ apiKey: "key", signal: controller.signal });
	const timeoutError = Promise.withResolvers<never>();
	const timeoutHandler = setTimeout(() => timeoutError.reject(new Error("probes did not start")), 1_000);
	timeoutHandler.unref?.();
	try {
		await Promise.race([
			allStarted.promise,
			timeoutError.promise,
		]);
		const abortedAt = Date.now();
		controller.abort();
		await assert.rejects(
			pending,
			error => error instanceof Error && error.name === "AbortError",
		);
		assert.ok(Date.now() - abortedAt < 500, "abort should not wait for the probe timeout");
		assert.equal(aborted, AIINPUT_ENDPOINTS.length);
		await assert.rejects(fs.access(path.join(stateDir, ".aiinput-route.lock")), error =>
			(error as NodeJS.ErrnoException).code === "ENOENT",
		);
	} finally {
		clearTimeout(timeoutHandler);
		router.stop();
	}
});

test("a new request after sole-waiter cancellation starts a fresh probe task", async () => {
	const stateDir = await tempStateDir();
	const firstRoundStarted = Promise.withResolvers<void>();
	const secondRoundStarted = Promise.withResolvers<void>();
	const releaseSecondRound = Promise.withResolvers<void>();
	let calls = 0;
	let firstRoundAborts = 0;
	const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
		calls += 1;
		const round = Math.ceil(calls / AIINPUT_ENDPOINTS.length);
		if (round === 1) {
			if (calls === AIINPUT_ENDPOINTS.length) firstRoundStarted.resolve();
			await new Promise<never>((_resolve, reject) => {
				const onAbort = () => {
					firstRoundAborts += 1;
					reject(new DOMException("first probe round aborted", "AbortError"));
				};
				if (init?.signal?.aborted) onAbort();
				else init?.signal?.addEventListener("abort", onAbort, { once: true });
			});
			throw new Error("unreachable");
		}
		if (calls === AIINPUT_ENDPOINTS.length * 2) secondRoundStarted.resolve();
		await releaseSecondRound.promise;
		return new Response();
	};
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeTimeoutMs: 5_000,
		fetchImpl,
	});
	const firstController = new AbortController();
	const first = router.selectEndpoint({ apiKey: "key", signal: firstController.signal });
	let second: Promise<string> | undefined;
	try {
		await firstRoundStarted.promise;
		firstController.abort();
		second = router.selectEndpoint({ apiKey: "key" });
		await assert.rejects(first, error => error instanceof Error && error.name === "AbortError");
		await secondRoundStarted.promise;
		assert.equal(calls, AIINPUT_ENDPOINTS.length * 2);
		assert.equal(firstRoundAborts, AIINPUT_ENDPOINTS.length);
		releaseSecondRound.resolve();
		const selected = await second;
		assert.ok(AIINPUT_ENDPOINTS.some(endpoint => endpoint.baseUrl === selected));
	} finally {
		releaseSecondRound.resolve();
		await Promise.allSettled([first, ...(second ? [second] : [])]);
		router.stop();
	}
});

test("concurrent route waiters have request-local cancellation", async () => {
	const stateDir = await tempStateDir();
	const releaseProbes = Promise.withResolvers<void>();
	const allStarted = Promise.withResolvers<void>();
	let started = 0;
	let probeAborts = 0;
	const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
		started += 1;
		if (started === AIINPUT_ENDPOINTS.length) allStarted.resolve();
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				probeAborts += 1;
				reject(new DOMException("shared probe aborted", "AbortError"));
			};
			init?.signal?.addEventListener("abort", onAbort, { once: true });
			releaseProbes.promise.then(resolve, reject).finally(() => {
				init?.signal?.removeEventListener("abort", onAbort);
			});
		});
		return new Response();
	};
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeTimeoutMs: 5_000,
		fetchImpl,
	});
	const firstController = new AbortController();
	const first = router.selectEndpoint({ apiKey: "key", signal: firstController.signal });
	let secondSettled = false;
	let second: Promise<string> | undefined;
	try {
		await allStarted.promise;
		second = router.selectEndpoint({ apiKey: "key" });
		void second.then(
			() => { secondSettled = true; },
			() => { secondSettled = true; },
		);
		await new Promise(resolve => setTimeout(resolve, 20));
		firstController.abort();
		await assert.rejects(first, error => error instanceof Error && error.name === "AbortError");
		assert.equal(secondSettled, false, "the other waiter must remain attached to the shared probe");
		assert.equal(probeAborts, 0, "a request-local abort must not cancel shared network probes");
		releaseProbes.resolve();
		const selected = await second;
		assert.ok(AIINPUT_ENDPOINTS.some(endpoint => endpoint.baseUrl === selected));
	} finally {
		releaseProbes.resolve();
		await Promise.allSettled([first, ...(second ? [second] : [])]);
		router.stop();
	}
});

test("a forced refresh queued behind a non-forced refresh still performs a forced probe round", async () => {
	const stateDir = await tempStateDir();
	const releaseBackground = Promise.withResolvers<void>();
	const releaseForced = Promise.withResolvers<void>();
	let clock = 1_000;
	let calls = 0;
	const fetchImpl = async (): Promise<Response> => {
		calls += 1;
		if (calls <= AIINPUT_ENDPOINTS.length) return new Response();
		if (calls <= AIINPUT_ENDPOINTS.length * 2) await releaseBackground.promise;
		else await releaseForced.promise;
		return new Response();
	};
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeIntervalMs: 60_000,
		fetchImpl,
		now: () => clock,
	});
	let forced: Promise<string> | undefined;
	try {
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true });
		clock += 60_001;
		await router.selectEndpoint({ apiKey: "key" });
		await waitUntil(() => calls === AIINPUT_ENDPOINTS.length * 2);

		forced = router.selectEndpoint({ apiKey: "key", forceRefresh: true });
		let forcedSettled = false;
		void forced.then(
			() => { forcedSettled = true; },
			() => { forcedSettled = true; },
		);
		releaseBackground.resolve();
		await waitUntil(() => calls === AIINPUT_ENDPOINTS.length * 3);
		assert.equal(forcedSettled, false, "force refresh must wait for its own probe round");
		releaseForced.resolve();
		await forced;
		assert.equal(calls, AIINPUT_ENDPOINTS.length * 3);
	} finally {
		releaseBackground.resolve();
		releaseForced.resolve();
		if (forced) await Promise.allSettled([forced]);
		router.stop();
	}
});

test("stop aborts an active background probe", async () => {
	const stateDir = await tempStateDir();
	const releaseBackground = Promise.withResolvers<void>();
	let clock = 1_000;
	let calls = 0;
	let aborted = 0;
	const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
		calls += 1;
		if (calls <= AIINPUT_ENDPOINTS.length) return new Response();
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				aborted += 1;
				reject(new DOMException("background probe stopped", "AbortError"));
			};
			init?.signal?.addEventListener("abort", onAbort, { once: true });
			releaseBackground.promise.then(resolve, reject).finally(() => {
				init?.signal?.removeEventListener("abort", onAbort);
			});
		});
		return new Response();
	};
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeIntervalMs: 60_000,
		probeTimeoutMs: 5_000,
		fetchImpl,
		now: () => clock,
	});
	try {
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true });
		clock += 60_001;
		await router.selectEndpoint({ apiKey: "key" });
		await waitUntil(() => calls === AIINPUT_ENDPOINTS.length * 2);
		router.stop();
		await waitUntil(() => aborted === AIINPUT_ENDPOINTS.length, 500);
	} finally {
		releaseBackground.resolve();
		router.stop();
	}
});

test("probe proxy precedence is PI_PROXY_AIINPUT then PI_PROXY then HTTPS_PROXY with NO_PROXY bypass", async () => {
	const probe = async (
		environment: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>,
	): Promise<Array<string | undefined>> => {
		const proxies: Array<string | undefined> = [];
		await withProxyEnvironment(environment, async () => {
			const stateDir = await tempStateDir();
			const router = new AiInputEndpointRouter({
				stateDir,
				fetchImpl: async (_input: string | URL, init?: ProbeTestRequestInit) => {
					proxies.push(init?.proxy);
					return new Response();
				},
			});
			try {
				await router.selectEndpoint({ apiKey: "key" });
			} finally {
				router.stop();
			}
		});
		return proxies;
	};

	assert.deepEqual(
		await probe({
			PI_PROXY_AIINPUT: "http://aiinput.proxy.test:9001",
			PI_PROXY: "http://pi.proxy.test:9002",
			HTTPS_PROXY: "http://https.proxy.test:9003",
		}),
		Array(AIINPUT_ENDPOINTS.length).fill("http://aiinput.proxy.test:9001"),
	);
	assert.deepEqual(
		await probe({
			PI_PROXY: "http://pi.proxy.test:9002",
			HTTPS_PROXY: "http://https.proxy.test:9003",
		}),
		Array(AIINPUT_ENDPOINTS.length).fill("http://pi.proxy.test:9002"),
	);
	assert.deepEqual(
		await probe({ HTTPS_PROXY: "http://https.proxy.test:9003" }),
		Array(AIINPUT_ENDPOINTS.length).fill("http://https.proxy.test:9003"),
	);
	assert.deepEqual(
		await probe({
			PI_PROXY_AIINPUT: "http://aiinput.proxy.test:9001",
			PI_PROXY: "http://pi.proxy.test:9002",
			HTTPS_PROXY: "http://https.proxy.test:9003",
			NO_PROXY: "ai.input.im,.input.codes",
		}),
		Array(AIINPUT_ENDPOINTS.length).fill(undefined),
	);
});

test("route selection falls open to the default endpoint when the state directory cannot be created", async () => {
	const root = await tempStateDir();
	const stateDir = path.join(root, "not-a-directory");
	await fs.writeFile(stateDir, "occupied");
	let fetchCalls = 0;
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: async () => {
			fetchCalls += 1;
			return new Response();
		},
	});
	try {
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[0].baseUrl);
		assert.equal(fetchCalls, 0);
	} finally {
		router.stop();
	}
});

test("route selection falls open to the cached endpoint when the state lock remains busy", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	let clock = Date.now();
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		probeTimeoutMs: 5_000,
		lockStaleMs: Number.MAX_SAFE_INTEGER,
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 20],
			[AIINPUT_ENDPOINTS[1].baseUrl, 1],
			[AIINPUT_ENDPOINTS[2].baseUrl, 10],
		]), calls),
		now: () => (clock += 2_000),
		sleep: async () => {},
	});
	try {
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[1].baseUrl);
		await fs.mkdir(path.join(stateDir, ".aiinput-route.lock"));
		assert.equal(
			await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
			AIINPUT_ENDPOINTS[1].baseUrl,
		);
		assert.equal(calls.length, AIINPUT_ENDPOINTS.length);
	} finally {
		router.stop();
	}
});

test("route selection falls open to the cached endpoint when route-state persistence fails", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 20],
			[AIINPUT_ENDPOINTS[1].baseUrl, 1],
			[AIINPUT_ENDPOINTS[2].baseUrl, 10],
		]), calls),
	});
	try {
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[1].baseUrl);
		const statePath = path.join(stateDir, "aiinput-route.json");
		await fs.rm(statePath);
		await fs.mkdir(statePath);
		assert.equal(
			await router.selectEndpoint({ apiKey: "key", forceRefresh: true }),
			AIINPUT_ENDPOINTS[1].baseUrl,
		);
	} finally {
		router.stop();
	}
});

test("route fail-open preserves request cancellation as AbortError", async () => {
	const root = await tempStateDir();
	const stateDir = path.join(root, "not-a-directory");
	await fs.writeFile(stateDir, "occupied");
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: async () => new Response(),
	});
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			router.selectEndpoint({ apiKey: "key", signal: controller.signal }),
			error => error instanceof Error && error.name === "AbortError",
		);
	} finally {
		router.stop();
	}
});

test("session pin aliases resolve only to built-in endpoints", () => {
	assert.equal(resolveAiInputEndpoint("ai")?.baseUrl, AIINPUT_ENDPOINTS[0].baseUrl);
	assert.equal(resolveAiInputEndpoint("eo")?.baseUrl, AIINPUT_ENDPOINTS[1].baseUrl);
	assert.equal(resolveAiInputEndpoint("input")?.baseUrl, AIINPUT_ENDPOINTS[2].baseUrl);
	assert.equal(resolveAiInputEndpoint("edge")?.baseUrl, AIINPUT_ENDPOINTS[1].baseUrl);
	assert.equal(resolveAiInputEndpoint("https://attacker.invalid/v1"), undefined);
	assert.equal(resolveAiInputEndpoint(AIINPUT_ENDPOINTS[0].baseUrl), undefined);
});

test("legacy global pin state migrates to the best cached automatic route", async () => {
	const stateDir = await tempStateDir();
	const first = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 25],
			[AIINPUT_ENDPOINTS[1].baseUrl, 2],
			[AIINPUT_ENDPOINTS[2].baseUrl, 15],
		]), []),
	});
	await first.selectEndpoint({ apiKey: "key" });
	first.stop();

	const statePath = path.join(stateDir, "aiinput-route.json");
	const legacy = JSON.parse(await fs.readFile(statePath, "utf8"));
	legacy.version = 1;
	legacy.mode = "pinned";
	legacy.pinnedBaseUrl = AIINPUT_ENDPOINTS[0].baseUrl;
	legacy.selectedBaseUrl = AIINPUT_ENDPOINTS[0].baseUrl;
	await fs.writeFile(statePath, `${JSON.stringify(legacy)}\n`);

	const second = new AiInputEndpointRouter({ stateDir, proxyUrl: "", fetchImpl: async () => new Response() });
	try {
		const snapshot = await second.snapshot();
		assert.equal(snapshot.selectedBaseUrl, AIINPUT_ENDPOINTS[1].baseUrl);
		assert.equal("mode" in snapshot, false);
		assert.equal("pinnedBaseUrl" in snapshot, false);
		await second.selectEndpoint({ apiKey: "key", forceRefresh: true });
		const migrated = JSON.parse(await fs.readFile(statePath, "utf8"));
		assert.equal(migrated.version, 1);
		assert.equal("mode" in migrated, false);
		assert.equal("pinnedBaseUrl" in migrated, false);
	} finally {
		second.stop();
	}
});

test("a session pin returns immediately while probes continue to update the shared auto route", async () => {
	const stateDir = await tempStateDir();
	const calls: string[] = [];
	const latencies = new Map<string, number | "fail">([
		[AIINPUT_ENDPOINTS[0].baseUrl, 20],
		[AIINPUT_ENDPOINTS[1].baseUrl, 2],
		[AIINPUT_ENDPOINTS[2].baseUrl, 25],
	]);
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		switchRatio: 1,
		switchWins: 1,
		fetchImpl: delayedFetch(latencies, calls),
	});
	try {
		assert.equal(
			await router.selectEndpoint({ apiKey: "key", pinnedBaseUrl: AIINPUT_ENDPOINTS[2].baseUrl }),
			AIINPUT_ENDPOINTS[2].baseUrl,
		);
		await waitUntil(() => calls.length === AIINPUT_ENDPOINTS.length);
		await waitUntil(async () => (await router.snapshot()).probedAt > 0);
		assert.equal(await router.selectEndpoint({ apiKey: "key" }), AIINPUT_ENDPOINTS[1].baseUrl);

		latencies.set(AIINPUT_ENDPOINTS[0].baseUrl, 1);
		latencies.set(AIINPUT_ENDPOINTS[1].baseUrl, 30);
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true });
		assert.equal(
			await router.selectEndpoint({ apiKey: "key", pinnedBaseUrl: AIINPUT_ENDPOINTS[2].baseUrl }),
			AIINPUT_ENDPOINTS[2].baseUrl,
		);
		const snapshot = await router.snapshot();
		assert.equal(snapshot.selectedBaseUrl, AIINPUT_ENDPOINTS[0].baseUrl);
		assert.ok(snapshot.endpoints.every(endpoint => endpoint.measuredThisRound));
	} finally {
		router.stop();
	}
});

test("a session pin has priority over request-local Retry exclusions", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map([
			[AIINPUT_ENDPOINTS[0].baseUrl, 2],
			[AIINPUT_ENDPOINTS[1].baseUrl, 12],
			[AIINPUT_ENDPOINTS[2].baseUrl, 25],
		]), []),
	});
	await router.selectEndpoint({ apiKey: "key" });

	assert.equal(
		await router.selectEndpoint({
			apiKey: "key",
			pinnedBaseUrl: AIINPUT_ENDPOINTS[1].baseUrl,
			exclude: new Set([AIINPUT_ENDPOINTS[1].baseUrl]),
		}),
		AIINPUT_ENDPOINTS[1].baseUrl,
	);
	router.stop();
});

test("route status reports the current session pin, quality, and expiry", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({ stateDir, proxyUrl: "", fetchImpl: async () => new Response() });
	try {
		await router.selectEndpoint({ apiKey: "key" });
		const status = formatAiInputRouteStatus(await router.snapshot(), {
			pinnedBaseUrl: AIINPUT_ENDPOINTS[1].baseUrl,
			pinExpiresAt: 1_000 + 30 * 60_000,
			now: 1_000,
		});
		assert.match(status, /^AI Input route: pinned eo \| \d+ms \+\/- \d+ms \| expires in 30m/m);
	} finally {
		router.stop();
	}
});

test("only models from the aiinput provider receive the selected base URL", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({ stateDir, proxyUrl: "", fetchImpl: async () => new Response() });
	const aiinput = { provider: "aiinput", id: "gpt-5.6-sol", baseUrl: AIINPUT_ENDPOINTS[0].baseUrl };
	const tokenking = { provider: "tokenking", id: "gpt-5.6-sol", baseUrl: "https://example.test/v1" };

	const routed = await router.routeModel(aiinput, { apiKey: "key", pinnedBaseUrl: AIINPUT_ENDPOINTS[2].baseUrl });
	assert.equal(routed.model.baseUrl, AIINPUT_ENDPOINTS[2].baseUrl);
	assert.notEqual(routed.model, aiinput);
	const unchanged = await router.routeModel(tokenking, { apiKey: "key" });
	assert.equal(unchanged.model, tokenking);
	assert.equal(unchanged.routed, false);
	router.stop();
});

test("only the newest eight valid samples are retained", async () => {
	const stateDir = await tempStateDir();
	const router = new AiInputEndpointRouter({
		stateDir,
		proxyUrl: "",
		fetchImpl: delayedFetch(new Map(), []),
	});
	await router.selectEndpoint({ apiKey: "key" });
	for (let index = 0; index < 10; index += 1) {
		await router.selectEndpoint({ apiKey: "key", forceRefresh: true });
	}
	assert.ok((await router.snapshot()).endpoints.every(endpoint => endpoint.samples.length === 8));
	router.stop();
});
