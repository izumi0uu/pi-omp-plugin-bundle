import {
	AdaptiveProviderQueue,
	createLaneId,
	sleepWithSignal,
	type LaneRetryState,
	type QueuePosition,
	type QueueTicket,
	type RetryAttemptSnapshot,
	type RetryFailureKind,
	type RetryWindowDecision,
} from "./queue.ts";
import type { AdaptiveRetryProgress } from "./retry-progress.ts";
import {
	TRANSIENT_UPSTREAM_RETRY_WINDOW_MS,
	type TransientUpstreamMode,
} from "./session-policy.ts";

interface AssistantLike {
	stopReason?: string;
	errorMessage?: string;
	errorStatus?: number;
	[key: string]: unknown;
}

interface StreamEventLike {
	type: string;
	error?: AssistantLike;
	[key: string]: unknown;
}

interface InputStreamLike extends AsyncIterable<StreamEventLike> {
	result(): Promise<AssistantLike>;
}

interface OutputStreamLike {
	readonly done?: boolean;
	push(event: StreamEventLike): void;
	fail(error: unknown): void;
}

type ScheduledTimeoutCleanup = () => void;

interface AttemptGuard {
	readonly signal: AbortSignal;
	readonly interrupted: Promise<never>;
	deadlineExpired(): boolean;
	disableDeadline(): void;
	dispose(): void;
}

type TransientUpstreamFailure =
	| { readonly type: "event"; readonly event: StreamEventLike; readonly prefix: readonly StreamEventLike[] }
	| { readonly type: "throw"; readonly error: unknown; readonly prefix: readonly StreamEventLike[] };

class TransientUpstreamRetryWindowExpiredError extends Error {
	constructor() {
		super("Adaptive provider 5xx retry window expired");
		this.name = "TransientUpstreamRetryWindowExpiredError";
	}
}

export interface QueueLogger {
	info?(message: string, fields?: Record<string, unknown>): void;
	warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface AdaptiveStreamOptions<TOutput extends OutputStreamLike = OutputStreamLike> {
	model: { provider: string; id?: string; baseUrl?: string; [key: string]: unknown };
	requestOptions?: { apiKey?: unknown; signal?: AbortSignal; [key: string]: unknown };
	queue: AdaptiveProviderQueue;
	maxRetries?: number;
	transientUpstream5xxMode?: TransientUpstreamMode;
	upstream5xxRetryWindowMs?: number;
	/** @deprecated Use transientUpstream5xxMode. */
	retryTransientUpstream5xx?: boolean;
	sharedRetryRecovery?: boolean;
	createOutputStream(): TOutput;
	createInputStream(signal?: AbortSignal): InputStreamLike;
	logger?: QueueLogger;
	onProgress?(progress: AdaptiveRetryProgress | undefined): void;
	now?(): number;
	sleep?(ms: number, signal?: AbortSignal): Promise<void>;
	scheduleTimeout?(callback: () => void, delayMs: number): ScheduledTimeoutCleanup;
}

export const DEFAULT_MAX_RETRIES = 50;

export class AdaptiveRetryExhaustedError extends Error {
	readonly code = "ADAPTIVE_RETRY_EXHAUSTED";
	readonly attempt: number;
	readonly maxRetries: number;

	constructor(attempt: number, maxRetries: number) {
		super(`Adaptive provider recovery budget exhausted (${attempt}/${maxRetries}); fallback required`);
		this.name = "AdaptiveRetryExhaustedError";
		this.attempt = attempt;
		this.maxRetries = maxRetries;
	}
}

const QUOTA_OR_BILLING_PATTERN =
	/insufficient[_ -]?quota|quota (?:exceeded|exhausted)|resource[_ -]?exhausted|usage[_ -]?limit[_ -]?reached|billing|credit|balance|spend(?:ing)?[_ -]?limit|monthly[_ -]?limit|daily[_ -]?limit/i;
const MODEL_UNAVAILABLE_PATTERN =
	/model.{0,40}(?:unavailable|not available|disabled|offline|not found|overloaded)|no available (?:model|channel|route)|no capacity|capacity exhausted|upstream unavailable/i;
const TRANSIENT_SERVER_OVERLOAD_PATTERN =
	/server[_ -]?is[_ -]?overloaded|servers? (?:are )?(?:currently )?overloaded|server overload(?:ed)?/i;
const TRANSIENT_RATE_LIMIT_PATTERN =
	/concurren(?:cy|t)|too many pending requests|too many requests|rate[_ -]?limit(?:ed| exceeded)?|retry (?:again )?later/i;
const EXPLICIT_RATE_LIMIT_PATTERN =
	/concurren(?:cy|t)|too many pending requests|too many requests|rate[_ -]?limit[_ -]?exceeded|rate limit exceeded/i;
const EXPLICIT_TRANSIENT_TRANSPORT_PATTERN =
	/stream[_ -]?read[_ -]?error|socket connection (?:was )?closed|connection (?:reset|closed|aborted)|(?:fetch|network) (?:failed|error)|econnreset|econnrefused|etimedout|broken pipe|premature (?:stream|connection) close|upstream (?:reset|closed|disconnected)|up[_ -]?stream[_ -]?break|missing[_ -]?terminal|stream ended without (?:response\.completed|a terminal event)/i;
const TRANSIENT_TRANSPORT_PATTERN =
	/stream[_ -]?read[_ -]?error|socket connection (?:was )?closed|connection (?:reset|closed|aborted)|(?:fetch|network) (?:failed|error)|econnreset|econnrefused|etimedout|timed? out|timeout|broken pipe|premature (?:stream|connection) close|upstream (?:reset|closed|disconnected)|up[_ -]?stream[_ -]?break|missing[_ -]?terminal|stream ended without (?:response\.completed|a terminal event)/i;
const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (!error || typeof error !== "object") return String(error ?? "");
	const candidate = error as Record<string, unknown>;
	const direct = [candidate.errorMessage, candidate.message, candidate.error, candidate.detail]
		.filter(value => typeof value === "string")
		.join(" ");
	if (direct) return direct;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function errorStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const candidate = error as Record<string, unknown>;
	for (const value of [candidate.errorStatus, candidate.status, candidate.statusCode]) {
		if (typeof value === "number") return value;
	}
	return undefined;
}

export function isAdaptiveRateLimit(error: unknown): boolean {
	const text = errorText(error);
	if (QUOTA_OR_BILLING_PATTERN.test(text) || MODEL_UNAVAILABLE_PATTERN.test(text)) return false;
	const status = errorStatus(error);
	if (TRANSIENT_SERVER_OVERLOAD_PATTERN.test(text)) {
		return status === undefined || status === 429 || TRANSIENT_UPSTREAM_STATUSES.has(status);
	}
	if (EXPLICIT_RATE_LIMIT_PATTERN.test(text)) {
		return status === undefined || status === 429 || TRANSIENT_UPSTREAM_STATUSES.has(status);
	}
	if (status === 429) return text.length === 0 || TRANSIENT_RATE_LIMIT_PATTERN.test(text) || !/\b(?:401|403|5\d\d)\b/.test(text);
	return false;
}

export function isAdaptiveTransientTransport(error: unknown): boolean {
	const text = errorText(error);
	if (QUOTA_OR_BILLING_PATTERN.test(text) || MODEL_UNAVAILABLE_PATTERN.test(text)) return false;
	const status = errorStatus(error);
	if (isAdaptiveRateLimit(error)) return false;
	if (status === undefined) return TRANSIENT_TRANSPORT_PATTERN.test(text);
	return TRANSIENT_UPSTREAM_STATUSES.has(status) && EXPLICIT_TRANSIENT_TRANSPORT_PATTERN.test(text);
}

export function isAdaptiveTransientUpstream(error: unknown): boolean {
	const text = errorText(error);
	if (QUOTA_OR_BILLING_PATTERN.test(text) || MODEL_UNAVAILABLE_PATTERN.test(text)) return false;
	return (
		TRANSIENT_UPSTREAM_STATUSES.has(errorStatus(error) ?? 0) &&
		!isAdaptiveRateLimit(error) &&
		!isAdaptiveTransientTransport(error)
	);
}

function transientUpstreamStatus(error: unknown): number | undefined {
	return isAdaptiveTransientUpstream(error) ? errorStatus(error) : undefined;
}

export function retryAfterMsFromError(error: unknown): number | undefined {
	const text = errorText(error);
	const milliseconds = /(?:retry|try again).{0,24}?(\d+(?:\.\d+)?)\s*ms\b/i.exec(text);
	if (milliseconds) return Math.ceil(Number(milliseconds[1]));
	const seconds = /(?:retry[_ -]?after|retry|try again).{0,24}?(\d+(?:\.\d+)?)\s*(?:s|sec|second)s?\b/i.exec(text);
	if (seconds) return Math.ceil(Number(seconds[1]) * 1_000);
	return undefined;
}

async function releaseTicket(queue: AdaptiveProviderQueue, ticket: QueueTicket | undefined): Promise<undefined> {
	if (ticket) await queue.release(ticket);
	return undefined;
}

function substantiveContentExists(message: AssistantLike | undefined): boolean {
	const content = message?.content;
	if (!Array.isArray(content)) return false;
	return content.some(block => {
		if (!block || typeof block !== "object") return false;
		const item = block as Record<string, unknown>;
		if (item.type === "text") return typeof item.text === "string" && item.text.length > 0;
		return item.type === "toolCall" || item.type === "image";
	});
}

function isReplaySafeBoundary(event: StreamEventLike): boolean {
	if (event.type === "start" || event.type === "text_start" || event.type === "thinking_start") return true;
	if (event.type === "text_delta" || event.type === "thinking_delta") return String(event.delta ?? "").length === 0;
	if (event.type === "text_end" || event.type === "thinking_end") return String(event.content ?? "").length === 0;
	return false;
}

function isThinkingEvent(event: StreamEventLike): boolean {
	return event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end";
}

function isSubstantiveOutputEvent(event: StreamEventLike): boolean {
	if (event.type === "text_delta") return String(event.delta ?? "").length > 0;
	if (event.type === "text_end") return String(event.content ?? "").length > 0;
	if (event.type === "start" || event.type === "text_start" || event.type === "thinking_start") return false;
	if (isThinkingEvent(event) || event.type === "done" || event.type === "error") return false;
	return true;
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return true;
	if (!error || typeof error !== "object") return false;
	const candidate = error as Record<string, unknown>;
	return candidate.stopReason === "aborted" || candidate.reason === "aborted";
}

function cancellationError(): Error {
	return new DOMException("Adaptive provider request aborted", "AbortError");
}

function defaultScheduleTimeout(callback: () => void, delayMs: number): ScheduledTimeoutCleanup {
	const timer = setTimeout(callback, Math.max(0, delayMs));
	return () => clearTimeout(timer);
}

function createAttemptGuard(options: {
	parentSignal?: AbortSignal;
	deadlineAt?: number;
	now(): number;
	scheduleTimeout(callback: () => void, delayMs: number): ScheduledTimeoutCleanup;
}): AttemptGuard | undefined {
	if (!options.parentSignal && options.deadlineAt === undefined) return undefined;
	const controller = new AbortController();
	const interruption = Promise.withResolvers<never>();
	void interruption.promise.catch(() => {});
	let interrupted = false;
	let expired = false;
	let deadlineActive = options.deadlineAt !== undefined;
	let cancelDeadline: ScheduledTimeoutCleanup | undefined;
	const interrupt = (error: Error) => {
		if (interrupted) return;
		interrupted = true;
		controller.abort(error);
		interruption.reject(error);
	};
	const onParentAbort = () => interrupt(cancellationError());
	options.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	if (options.parentSignal?.aborted) onParentAbort();
	if (options.deadlineAt !== undefined) {
		cancelDeadline = options.scheduleTimeout(() => {
			if (!deadlineActive) return;
			expired = true;
			interrupt(new TransientUpstreamRetryWindowExpiredError());
		}, Math.max(0, options.deadlineAt - options.now()));
	}
	return {
		signal: controller.signal,
		interrupted: interruption.promise,
		deadlineExpired: () =>
			expired || (deadlineActive && options.deadlineAt !== undefined && options.deadlineAt <= options.now()),
		disableDeadline: () => {
			deadlineActive = false;
			cancelDeadline?.();
			cancelDeadline = undefined;
		},
		dispose: () => {
			cancelDeadline?.();
			cancelDeadline = undefined;
			options.parentSignal?.removeEventListener("abort", onParentAbort);
		},
	};
}

async function* guardedEvents(input: InputStreamLike, guard: AttemptGuard | undefined): AsyncIterable<StreamEventLike> {
	const iterator = input[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = guard
				? await Promise.race([iterator.next(), guard.interrupted])
				: await iterator.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		try {
			const returned = iterator.return?.();
			if (returned) void Promise.resolve(returned).catch(() => {});
		} catch {
			// The attempt is already terminal; iterator cleanup must not replace its result.
		}
	}
}

export function createAdaptiveStream<TOutput extends OutputStreamLike>(options: AdaptiveStreamOptions<TOutput>): TOutput {
	const output = options.createOutputStream();
	const signal = options.requestOptions?.signal;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepWithSignal;
	const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
	const transientUpstream5xxMode =
		options.transientUpstream5xxMode ?? (options.retryTransientUpstream5xx === false ? "fallback" : "retry");
	const retryTransientUpstream5xx = transientUpstream5xxMode !== "fallback";
	const upstream5xxRetryWindowMs = Math.max(
		0,
		Math.floor(options.upstream5xxRetryWindowMs ?? TRANSIENT_UPSTREAM_RETRY_WINDOW_MS),
	);
	const sharedRetryRecovery = transientUpstream5xxMode === "retry-5m" ? false : (options.sharedRetryRecovery ?? false);
	const laneId = createLaneId({
		provider: options.model.provider,
		baseUrl: options.model.baseUrl,
		apiKey: options.requestOptions?.apiKey,
	});

	void (async () => {
		let ticket: QueueTicket | undefined;
		let bypassedRetryState: LaneRetryState | undefined;
		let replayCount = 0;
		let emittedStart = false;
		let emittedTextStart = false;
		let emittedThinking = false;
		let localRetryAttempt = 0;
		let transientUpstreamRetryAttempt = 0;
		let transientUpstreamRetryDeadlineAt: number | undefined;
		let nextAttemptUsesTransientUpstreamDeadline = false;
		let lastTransientUpstreamFailure: TransientUpstreamFailure | undefined;
		let progressAttempt = 0;
		let progressMaxRetries = maxRetries;
		let progressKind: RetryFailureKind | undefined;
		let progressPosition: QueuePosition | undefined;
		let progressUsesTransientUpstreamWindow = false;
		const progressEnabled = options.onProgress !== undefined;
		let progressErrorLogged = false;
		const updateProgressState = (state: LaneRetryState | undefined) => {
			if (!state) return;
			progressAttempt = state.attempt;
			progressMaxRetries = state.maxRetries;
			progressKind = state.lastKind === "terminal" ? undefined : state.lastKind;
		};
		const publishProgress = (phase: AdaptiveRetryProgress["phase"]) => {
			if (!progressEnabled) return;
			try {
				const retryWindowRemainingMs =
					!progressUsesTransientUpstreamWindow || transientUpstreamRetryDeadlineAt === undefined
						? undefined
						: Math.max(0, transientUpstreamRetryDeadlineAt - now());
				options.onProgress?.({
					provider: options.model.provider,
					model: options.model.id,
					phase,
					attempt: progressAttempt,
					maxRetries: progressMaxRetries,
					kind: progressKind,
					queuePosition: progressPosition?.position,
					queueDepth: progressPosition?.depth,
					retryWindowMs: retryWindowRemainingMs === undefined ? undefined : upstream5xxRetryWindowMs,
					retryWindowRemainingMs,
				});
				progressErrorLogged = false;
			} catch (error) {
				if (!progressErrorLogged) {
					progressErrorLogged = true;
					options.logger?.warn?.("adaptive provider queue failed to update retry progress", {
						provider: options.model.provider,
						model: options.model.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		};
		const clearProgress = () => {
			if (!progressEnabled) return;
			try {
				options.onProgress?.(undefined);
				progressErrorLogged = false;
			} catch (error) {
				if (!progressErrorLogged) {
					progressErrorLogged = true;
					options.logger?.warn?.("adaptive provider queue failed to clear retry progress", {
						provider: options.model.provider,
						model: options.model.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		};
		try {
			const [hasWaiters, retryState] = sharedRetryRecovery
				? await Promise.all([options.queue.hasWaiters(laneId), options.queue.getRetryState(laneId)])
				: [false, undefined] as const;
			updateProgressState(retryState);
			const bypassActiveUpstreamCampaign =
				!retryTransientUpstream5xx &&
				retryState?.status === "active" &&
				TRANSIENT_UPSTREAM_STATUSES.has(retryState.lastStatus ?? 0);
			if (bypassActiveUpstreamCampaign) bypassedRetryState = retryState;
			if (!bypassActiveUpstreamCampaign && (hasWaiters || retryState)) {
				ticket = await options.queue.acquire(laneId);
			}
			const clearObservedRetryState = async () => {
				if (sharedRetryRecovery) {
					if (ticket) {
						await options.queue.clearRetryState(ticket);
					} else if (bypassedRetryState) {
						await options.queue.clearRetryStateSnapshot(laneId, bypassedRetryState);
					}
				}
				bypassedRetryState = undefined;
				clearProgress();
			};

			const waitForFrontRetryWindow = async (attemptStartedAt?: RetryAttemptSnapshot): Promise<RetryWindowDecision> => {
				if (!ticket) return { status: "ready", claimed: false };
				const queueDepth = await options.queue.waitForTurn(ticket, signal, position => {
					progressPosition = position;
					publishProgress(position.position > 1 || progressAttempt === 0 ? "queued" : "backoff");
				});
				options.logger?.info?.("adaptive provider queue request reached front", {
					provider: options.model.provider,
					model: options.model.id,
					queueDepth,
				});
				const decision = await options.queue.waitForRetryWindow(ticket, signal, attemptStartedAt);
				if (decision.state) updateProgressState(decision.state);
				progressPosition = { position: 1, depth: queueDepth };
				if (decision.status === "ready" && decision.state) publishProgress("requesting");
				else if (decision.status === "ready" && !decision.state) clearProgress();
				return decision;
			};

			const retryExhaustedError = (window: Extract<RetryWindowDecision, { status: "exhausted" }>) =>
				new AdaptiveRetryExhaustedError(window.state.attempt, window.state.maxRetries);

			while (!output.done) {
				if (ticket) {
					const window = await waitForFrontRetryWindow();
					if (window.status === "exhausted") {
						options.logger?.warn?.("adaptive provider queue shared retry budget is exhausted", {
							provider: options.model.provider,
							model: options.model.id,
							attempt: window.state.attempt,
							maxRetries: window.state.maxRetries,
						});
						throw retryExhaustedError(window);
					}
				}

				const replaySafeEvents: StreamEventLike[] = [];
				let replayUnsafe = false;
				let hasSubstantiveOutput = false;
				let retry = false;
				const pushEvent = (event: StreamEventLike) => {
					if (event.type === "start") {
						if (emittedStart) return;
						emittedStart = true;
					}
					if (event.type === "text_start") {
						if (emittedTextStart) return;
						emittedTextStart = true;
					}
					if (isThinkingEvent(event)) {
						if (replayCount > 0 && emittedThinking) return;
						emittedThinking = true;
					}
					output.push(event);
				};
				const flushReplaySafeEvents = () => {
					for (const event of replaySafeEvents) pushEvent(event);
					replaySafeEvents.length = 0;
				};
				const retryKind = (error: unknown): "rate-limit" | "transport" | undefined => {
					if (isAdaptiveRateLimit(error)) return "rate-limit";
					if (isAdaptiveTransientUpstream(error)) {
						return retryTransientUpstream5xx ? "transport" : undefined;
					}
					return isAdaptiveTransientTransport(error) ? "transport" : undefined;
				};
				const bypassesUpstreamRetry = (error: unknown): boolean =>
					!retryTransientUpstream5xx && isAdaptiveTransientUpstream(error);
				const waitForLocalRetry = async (
					error: unknown,
					kind: "rate-limit" | "transport",
				): Promise<boolean> => {
					const usesTransientUpstreamWindow =
						transientUpstream5xxMode === "retry-5m" && isAdaptiveTransientUpstream(error);
					if (usesTransientUpstreamWindow && transientUpstreamRetryDeadlineAt === undefined) {
						transientUpstreamRetryDeadlineAt = now() + upstream5xxRetryWindowMs;
					}
					if (
						usesTransientUpstreamWindow &&
						transientUpstreamRetryDeadlineAt !== undefined &&
						now() >= transientUpstreamRetryDeadlineAt
					) {
						options.logger?.warn?.("adaptive provider 5xx retry window expired", {
							provider: options.model.provider,
							model: options.model.id,
							attempt: localRetryAttempt,
							windowMs: upstream5xxRetryWindowMs,
						});
						return false;
					}
					const retryAfterMs = retryAfterMsFromError(error);
					if (!usesTransientUpstreamWindow && localRetryAttempt >= maxRetries) {
						progressAttempt = localRetryAttempt;
						progressMaxRetries = maxRetries;
						progressKind = kind;
						progressPosition = undefined;
						progressUsesTransientUpstreamWindow = false;
						publishProgress("backoff");
						options.logger?.warn?.("adaptive provider isolated retry limit reached", {
							provider: options.model.provider,
							model: options.model.id,
							kind,
							attempt: localRetryAttempt,
							maxRetries,
						});
						return false;
					}

					const attempt = usesTransientUpstreamWindow
						? ++transientUpstreamRetryAttempt
						: ++localRetryAttempt;
					const backoffDelayMs = options.queue.backoffDelayMs(attempt, retryAfterMs);
					const remainingWindowMs =
						!usesTransientUpstreamWindow || transientUpstreamRetryDeadlineAt === undefined
							? undefined
							: Math.max(0, transientUpstreamRetryDeadlineAt - now());
					const delayMs =
						remainingWindowMs === undefined ? backoffDelayMs : Math.min(backoffDelayMs, remainingWindowMs);
					progressAttempt = attempt;
					progressMaxRetries = maxRetries;
					progressKind = kind;
					progressPosition = undefined;
					progressUsesTransientUpstreamWindow = usesTransientUpstreamWindow;
					publishProgress("backoff");
					options.logger?.warn?.("adaptive provider isolated retry caught retryable error", {
						provider: options.model.provider,
						model: options.model.id,
						kind,
						attempt,
						maxRetries,
						delayMs,
						remainingWindowMs,
					});
					const countdown =
						usesTransientUpstreamWindow && delayMs >= 1_000 && progressEnabled
							? setInterval(() => publishProgress("backoff"), 1_000)
							: undefined;
					countdown?.unref?.();
					try {
						await sleep(delayMs, signal);
					} finally {
						if (countdown) clearInterval(countdown);
					}
					if (
						usesTransientUpstreamWindow &&
						transientUpstreamRetryDeadlineAt !== undefined &&
						now() >= transientUpstreamRetryDeadlineAt
					) {
						publishProgress("backoff");
						options.logger?.warn?.("adaptive provider 5xx retry window expired", {
							provider: options.model.provider,
							model: options.model.id,
							attempt,
							windowMs: upstream5xxRetryWindowMs,
						});
						return false;
					}
					nextAttemptUsesTransientUpstreamDeadline = usesTransientUpstreamWindow;
					publishProgress("requesting");
					replayCount += 1;
					return true;
				};
				const waitForRetry = async (
					error: unknown,
					kind: "rate-limit" | "transport",
					attemptStartedAt: RetryAttemptSnapshot,
				): Promise<boolean> => {
					if (!sharedRetryRecovery) return waitForLocalRetry(error, kind);
					let joinedBehindAnotherRequest = false;
					if (!ticket) {
						ticket = await options.queue.acquire(laneId);
						joinedBehindAnotherRequest = (await options.queue.position(ticket)) > 0;
					}

					const currentWindow = await waitForFrontRetryWindow(attemptStartedAt);
					if (currentWindow.status === "exhausted") {
						options.logger?.warn?.("adaptive provider queue shared retry budget is exhausted", {
							provider: options.model.provider,
							model: options.model.id,
							kind,
							attempt: currentWindow.state.attempt,
							maxRetries: currentWindow.state.maxRetries,
						});
						return false;
					}

					if (
						currentWindow.claimed ||
						currentWindow.recoveredSinceRequest ||
						(joinedBehindAnotherRequest && !currentWindow.state)
					) {
						if (!currentWindow.state) clearProgress();
						replayCount += 1;
						options.logger?.info?.("adaptive provider queue discarded a stale concurrent failure", {
							provider: options.model.provider,
							model: options.model.id,
							observedRecovery: !currentWindow.state,
							recoveredSinceRequest: currentWindow.recoveredSinceRequest,
							tookOverProbe: currentWindow.claimed,
						});
						return true;
					}

					const retryAfterMs = retryAfterMsFromError(error);
					const decision = await options.queue.recordRetryFailure(ticket, {
						maxRetries,
						retryAfterMs,
						kind,
						status: transientUpstreamStatus(error),
					});
					if (decision.status === "exhausted") {
						progressAttempt = decision.attempt;
						progressMaxRetries = decision.maxRetries;
						progressKind = kind;
						publishProgress("backoff");
						options.logger?.warn?.("adaptive provider queue retry limit reached", {
							provider: options.model.provider,
							model: options.model.id,
							kind,
							attempt: decision.attempt,
							maxRetries: decision.maxRetries,
						});
						return false;
					}
					progressAttempt = decision.attempt;
					progressMaxRetries = decision.maxRetries;
					progressKind = kind;
					publishProgress("backoff");

					options.logger?.warn?.("adaptive provider queue caught retryable error", {
						provider: options.model.provider,
						model: options.model.id,
						kind,
						attempt: decision.attempt,
						maxRetries: decision.maxRetries,
						delayMs: decision.delayMs,
					});
					const retryWindow = await options.queue.waitForRetryWindow(ticket, signal);
					if (retryWindow.status === "exhausted") return false;
					if (retryWindow.state) updateProgressState(retryWindow.state);
					publishProgress("requesting");
					replayCount += 1;
					return true;
				};

				const attemptStartedAt = sharedRetryRecovery
					? await options.queue.captureRetryAttempt(laneId)
					: {};
				let attemptGuard: AttemptGuard | undefined;
				let requestCountdown: ReturnType<typeof setInterval> | undefined;
				const disposeAttemptGuard = () => {
					if (requestCountdown) clearInterval(requestCountdown);
					requestCountdown = undefined;
					attemptGuard?.dispose();
					attemptGuard = undefined;
				};
				const disableAttemptDeadline = () => {
					if (requestCountdown) clearInterval(requestCountdown);
					requestCountdown = undefined;
					attemptGuard?.disableDeadline();
				};
				const forwardLastTransientUpstreamFailure = async () => {
					if (signal?.aborted) throw cancellationError();
					const failure = lastTransientUpstreamFailure;
					if (!failure) throw new TransientUpstreamRetryWindowExpiredError();
					replaySafeEvents.length = 0;
					ticket = await releaseTicket(options.queue, ticket);
					if (signal?.aborted) throw cancellationError();
					for (const event of failure.prefix) pushEvent(event);
					if (failure.type === "event") {
						pushEvent(failure.event);
						return;
					}
					throw failure.error;
				};
				try {
					if (signal?.aborted) throw cancellationError();
					const usesTransientUpstreamDeadline = nextAttemptUsesTransientUpstreamDeadline;
					nextAttemptUsesTransientUpstreamDeadline = false;
					if (
						usesTransientUpstreamDeadline &&
						transientUpstreamRetryDeadlineAt !== undefined &&
						now() >= transientUpstreamRetryDeadlineAt
					) {
						await forwardLastTransientUpstreamFailure();
						return;
					}
					attemptGuard = createAttemptGuard({
						parentSignal: signal,
						deadlineAt: usesTransientUpstreamDeadline ? transientUpstreamRetryDeadlineAt : undefined,
						now,
						scheduleTimeout,
					});
					if (attemptGuard?.deadlineExpired()) {
						await forwardLastTransientUpstreamFailure();
						return;
					}
					if (
						usesTransientUpstreamDeadline &&
						progressEnabled &&
						transientUpstreamRetryDeadlineAt !== undefined &&
						transientUpstreamRetryDeadlineAt - now() >= 1_000
					) {
						requestCountdown = setInterval(() => publishProgress("requesting"), 1_000);
						requestCountdown.unref?.();
					}
					const input = options.createInputStream(attemptGuard?.signal ?? signal);
					for await (const event of guardedEvents(input, attemptGuard)) {
						if (signal?.aborted) throw cancellationError();
						const deadlineExpired = attemptGuard?.deadlineExpired() ?? false;
						if (event.type === "done" || event.type === "error") disposeAttemptGuard();
						if (deadlineExpired) {
							await forwardLastTransientUpstreamFailure();
							return;
						}
						if (!replayUnsafe && isReplaySafeBoundary(event)) {
							replaySafeEvents.push(event);
							continue;
						}

						const cancelled = event.type === "error" && isCancellation(event.error, signal);
						const kind = retryKind(event.error);
						if (
							event.type === "error" &&
							!cancelled &&
							!hasSubstantiveOutput &&
							!substantiveContentExists(event.error) &&
							kind !== undefined
						) {
							if (
								transientUpstream5xxMode === "retry-5m" &&
								isAdaptiveTransientUpstream(event.error)
							) {
								lastTransientUpstreamFailure = {
									type: "event",
									event,
									prefix: [...replaySafeEvents],
								};
							}
							if (await waitForRetry(event.error, kind, attemptStartedAt)) {
								retry = true;
								break;
							}
							if (signal?.aborted) throw cancellationError();
							flushReplaySafeEvents();
							ticket = await releaseTicket(options.queue, ticket);
							if (signal?.aborted) throw cancellationError();
							pushEvent(event);
							return;
						}

						flushReplaySafeEvents();
						replayUnsafe = event.type !== "error";
						const eventHasSubstantiveOutput = isSubstantiveOutputEvent(event);
						hasSubstantiveOutput ||= eventHasSubstantiveOutput;
						if (eventHasSubstantiveOutput || substantiveContentExists(event.error)) {
							disableAttemptDeadline();
							await clearObservedRetryState();
							ticket = await releaseTicket(options.queue, ticket);
						} else if (
							event.type === "error" &&
							!cancelled &&
							ticket &&
							!bypassesUpstreamRetry(event.error)
						) {
							await options.queue.markRetryStateExhausted(ticket);
						}
						if (event.type === "done" || event.type === "error") {
							if (event.type === "done") await clearObservedRetryState();
							ticket = await releaseTicket(options.queue, ticket);
							if (signal?.aborted) throw cancellationError();
							pushEvent(event);
							return;
						}
						pushEvent(event);
					}

					if (retry) continue;
					if (!output.done) {
						const result = attemptGuard
							? await Promise.race([input.result(), attemptGuard.interrupted])
							: await input.result();
						flushReplaySafeEvents();
						throw new Error(`Provider stream ended without a terminal event (${result.stopReason ?? "unknown"})`);
					}
				} catch (error) {
					const deadlineExpired = attemptGuard?.deadlineExpired() ?? false;
					disposeAttemptGuard();
					if (signal?.aborted) throw cancellationError();
					if (deadlineExpired || error instanceof TransientUpstreamRetryWindowExpiredError) {
						await forwardLastTransientUpstreamFailure();
						return;
					}
					const cancelled = isCancellation(error, signal);
					const kind = retryKind(error);
					if (!cancelled && !hasSubstantiveOutput && kind !== undefined) {
						if (
							transientUpstream5xxMode === "retry-5m" &&
							isAdaptiveTransientUpstream(error)
						) {
							lastTransientUpstreamFailure = { type: "throw", error, prefix: [...replaySafeEvents] };
						}
						if (await waitForRetry(error, kind, attemptStartedAt)) continue;
					}
					if (signal?.aborted) throw cancellationError();
					flushReplaySafeEvents();
					if (!hasSubstantiveOutput && !cancelled && ticket && !bypassesUpstreamRetry(error)) {
						await options.queue.markRetryStateExhausted(ticket);
					}
					throw error;
				} finally {
					disposeAttemptGuard();
				}
			}
		} catch (error) {
			if (!output.done) output.fail(error);
		} finally {
			clearProgress();
			if (ticket) {
				await options.queue.release(ticket).catch(error => {
					options.logger?.warn?.("adaptive provider queue failed to release ticket", {
						provider: options.model.provider,
						model: options.model.id,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		}
	})();

	return output;
}
