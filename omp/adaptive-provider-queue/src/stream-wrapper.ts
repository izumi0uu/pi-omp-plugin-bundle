import { AdaptiveProviderQueue, createLaneId, sleepWithSignal, type QueueTicket } from "./queue.ts";

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
	maxTransportRetries?: number;
	transportRetryBaseDelayMs?: number;
	createOutputStream(): TOutput;
	createInputStream(): InputStreamLike;
	logger?: QueueLogger;
}

export const DEFAULT_MAX_RETRIES = 50;
export const DEFAULT_MAX_TRANSPORT_RETRIES = 3;
export const DEFAULT_TRANSPORT_RETRY_BASE_DELAY_MS = 2_000;
const MAX_TRANSPORT_RETRY_DELAY_MS = 15_000;

const QUOTA_OR_BILLING_PATTERN =
	/insufficient[_ -]?quota|quota (?:exceeded|exhausted)|resource[_ -]?exhausted|usage[_ -]?limit[_ -]?reached|billing|credit|balance|spend(?:ing)?[_ -]?limit|monthly[_ -]?limit|daily[_ -]?limit/i;
const MODEL_UNAVAILABLE_PATTERN =
	/model.{0,40}(?:unavailable|not available|disabled|offline|not found|overloaded)|no available (?:model|channel|route)|no capacity|capacity exhausted|upstream unavailable|overloaded/i;
const TRANSIENT_RATE_LIMIT_PATTERN =
	/concurren(?:cy|t)|too many pending requests|too many requests|rate[_ -]?limit(?:ed| exceeded)?|retry (?:again )?later/i;
const EXPLICIT_RATE_LIMIT_PATTERN =
	/concurren(?:cy|t)|too many pending requests|too many requests|rate[_ -]?limit[_ -]?exceeded|rate limit exceeded/i;
const TRANSIENT_TRANSPORT_PATTERN =
	/stream[_ -]?read[_ -]?error|socket connection (?:was )?closed|connection (?:reset|closed|aborted)|(?:fetch|network) (?:failed|error)|econnreset|econnrefused|etimedout|broken pipe|premature (?:stream|connection) close|upstream (?:reset|closed|disconnected)/i;

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
	if (status === 429) return text.length === 0 || TRANSIENT_RATE_LIMIT_PATTERN.test(text) || !/\b(?:401|403|5\d\d)\b/.test(text);
	return status === undefined && EXPLICIT_RATE_LIMIT_PATTERN.test(text);
}

export function isAdaptiveTransientTransport(error: unknown): boolean {
	const text = errorText(error);
	if (QUOTA_OR_BILLING_PATTERN.test(text) || MODEL_UNAVAILABLE_PATTERN.test(text)) return false;
	if (errorStatus(error) !== undefined || isAdaptiveRateLimit(error)) return false;
	return TRANSIENT_TRANSPORT_PATTERN.test(text);
}

export function transportRetryDelayMs(attempt: number, baseDelayMs = DEFAULT_TRANSPORT_RETRY_BASE_DELAY_MS): number {
	const retryNumber = Math.max(1, Math.floor(attempt));
	const base = Math.max(0, baseDelayMs);
	return Math.min(MAX_TRANSPORT_RETRY_DELAY_MS, base * 2 ** Math.min(20, retryNumber - 1));
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

function semanticContentExists(message: AssistantLike | undefined): boolean {
	const content = message?.content;
	if (!Array.isArray(content)) return false;
	return content.some(block => {
		if (!block || typeof block !== "object") return false;
		const item = block as Record<string, unknown>;
		if (item.type === "text") return typeof item.text === "string" && item.text.length > 0;
		if (item.type === "thinking") return typeof item.thinking === "string" && item.thinking.length > 0;
		return item.type === "toolCall" || item.type === "image" || item.type === "redactedThinking";
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

export function createAdaptiveStream<TOutput extends OutputStreamLike>(options: AdaptiveStreamOptions<TOutput>): TOutput {
	const output = options.createOutputStream();
	const signal = options.requestOptions?.signal;
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
	const maxTransportRetries = Math.max(0, Math.floor(options.maxTransportRetries ?? DEFAULT_MAX_TRANSPORT_RETRIES));
	const transportRetryBaseDelayMs = Math.max(0, options.transportRetryBaseDelayMs ?? DEFAULT_TRANSPORT_RETRY_BASE_DELAY_MS);
	const laneId = createLaneId({
		provider: options.model.provider,
		baseUrl: options.model.baseUrl,
		apiKey: options.requestOptions?.apiKey,
	});

	void (async () => {
		let ticket: QueueTicket | undefined;
		let rateLimitAttempt = 0;
		let transportAttempt = 0;
		let emittedStart = false;
		let emittedTextStart = false;
		let emittedThinking = false;
		try {
			if (await options.queue.hasWaiters(laneId)) {
				ticket = await options.queue.acquire(laneId);
			}

			while (!output.done) {
				if (ticket) {
					const queueDepth = await options.queue.waitForTurn(ticket, signal);
					options.logger?.info?.("adaptive provider queue request reached front", {
						provider: options.model.provider,
						model: options.model.id,
						queueDepth,
					});
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
						if (transportAttempt > 0 && emittedThinking) return;
						emittedThinking = true;
					}
					output.push(event);
				};
				const flushReplaySafeEvents = () => {
					for (const event of replaySafeEvents) pushEvent(event);
					replaySafeEvents.length = 0;
				};
				const waitForRateLimitRetry = async (error: unknown): Promise<boolean> => {
					const retryNumber = rateLimitAttempt + 1;
					if (retryNumber > maxRetries) {
						options.logger?.warn?.("adaptive provider queue retry limit reached", {
							provider: options.model.provider,
							model: options.model.id,
							attempt: rateLimitAttempt,
							maxRetries,
						});
						return false;
					}
					rateLimitAttempt = retryNumber;
					ticket ??= await options.queue.acquire(laneId);
					const retryAfterMs = retryAfterMsFromError(error);
					const delayMs = options.queue.backoffDelayMs(retryNumber, retryAfterMs);
					options.logger?.warn?.("adaptive provider queue caught transient rate limit", {
						provider: options.model.provider,
						model: options.model.id,
						attempt: retryNumber,
						maxRetries,
						delayMs,
					});
					await sleepWithSignal(delayMs, signal);
					return true;
				};
				const waitForTransportRetry = async (error: unknown): Promise<boolean> => {
					const retryNumber = transportAttempt + 1;
					if (retryNumber > maxTransportRetries) {
						options.logger?.warn?.("adaptive provider transport retry limit reached", {
							provider: options.model.provider,
							model: options.model.id,
							attempt: transportAttempt,
							maxRetries: maxTransportRetries,
						});
						return false;
					}
					transportAttempt = retryNumber;
					const retryAfterMs = retryAfterMsFromError(error);
					const delayMs = Math.min(
						MAX_TRANSPORT_RETRY_DELAY_MS,
						Math.max(transportRetryDelayMs(retryNumber, transportRetryBaseDelayMs), retryAfterMs ?? 0),
					);
					options.logger?.warn?.("adaptive provider queue caught transient transport error", {
						provider: options.model.provider,
						model: options.model.id,
						attempt: retryNumber,
						maxRetries: maxTransportRetries,
						delayMs,
					});
					await sleepWithSignal(delayMs, signal);
					return true;
				};

				try {
					const input = options.createInputStream();
					for await (const event of input) {
						if (!replayUnsafe && isReplaySafeBoundary(event)) {
							replaySafeEvents.push(event);
							continue;
						}

						if (
							!replayUnsafe &&
							event.type === "error" &&
							!semanticContentExists(event.error) &&
							isAdaptiveRateLimit(event.error)
						) {
							if (await waitForRateLimitRetry(event.error)) {
								retry = true;
								break;
							}
							flushReplaySafeEvents();
							output.push(event);
							ticket = await releaseTicket(options.queue, ticket);
							return;
						}

						if (
							event.type === "error" &&
							!hasSubstantiveOutput &&
							!semanticContentExists(event.error) &&
							isAdaptiveTransientTransport(event.error)
						) {
							if (await waitForTransportRetry(event.error)) {
								retry = true;
								break;
							}
							flushReplaySafeEvents();
							pushEvent(event);
							ticket = await releaseTicket(options.queue, ticket);
							return;
						}

						flushReplaySafeEvents();
						replayUnsafe = event.type !== "error";
						hasSubstantiveOutput ||= isSubstantiveOutputEvent(event);
						pushEvent(event);
						if (event.type === "done" || event.type === "error") {
							ticket = await releaseTicket(options.queue, ticket);
							return;
						}
					}

					if (retry) continue;
					if (!output.done) {
						const result = await input.result();
						flushReplaySafeEvents();
						ticket = await releaseTicket(options.queue, ticket);
						throw new Error(`Provider stream ended without a terminal event (${result.stopReason ?? "unknown"})`);
					}
				} catch (error) {
					if (!replayUnsafe && isAdaptiveRateLimit(error)) {
						if (await waitForRateLimitRetry(error)) continue;
					}
					if (!hasSubstantiveOutput && isAdaptiveTransientTransport(error)) {
						if (await waitForTransportRetry(error)) continue;
					}
					flushReplaySafeEvents();
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
