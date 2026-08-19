import type { RetryFailureKind } from "./queue.ts";

export const RETRY_PROGRESS_STATUS_KEY = "adaptive-provider-queue:retry-progress";
const PROGRESS_BAR_WIDTH = 12;
const SHARED_RETRY_STATUS_CONTROLLER = Symbol.for("omp.adaptive-provider-queue.retry-progress.v1");

export type RetryProgressKind = RetryFailureKind | "provider";

export interface AdaptiveRetryProgress {
	readonly provider: string;
	readonly model?: string;
	readonly phase: "queued" | "backoff" | "requesting";
	readonly attempt: number;
	readonly maxRetries: number;
	readonly kind?: RetryProgressKind;
	readonly queuePosition?: number;
	readonly queueDepth?: number;
	readonly retryWindowMs?: number;
	readonly retryWindowRemainingMs?: number;
}

export interface RetryStatusTarget {
	setStatus(key: string, text: string | undefined): void;
}

const PROVIDER_LABELS: Record<string, string> = {
	aiinput: "AI Input",
	"aiinput-overseas": "AI Input overseas",
	"aiinput2-overseas": "AI Input 2 overseas",
	tokenking: "TokenKing",
	"tokenking-grok": "TokenKing Grok",
	"kimi-code": "Kimi Code",
};

function progressBar(attempt: number, maxRetries: number): string {
	const boundedMax = Math.max(1, Math.floor(maxRetries));
	const boundedAttempt = Math.max(0, Math.min(boundedMax, Math.floor(attempt)));
	const filled = boundedAttempt === 0 ? 0 : Math.max(1, Math.ceil((boundedAttempt / boundedMax) * PROGRESS_BAR_WIDTH));
	return `[${"#".repeat(filled)}${"-".repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

function remainingTime(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1_000));
	if (seconds === 0) return "now";
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return minutes > 0 ? `${minutes}m${remainder.toString().padStart(2, "0")}s` : `${remainder}s`;
}

export function formatRetryProgress(progress: AdaptiveRetryProgress): string {
	const provider = PROVIDER_LABELS[progress.provider] ?? progress.provider;
	const attempt = Math.max(0, Math.floor(progress.attempt));
	const maxRetries = Math.max(0, Math.floor(progress.maxRetries));
	if (progress.retryWindowMs !== undefined && progress.retryWindowRemainingMs !== undefined) {
		const windowMs = Math.max(1, Math.floor(progress.retryWindowMs));
		const remainingMs = Math.max(0, Math.min(windowMs, Math.floor(progress.retryWindowRemainingMs)));
		const elapsedMs = windowMs - remainingMs;
		const count = attempt > 0 ? ` ${attempt}` : "";
		return `${provider} retry${count} ${progressBar(elapsedMs, windowMs)} 5xx fallback in ${remainingTime(remainingMs)}`;
	}
	const action = progress.phase === "queued" ? "queued" : "retry";
	const count = attempt > 0 ? ` ${attempt}/${maxRetries}` : "";
	const kind = progress.kind === "rate-limit" ? " rate limit" : progress.kind ? ` ${progress.kind}` : "";
	const queue =
		progress.queuePosition !== undefined && progress.queueDepth !== undefined
			? ` q${progress.queuePosition}/${progress.queueDepth}`
			: "";
	return `${provider} ${action}${count} ${progressBar(attempt, maxRetries)}${kind}${queue}`;
}

/** Keeps one replaceable status slot per interactive OMP process. */
export class RetryStatusController {
	private activeSession: { sessionId: string; target: RetryStatusTarget } | undefined;
	private nextGeneration = 0;
	private activeGeneration = 0;
	private lastText: string | undefined;

	bindSession(sessionId: string, target: RetryStatusTarget): void {
		if (this.activeSession?.sessionId === sessionId && this.activeSession.target === target) return;
		if (this.activeSession && this.lastText !== undefined) {
			try {
				this.activeSession.target.setStatus(RETRY_PROGRESS_STATUS_KEY, undefined);
			} catch {
				// A stale status must not prevent the new interactive session from binding.
			}
		}
		this.activeSession = { sessionId, target };
		this.activeGeneration = 0;
		this.lastText = undefined;
	}

	createReporter(sessionId?: string): (progress: AdaptiveRetryProgress | undefined) => void {
		const binding = this.activeSession;
		if (!binding || sessionId === undefined || binding.sessionId !== sessionId) return () => {};
		const generation = ++this.nextGeneration;
		return progress => {
			if (this.activeSession !== binding) return;
			if (progress === undefined) {
				if (this.activeGeneration !== generation) return;
				binding.target.setStatus(RETRY_PROGRESS_STATUS_KEY, undefined);
				this.activeGeneration = 0;
				this.lastText = undefined;
				return;
			}
			if (generation < this.activeGeneration) return;
			const text = formatRetryProgress(progress);
			if (generation === this.activeGeneration && text === this.lastText) return;
			binding.target.setStatus(RETRY_PROGRESS_STATUS_KEY, text);
			this.activeGeneration = generation;
			this.lastText = text;
		};
	}
}

function isRetryStatusController(value: unknown): value is RetryStatusController {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RetryStatusController>;
	return typeof candidate.bindSession === "function" && typeof candidate.createReporter === "function";
}

/** Shared across extension instances so old streams cannot clear a newer instance's status. */
export function sharedRetryStatusController(): RetryStatusController {
	const root = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = root[SHARED_RETRY_STATUS_CONTROLLER];
	if (isRetryStatusController(existing)) return existing;
	const created = new RetryStatusController();
	root[SHARED_RETRY_STATUS_CONTROLLER] = created;
	return created;
}
