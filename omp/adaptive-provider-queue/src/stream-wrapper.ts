import { AdaptiveProviderQueue, createLaneId, type QueueTicket, type RetryWindowDecision } from "./queue.ts";

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

export interface QueueLogger {
	info?(message: string, fields?: Record<string, unknown>): void;
	warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface AdaptiveStreamOptions<TOutput extends OutputStreamLike = OutputStreamLike> {
	model: { provider: string; id?: string; baseUrl?: string; [key: string]: unknown };
	requestOptions?: { apiKey?: unknown; signal?: AbortSignal; [key: string]: unknown };
	queue: AdaptiveProviderQueue;
	maxRetries?: number;
	createOutputStream(): TOutput;
	createInputStream(): InputStreamLike;
	logger?: QueueLogger;
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
const TRANSIENT_TRANSPORT_PATTERN =
	/stream[_ -]?read[_ -]?error|socket connection (?:was )?closed|connection (?:reset|closed|aborted)|(?:fetch|network) (?:failed|error)|econnreset|econnrefused|etimedout|timed? out|timeout|broken pipe|premature (?:stream|connection) close|upstream (?:reset|closed|disconnected)|up[_ -]?stream[_ -]?break|missing[_ -]?terminal|stream ended without (?:response\.completed|a terminal event)/i;

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
		return status === undefined || status === 429 || status === 503;
	}
	if (status === 429) return text.length === 0 || TRANSIENT_RATE_LIMIT_PATTERN.test(text) || !/\b(?:401|403|5\d\d)\b/.test(text);
	return status === undefined && EXPLICIT_RATE_LIMIT_PATTERN.test(text);
}

export function isAdaptiveTransientTransport(error: unknown): boolean {
	const text = errorText(error);
	if (QUOTA_OR_BILLING_PATTERN.test(text) || MODEL_UNAVAILABLE_PATTERN.test(text)) return false;
	if (errorStatus(error) !== undefined || isAdaptiveRateLimit(error)) return false;
	return TRANSIENT_TRANSPORT_PATTERN.test(text);
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
	await queue.release(ticket);
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

export function createAdaptiveStream<TOutput extends OutputStreamLike>(options: AdaptiveStreamOptions<TOutput>): TOutput {
	const output = options.createOutputStream();
	const signal = options.requestOptions?.signal;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
	const laneId = createLaneId({
		provider: options.model.provider,
		baseUrl: options.model.baseUrl,
		apiKey: options.requestOptions?.apiKey,
	});

	void (async () => {
		let ticket: QueueTicket | undefined;
		let replayCount = 0;
		let emittedStart = false;
		let emittedTextStart = false;
		let emittedThinking = false;
		try {
			const [hasWaiters, hasRetryState] = await Promise.all([
				options.queue.hasWaiters(laneId),
				options.queue.hasRetryState(laneId),
			]);
			if (hasWaiters || hasRetryState) {
				ticket = await options.queue.acquire(laneId);
			}

			const waitForFrontRetryWindow = async (): Promise<RetryWindowDecision> => {
				if (!ticket) return { status: "ready", claimed: false };
				const queueDepth = await options.queue.waitForTurn(ticket, signal);
				options.logger?.info?.("adaptive provider queue request reached front", {
					provider: options.model.provider,
					model: options.model.id,
					queueDepth,
				});
				return options.queue.waitForRetryWindow(ticket, signal);
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
				const waitForRetry = async (error: unknown, kind: "rate-limit" | "transport"): Promise<boolean> => {
					let joinedBehindAnotherRequest = false;
					if (!ticket) {
						ticket = await options.queue.acquire(laneId);
						joinedBehindAnotherRequest = (await options.queue.position(ticket)) > 0;
					}

					const currentWindow = await waitForFrontRetryWindow();
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

					if (currentWindow.claimed || (joinedBehindAnotherRequest && !currentWindow.state)) {
						replayCount += 1;
						options.logger?.info?.("adaptive provider queue discarded a stale concurrent failure", {
							provider: options.model.provider,
							model: options.model.id,
							observedRecovery: !currentWindow.state,
							tookOverProbe: currentWindow.claimed,
						});
						return true;
					}

					const retryAfterMs = retryAfterMsFromError(error);
					const decision = await options.queue.recordRetryFailure(ticket, {
						maxRetries,
						retryAfterMs,
						kind,
					});
					if (decision.status === "exhausted") {
						options.logger?.warn?.("adaptive provider queue retry limit reached", {
							provider: options.model.provider,
							model: options.model.id,
							kind,
							attempt: decision.attempt,
							maxRetries: decision.maxRetries,
						});
						return false;
					}

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
					replayCount += 1;
					return true;
				};

				try {
					const input = options.createInputStream();
					for await (const event of input) {
						if (!replayUnsafe && isReplaySafeBoundary(event)) {
							replaySafeEvents.push(event);
							continue;
						}

						const cancelled = event.type === "error" && isCancellation(event.error, signal);
						const retryKind = isAdaptiveRateLimit(event.error)
							? "rate-limit"
							: isAdaptiveTransientTransport(event.error)
								? "transport"
								: undefined;
						if (
							event.type === "error" &&
							!cancelled &&
							!hasSubstantiveOutput &&
							!substantiveContentExists(event.error) &&
							retryKind !== undefined
						) {
							if (await waitForRetry(event.error, retryKind)) {
								retry = true;
								break;
							}
							flushReplaySafeEvents();
							ticket = await releaseTicket(options.queue, ticket);
							pushEvent(event);
							return;
						}

						flushReplaySafeEvents();
						replayUnsafe = event.type !== "error";
						const eventHasSubstantiveOutput = isSubstantiveOutputEvent(event);
						hasSubstantiveOutput ||= eventHasSubstantiveOutput;
						if (eventHasSubstantiveOutput || substantiveContentExists(event.error)) {
							await options.queue.clearRetryState(ticket);
							ticket = await releaseTicket(options.queue, ticket);
						} else if (event.type === "error" && !cancelled && ticket) {
							await options.queue.markRetryStateExhausted(ticket);
						}
						if (event.type === "done" || event.type === "error") {
							if (event.type === "done") await options.queue.clearRetryState(ticket);
							ticket = await releaseTicket(options.queue, ticket);
							pushEvent(event);
							return;
						}
						pushEvent(event);
					}

					if (retry) continue;
					if (!output.done) {
						const result = await input.result();
						flushReplaySafeEvents();
						throw new Error(`Provider stream ended without a terminal event (${result.stopReason ?? "unknown"})`);
					}
				} catch (error) {
					const cancelled = isCancellation(error, signal);
					const retryKind = isAdaptiveRateLimit(error)
						? "rate-limit"
						: isAdaptiveTransientTransport(error)
							? "transport"
							: undefined;
					if (!cancelled && !hasSubstantiveOutput && retryKind !== undefined) {
						if (await waitForRetry(error, retryKind)) continue;
					}
					flushReplaySafeEvents();
					if (!hasSubstantiveOutput && !cancelled && ticket) {
						await options.queue.markRetryStateExhausted(ticket);
					}
					throw error;
				}
			}
		} catch (error) {
			if (!output.done) output.fail(error);
		} finally {
			await options.queue.release(ticket).catch(error => {
				options.logger?.warn?.("adaptive provider queue failed to release ticket", {
					provider: options.model.provider,
					model: options.model.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	})();

	return output;
}
