import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const AIINPUT_PROVIDER = "aiinput";
export const AIINPUT_ENDPOINTS = [
	{ id: "ai", baseUrl: "https://ai.input.im/v1" },
	{ id: "eo", baseUrl: "https://eo.input.codes/v1" },
	{ id: "input", baseUrl: "https://input.codes/v1" },
] as const;

export type AiInputEndpointId = (typeof AIINPUT_ENDPOINTS)[number]["id"];

const ROUTE_STATE_VERSION = 1;
const ROUTE_STATE_FILE = "aiinput-route.json";
const ROUTE_LOCK_DIR = ".aiinput-route.lock";
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_SWITCH_RATIO = 0.8;
const DEFAULT_SWITCH_WINS = 2;
const SAMPLE_LIMIT = 8;
const EWMA_ALPHA = 0.35;
const JITTER_WEIGHT = 1.5;

interface LatencySample {
	at: number;
	latencyMs: number;
}

export interface AiInputEndpointScore {
	readonly baseUrl: string;
	readonly lastCheckedAt: number;
	readonly measuredThisRound: boolean;
	readonly samples: readonly Readonly<LatencySample>[];
	readonly latencyEwmaMs?: number;
	readonly jitterEwmaMs?: number;
	readonly score?: number;
	readonly challengerWins: number;
}

interface MutableEndpointScore {
	baseUrl: string;
	lastCheckedAt: number;
	measuredThisRound: boolean;
	samples: LatencySample[];
	latencyEwmaMs?: number;
	jitterEwmaMs?: number;
	score?: number;
	challengerWins: number;
}

interface PersistedRouteState {
	version: 1;
	selectedBaseUrl: string;
	probedAt: number;
	updatedAt: number;
	endpoints: MutableEndpointScore[];
}

export interface AiInputRouteSnapshot {
	readonly selectedBaseUrl: string;
	readonly probedAt: number;
	readonly updatedAt: number;
	readonly endpoints: readonly AiInputEndpointScore[];
}

interface AiInputRouterLogger {
	info?(message: string, fields?: Record<string, unknown>): void;
	warn?(message: string, fields?: Record<string, unknown>): void;
}

interface ProbeRequestInit extends RequestInit {
	proxy?: string;
}

type FetchLike = (input: string | URL, init?: ProbeRequestInit) => Promise<Response>;

export interface AiInputEndpointRouterOptions {
	stateDir?: string;
	endpoints?: readonly { id: string; baseUrl: string }[];
	probeIntervalMs?: number;
	probeTimeoutMs?: number;
	lockStaleMs?: number;
	switchRatio?: number;
	switchWins?: number;
	fetchImpl?: FetchLike;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	logger?: AiInputRouterLogger;
	proxyUrl?: string;
	proxyForUrl?: (url: URL) => string | undefined;
}

export interface AiInputRouteRequest {
	apiKey?: unknown;
	signal?: AbortSignal;
	forceRefresh?: boolean;
	exclude?: ReadonlySet<string> | readonly string[];
	pinnedBaseUrl?: string;
	fallbackBaseUrl?: string;
}

export interface AiInputRouteStatusOptions {
	readonly pinnedBaseUrl?: string;
	readonly pinExpiresAt?: number;
	readonly now?: number;
}

export interface AiInputRoutedModel<T> {
	readonly model: T;
	readonly baseUrl?: string;
	readonly routed: boolean;
}

interface ProbeMeasurement {
	baseUrl: string;
	latencyMs?: number;
}

interface RefreshTask {
	readonly controller: AbortController;
	readonly force: boolean;
	readonly promise: Promise<PersistedRouteState>;
	waiters: number;
	keepAlive: boolean;
}

function defaultStateDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
	return path.join(path.dirname(agentDir), "run", "adaptive-provider-queue");
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

export function resolveAiInputEndpoint(value: string): (typeof AIINPUT_ENDPOINTS)[number] | undefined {
	const normalized = value.trim().toLowerCase();
	const legacyAliases: Readonly<Record<string, AiInputEndpointId>> = {
		main: "ai",
		edge: "eo",
		global: "input",
	};
	const id = legacyAliases[normalized] ?? normalized;
	return AIINPUT_ENDPOINTS.find(endpoint => endpoint.id === id);
}

export function aiInputEndpointId(baseUrl: string): AiInputEndpointId | undefined {
	const normalized = normalizeBaseUrl(baseUrl);
	return AIINPUT_ENDPOINTS.find(endpoint => endpoint.baseUrl === normalized)?.id;
}

function endpointLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return baseUrl;
	}
}

function abortError(): Error {
	return new DOMException("AI Input route selection aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(), Math.max(0, ms));
		const onAbort = () => finish(abortError());
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isLocalOrMetadataHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
	if (host === "::" || host === "::1" || /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) {
		return true;
	}
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (!ipv4) return false;
	const first = Number(ipv4[1]);
	const second = Number(ipv4[2]);
	return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function noProxyMatches(url: URL, noProxy: string | undefined): boolean {
	if (isLocalOrMetadataHost(url.hostname)) return true;
	if (!noProxy) return false;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
	return noProxy.split(/[,\s]+/).some(raw => {
		let entry = raw.trim().toLowerCase();
		if (!entry) return false;
		if (entry === "*") return true;
		let entryPort: string | undefined;
		if (entry.includes("]:")) {
			const separator = entry.lastIndexOf(":");
			entryPort = entry.slice(separator + 1);
			entry = entry.slice(0, separator);
		} else if (!entry.includes("]") && entry.includes(":")) {
			const separator = entry.lastIndexOf(":");
			entryPort = entry.slice(separator + 1);
			entry = entry.slice(0, separator);
		}
		if (entryPort && entryPort !== port) return false;
		entry = entry.replace(/^\[|\]$/g, "");
		const clean = entry.replace(/^\./, "");
		return host === clean || host.endsWith(`.${clean}`);
	});
}

function environmentProxyFor(url: string): string | undefined {
	const parsed = new URL(url);
	if (noProxyMatches(parsed, process.env.NO_PROXY || process.env.no_proxy)) return undefined;
	const providerProxy = process.env.PI_PROXY_AIINPUT || process.env.PI_PROXY;
	if (providerProxy) return providerProxy;
	if (parsed.protocol === "https:") {
		return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
	}
	return process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function calculateScore(samples: readonly LatencySample[]): {
	latencyEwmaMs?: number;
	jitterEwmaMs?: number;
	score?: number;
} {
	if (samples.length === 0) return {};
	let latencyEwmaMs = samples[0].latencyMs;
	let jitterEwmaMs = 0;
	for (let index = 1; index < samples.length; index += 1) {
		const current = samples[index].latencyMs;
		const previous = samples[index - 1].latencyMs;
		latencyEwmaMs = latencyEwmaMs * (1 - EWMA_ALPHA) + current * EWMA_ALPHA;
		jitterEwmaMs = jitterEwmaMs * (1 - EWMA_ALPHA) + Math.abs(current - previous) * EWMA_ALPHA;
	}
	return {
		latencyEwmaMs,
		jitterEwmaMs,
		score: latencyEwmaMs + JITTER_WEIGHT * jitterEwmaMs,
	};
}

export class AiInputEndpointRouter {
	private readonly stateDir: string;
	private readonly statePath: string;
	private readonly lockPath: string;
	private readonly endpoints: readonly { id: string; baseUrl: string }[];
	private readonly endpointUrls: Set<string>;
	private readonly probeIntervalMs: number;
	private readonly probeTimeoutMs: number;
	private readonly lockStaleMs: number;
	private readonly switchRatio: number;
	private readonly switchWins: number;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly logger?: AiInputRouterLogger;
	private readonly proxyUrl?: string;
	private readonly proxyForUrl: (url: URL) => string | undefined;
	private memoryState: PersistedRouteState | undefined;
	private refreshInFlight: RefreshTask | undefined;
	private latestApiKey = "";
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: AiInputEndpointRouterOptions = {}) {
		this.stateDir = options.stateDir ?? defaultStateDir();
		this.statePath = path.join(this.stateDir, ROUTE_STATE_FILE);
		this.lockPath = path.join(this.stateDir, ROUTE_LOCK_DIR);
		this.endpoints = (options.endpoints ?? AIINPUT_ENDPOINTS).map(endpoint => ({
			id: endpoint.id,
			baseUrl: normalizeBaseUrl(endpoint.baseUrl),
		}));
		if (this.endpoints.length === 0) throw new Error("AI Input endpoint router requires at least one endpoint");
		this.endpointUrls = new Set(this.endpoints.map(endpoint => endpoint.baseUrl));
		this.probeIntervalMs = Math.max(1, options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
		this.probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
		this.lockStaleMs = Math.max(1, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
		this.switchRatio = Math.max(0, Math.min(1, options.switchRatio ?? DEFAULT_SWITCH_RATIO));
		this.switchWins = Math.max(1, Math.floor(options.switchWins ?? DEFAULT_SWITCH_WINS));
		this.fetchImpl = options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? defaultSleep;
		this.logger = options.logger;
		this.proxyUrl = options.proxyUrl;
		this.proxyForUrl = options.proxyForUrl ?? (url => environmentProxyFor(url.toString()));
	}

	async routeModel<T extends { provider: string; baseUrl?: string; [key: string]: unknown }>(
		model: T,
		request: AiInputRouteRequest,
	): Promise<AiInputRoutedModel<T>> {
		if (model.provider !== AIINPUT_PROVIDER) return { model, baseUrl: model.baseUrl, routed: false };
		const baseUrl = await this.selectEndpoint({ ...request, fallbackBaseUrl: model.baseUrl });
		return { model: { ...model, baseUrl }, baseUrl, routed: true };
	}

	async selectEndpoint(request: AiInputRouteRequest = {}): Promise<string> {
		this.rememberApiKey(request.apiKey);
		let state = await this.readState();
		const pinnedBaseUrl = typeof request.pinnedBaseUrl === "string"
			? normalizeBaseUrl(request.pinnedBaseUrl)
			: undefined;
		const pin = pinnedBaseUrl && this.endpointUrls.has(pinnedBaseUrl) ? pinnedBaseUrl : undefined;
		const excluded = new Set(
			[...(request.exclude ?? [])]
				.map(value => normalizeBaseUrl(value))
				.filter(value => this.endpointUrls.has(value)),
		);
		const hasMeasurements = state.probedAt > 0 && state.endpoints.some(endpoint => endpoint.samples.length > 0);
		if (pin) {
			if (this.latestApiKey && (
				request.forceRefresh || !hasMeasurements || this.now() - state.probedAt >= this.probeIntervalMs
			)) {
				void this.refresh(this.latestApiKey, undefined, request.forceRefresh === true, true).catch(error => {
					this.logRefreshFailure("AI Input pinned-session background latency probe failed", error);
				});
			}
			return pin;
		}
		try {
			if (request.forceRefresh || (!hasMeasurements && this.latestApiKey)) {
				state = await this.refresh(this.latestApiKey, request.signal, request.forceRefresh === true);
			} else if (this.latestApiKey && this.now() - state.probedAt >= this.probeIntervalMs) {
				void this.refresh(this.latestApiKey, undefined, false, true).catch(error => {
					this.logRefreshFailure("AI Input background latency probe failed", error);
				});
			}
		} catch (error) {
			if (isAbortError(error) || request.signal?.aborted) throw abortError();
			this.logRefreshFailure("AI Input latency routing failed open", error);
			const fallback = request.fallbackBaseUrl && normalizeBaseUrl(request.fallbackBaseUrl);
			if (!hasMeasurements && fallback && this.endpointUrls.has(fallback) && !excluded.has(fallback)) return fallback;
		}
		return this.selectFromState(state, excluded);
	}

	start(apiKey?: unknown): void {
		if (typeof apiKey === "string" && apiKey.trim().length > 0) this.latestApiKey = apiKey;
		if (!this.latestApiKey) return;
		this.ensureRefreshTimer();
	}

	private ensureRefreshTimer(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			if (!this.latestApiKey) return;
			void this.refresh(this.latestApiKey, undefined, false, true).catch(error => {
				this.logRefreshFailure("AI Input periodic latency probe failed", error);
			});
		}, this.probeIntervalMs);
		this.refreshTimer.unref?.();
	}

	stop(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
		this.refreshInFlight?.controller.abort();
		this.latestApiKey = "";
	}

	async snapshot(): Promise<AiInputRouteSnapshot> {
		return this.copyState(await this.readState());
	}

	private rememberApiKey(value: unknown): void {
		if (typeof value !== "string" || value.trim().length === 0) return;
		this.latestApiKey = value;
		this.ensureRefreshTimer();
	}

	private async refresh(
		apiKey: string,
		signal: AbortSignal | undefined,
		force: boolean,
		background = false,
	): Promise<PersistedRouteState> {
		if (!apiKey) return this.readState();
		if (signal?.aborted) throw abortError();
		while (true) {
			const current = this.refreshInFlight;
			if (current) {
				if (background) current.keepAlive = true;
				if (force && !current.force) {
					try {
						await this.waitForRefresh(current, signal);
					} catch (error) {
						if (isAbortError(error) || signal?.aborted) throw abortError();
					}
					continue;
				}
				return this.waitForRefresh(current, signal);
			}

			const controller = new AbortController();
			let task!: RefreshTask;
			const promise = this.refreshLocked(apiKey, controller.signal, force).finally(() => {
				if (this.refreshInFlight === task) this.refreshInFlight = undefined;
			});
			task = {
				controller,
				force,
				waiters: 0,
				keepAlive: background,
				promise,
			};
			this.refreshInFlight = task;
			return this.waitForRefresh(task, signal);
		}
	}

	private async waitForRefresh(task: RefreshTask, signal?: AbortSignal): Promise<PersistedRouteState> {
		task.waiters += 1;
		let cancelled = false;
		try {
			if (!signal) return await task.promise;
			if (signal.aborted) {
				cancelled = true;
				throw abortError();
			}
			return await new Promise<PersistedRouteState>((resolve, reject) => {
				let settled = false;
				const finish = (callback: () => void) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					callback();
				};
				const onAbort = () => finish(() => {
					cancelled = true;
					reject(abortError());
				});
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
				task.promise.then(
					value => finish(() => resolve(value)),
					error => finish(() => reject(error)),
				);
			});
		} finally {
			task.waiters -= 1;
			if (task.waiters === 0 && !task.keepAlive && this.refreshInFlight === task) {
				this.refreshInFlight = undefined;
				task.controller.abort();
				if (cancelled) await task.promise.catch(() => {});
			}
		}
	}

	private async refreshLocked(
		apiKey: string,
		signal: AbortSignal | undefined,
		force: boolean,
	): Promise<PersistedRouteState> {
		const acquired = await this.acquireLock(this.probeTimeoutMs + 1_000, signal);
		if (!acquired) return this.readState();
		try {
			const state = (await this.readStateFromDisk()) ?? this.memoryState ?? this.initialState();
			if (!force && this.now() - state.probedAt < this.probeIntervalMs) {
				this.memoryState = state;
				return state;
			}
			const measurements = await Promise.all(
				this.endpoints.map(endpoint => this.probeEndpoint(endpoint.baseUrl, apiKey, signal)),
			);
			if (signal?.aborted) throw abortError();
			const next = this.applyMeasurements(state, measurements);
			this.memoryState = next;
			try {
				await this.writeState(next, signal);
			} catch (error) {
				if (isAbortError(error) || signal?.aborted) throw abortError();
				this.logRefreshFailure("AI Input route state could not be persisted", error);
			}
			return next;
		} finally {
			await fs.rmdir(this.lockPath).catch(() => {});
		}
	}

	private async probeEndpoint(baseUrl: string, apiKey: string, parentSignal?: AbortSignal): Promise<ProbeMeasurement> {
		if (parentSignal?.aborted) throw abortError();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.probeTimeoutMs);
		const onAbort = () => controller.abort();
		parentSignal?.addEventListener("abort", onAbort, { once: true });
		const startedAt = performance.now();
		try {
			const proxy = this.proxyUrl ?? this.proxyForUrl(new URL(baseUrl));
			const response = await this.fetchImpl(`${baseUrl}/models`, {
				method: "GET",
				redirect: "error",
				cache: "no-store",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				signal: controller.signal,
				...(proxy ? { proxy } : {}),
			});
			const latencyMs = Math.max(0, performance.now() - startedAt);
			void response.body?.cancel().catch(() => {});
			return { baseUrl, latencyMs };
		} catch {
			if (parentSignal?.aborted) throw abortError();
			return { baseUrl };
		} finally {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onAbort);
		}
	}

	private applyMeasurements(
		state: PersistedRouteState,
		measurements: readonly ProbeMeasurement[],
	): PersistedRouteState {
		const next = this.copyState(state);
		const now = this.now();
		const hadMeasurements = next.endpoints.some(endpoint => endpoint.samples.length > 0);
		for (const measurement of measurements) {
			const endpoint = next.endpoints.find(item => item.baseUrl === measurement.baseUrl);
			if (!endpoint) continue;
			endpoint.lastCheckedAt = now;
			endpoint.measuredThisRound = measurement.latencyMs !== undefined;
			if (measurement.latencyMs === undefined) {
				endpoint.latencyEwmaMs = undefined;
				endpoint.jitterEwmaMs = undefined;
				endpoint.score = undefined;
				endpoint.challengerWins = 0;
				continue;
			}
			endpoint.samples = [
				...endpoint.samples,
				{ at: now, latencyMs: measurement.latencyMs },
			].slice(-SAMPLE_LIMIT);
			Object.assign(endpoint, calculateScore(endpoint.samples));
		}

		const ranked = next.endpoints
			.filter(endpoint => endpoint.measuredThisRound && endpoint.score !== undefined)
			.sort((left, right) => (left.score ?? Infinity) - (right.score ?? Infinity));
		const fastest = ranked[0];
		const current = ranked.find(endpoint => endpoint.baseUrl === next.selectedBaseUrl);
		if (fastest) {
			if (!hadMeasurements) {
				next.selectedBaseUrl = fastest.baseUrl;
				for (const endpoint of next.endpoints) endpoint.challengerWins = 0;
			} else if (fastest.baseUrl === current?.baseUrl) {
				for (const endpoint of next.endpoints) endpoint.challengerWins = 0;
			} else if (!current || (fastest.score ?? Infinity) <= (current.score ?? Infinity) * this.switchRatio) {
				for (const endpoint of next.endpoints) {
					endpoint.challengerWins = endpoint.baseUrl === fastest.baseUrl ? endpoint.challengerWins + 1 : 0;
				}
				if (fastest.challengerWins >= this.switchWins) {
					next.selectedBaseUrl = fastest.baseUrl;
					for (const endpoint of next.endpoints) endpoint.challengerWins = 0;
				}
			} else {
				for (const endpoint of next.endpoints) endpoint.challengerWins = 0;
			}
		}
		next.probedAt = now;
		next.updatedAt = now;
		this.logger?.info?.("AI Input latency probe completed", {
			provider: AIINPUT_PROVIDER,
			selected: endpointLabel(next.selectedBaseUrl),
			measurements: next.endpoints.map(endpoint => ({
				endpoint: endpointLabel(endpoint.baseUrl),
				latencyMs: endpoint.measuredThisRound
					? Math.round(endpoint.samples.at(-1)?.latencyMs ?? 0)
					: undefined,
				jitterMs: endpoint.jitterEwmaMs === undefined ? undefined : Math.round(endpoint.jitterEwmaMs),
				score: endpoint.score === undefined ? undefined : Math.round(endpoint.score),
			})),
		});
		return next;
	}

	private selectFromState(state: PersistedRouteState, excludedValues?: ReadonlySet<string> | readonly string[]): string {
		const excluded = new Set(
			[...(excludedValues ?? [])]
				.map(value => normalizeBaseUrl(value))
				.filter(value => this.endpointUrls.has(value)),
		);
		const candidates = state.endpoints
			.filter(endpoint => !excluded.has(endpoint.baseUrl) && endpoint.measuredThisRound && endpoint.score !== undefined)
			.sort((left, right) => (left.score ?? Infinity) - (right.score ?? Infinity));
		const selected = candidates.find(endpoint => endpoint.baseUrl === state.selectedBaseUrl);
		if (selected) return selected.baseUrl;
		if (candidates[0]) return candidates[0].baseUrl;
		if (this.endpointUrls.has(state.selectedBaseUrl) && !excluded.has(state.selectedBaseUrl)) {
			return state.selectedBaseUrl;
		}

		const unexcluded = this.endpoints.find(endpoint => !excluded.has(endpoint.baseUrl));
		if (unexcluded) return unexcluded.baseUrl;
		return state.selectedBaseUrl || this.endpoints[0].baseUrl;
	}

	private initialState(): PersistedRouteState {
		const now = this.now();
		return {
			version: ROUTE_STATE_VERSION,
			selectedBaseUrl: this.endpoints[0].baseUrl,
			probedAt: 0,
			updatedAt: now,
			endpoints: this.endpoints.map(endpoint => ({
				baseUrl: endpoint.baseUrl,
				lastCheckedAt: 0,
				measuredThisRound: false,
				samples: [],
				challengerWins: 0,
			})),
		};
	}

	private parseState(value: unknown): PersistedRouteState | undefined {
		if (!value || typeof value !== "object") return undefined;
		const source = value as Partial<PersistedRouteState> & { version?: number; mode?: unknown };
		if ((source.version !== ROUTE_STATE_VERSION && source.version !== 2) || !Array.isArray(source.endpoints)) {
			return undefined;
		}
		const next = this.initialState();
		const byUrl = new Map<string, Partial<MutableEndpointScore>>();
		for (const endpoint of source.endpoints) {
			if (!endpoint || typeof endpoint !== "object" || typeof endpoint.baseUrl !== "string") continue;
			byUrl.set(normalizeBaseUrl(endpoint.baseUrl), endpoint);
		}
		next.endpoints = next.endpoints.map(defaultEndpoint => {
			const sourceEndpoint = byUrl.get(defaultEndpoint.baseUrl);
			if (!sourceEndpoint) return defaultEndpoint;
			const samples = Array.isArray(sourceEndpoint.samples)
				? sourceEndpoint.samples
					.filter(sample => sample && finiteNumber(sample.at) !== undefined && finiteNumber(sample.latencyMs) !== undefined)
					.map(sample => ({ at: sample.at, latencyMs: sample.latencyMs }))
					.slice(-SAMPLE_LIMIT)
				: [];
			const measuredThisRound = sourceEndpoint.measuredThisRound === true;
			return {
				...defaultEndpoint,
				lastCheckedAt: finiteNumber(sourceEndpoint.lastCheckedAt) ?? 0,
				measuredThisRound,
				samples,
				...(measuredThisRound ? calculateScore(samples) : {}),
				challengerWins: Math.max(0, Math.floor(finiteNumber(sourceEndpoint.challengerWins) ?? 0)),
			};
		});
		next.selectedBaseUrl = typeof source.selectedBaseUrl === "string" && this.endpointUrls.has(normalizeBaseUrl(source.selectedBaseUrl))
			? normalizeBaseUrl(source.selectedBaseUrl)
			: this.endpoints[0].baseUrl;
		if (source.mode === "pinned") {
			const fastest = next.endpoints
				.filter(endpoint => endpoint.measuredThisRound && endpoint.score !== undefined)
				.sort((left, right) => (left.score ?? Infinity) - (right.score ?? Infinity))[0];
			if (fastest) next.selectedBaseUrl = fastest.baseUrl;
		}
		next.probedAt = finiteNumber(source.probedAt) ?? 0;
		next.updatedAt = finiteNumber(source.updatedAt) ?? next.updatedAt;
		return next;
	}

	private copyState(state: PersistedRouteState): PersistedRouteState {
		return {
			...state,
			endpoints: state.endpoints.map(endpoint => ({
				...endpoint,
				samples: endpoint.samples.map(sample => ({ ...sample })),
			})),
		};
	}

	private async readState(): Promise<PersistedRouteState> {
		const disk = await this.readStateFromDisk();
		if (disk) {
			this.memoryState = disk;
			return disk;
		}
		return this.memoryState ?? this.initialState();
	}

	private async readStateFromDisk(): Promise<PersistedRouteState | undefined> {
		try {
			return this.parseState(JSON.parse(await fs.readFile(this.statePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.logger?.warn?.("AI Input route state could not be read", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}

	private async writeState(state: PersistedRouteState, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError();
		await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		await fs.chmod(this.stateDir, 0o700).catch(() => {});
		const temporary = path.join(this.stateDir, `.${ROUTE_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			if (signal?.aborted) throw abortError();
			await fs.rename(temporary, this.statePath);
			await fs.chmod(this.statePath, 0o600).catch(() => {});
		} catch (error) {
			await fs.unlink(temporary).catch(() => {});
			throw error;
		}
	}

	private async acquireLock(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
		await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		const startedAt = this.now();
		while (true) {
			if (signal?.aborted) throw abortError();
			try {
				await fs.mkdir(this.lockPath, { mode: 0o700 });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const stat = await fs.stat(this.lockPath);
					if (this.now() - stat.mtimeMs > this.lockStaleMs) {
						await fs.rmdir(this.lockPath).catch(() => {});
						continue;
					}
				} catch {
					continue;
				}
				if (this.now() - startedAt >= maxWaitMs) return false;
				await this.sleep(50, signal);
			}
		}
	}

	private logRefreshFailure(message: string, error: unknown): void {
		if (isAbortError(error)) return;
		this.logger?.warn?.(message, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function formatAiInputRouteStatus(
	snapshot: AiInputRouteSnapshot,
	options: AiInputRouteStatusOptions = {},
): string {
	const normalizedPin = typeof options.pinnedBaseUrl === "string"
		? normalizeBaseUrl(options.pinnedBaseUrl)
		: undefined;
	const pinnedBaseUrl = normalizedPin && aiInputEndpointId(normalizedPin) ? normalizedPin : undefined;
	const activeBaseUrl = pinnedBaseUrl ?? snapshot.selectedBaseUrl;
	const activeId = aiInputEndpointId(activeBaseUrl) ?? endpointLabel(activeBaseUrl);
	const active = snapshot.endpoints.find(endpoint => endpoint.baseUrl === activeBaseUrl);
	const quality = active?.measuredThisRound && active.latencyEwmaMs !== undefined && active.jitterEwmaMs !== undefined
		? ` | ${Math.round(active.latencyEwmaMs)}ms +/- ${Math.round(active.jitterEwmaMs)}ms`
		: " | no sample this round";
	const expires = pinnedBaseUrl && options.pinExpiresAt !== undefined
		? ` | expires in ${formatRemainingDuration(options.pinExpiresAt - (options.now ?? Date.now()))}`
		: pinnedBaseUrl
			? " | until changed"
			: "";
	const mode = pinnedBaseUrl ? `pinned ${activeId}` : `auto -> ${activeId}`;
	const endpoints = snapshot.endpoints.map(endpoint => {
		const id = aiInputEndpointId(endpoint.baseUrl) ?? endpointLabel(endpoint.baseUrl);
		if (!endpoint.measuredThisRound || endpoint.score === undefined) {
			return `${id} no sample this round`;
		}
		return `${id} latency ${Math.round(endpoint.latencyEwmaMs ?? 0)}ms, jitter ${Math.round(endpoint.jitterEwmaMs ?? 0)}ms, score ${Math.round(endpoint.score)}`;
	});
	return [`AI Input route: ${mode}${quality}${expires}`, ...endpoints].join("\n");
}

function formatRemainingDuration(milliseconds: number): string {
	const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.ceil(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.ceil(hours / 24)}d`;
}
