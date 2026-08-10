import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface QueueTicket {
	readonly laneId: string;
	readonly laneDir: string;
	readonly fileName: string;
	readonly filePath: string;
	heartbeat: ReturnType<typeof setInterval> | undefined;
	released: boolean;
}

export interface AdaptiveQueueOptions {
	rootDir?: string;
	pollMs?: number;
	staleMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	retryStateTtlMs?: number;
	random?: () => number;
}

export type RetryFailureKind = "rate-limit" | "transport";

export interface LaneRetryState {
	readonly version: 1;
	readonly status: "active" | "exhausted";
	readonly attempt: number;
	readonly maxRetries: number;
	readonly ownerFileName: string;
	readonly nextRetryAt: number;
	readonly updatedAt: number;
	readonly expiresAt: number;
	readonly lastKind: RetryFailureKind | "terminal";
}

export type RetryFailureDecision =
	| { status: "retry"; attempt: number; maxRetries: number; delayMs: number }
	| { status: "exhausted"; attempt: number; maxRetries: number };

export type RetryWindowDecision =
	| { status: "ready"; state?: LaneRetryState; claimed: boolean }
	| { status: "exhausted"; state: LaneRetryState };

const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_FIRST_STAGE_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 300_000;
const DEFAULT_RETRY_STATE_TTL_MS = 300_000;
const RETRY_STAGE_SIZE = 10;
const RETRY_STAGE_DELAYS_MS = [60_000, 120_000, 180_000, 300_000] as const;
const HEARTBEAT_DIVISOR = 3;
const RETRY_STATE_FILE_NAME = "retry-state.json";

let ticketSequence = 0;

function defaultQueueRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
	return path.join(path.dirname(agentDir), "run", "adaptive-provider-queue");
}

function sanitizeEndpoint(baseUrl: string | undefined): string {
	if (!baseUrl) return "unknown-endpoint";
	try {
		return new URL(baseUrl).origin;
	} catch {
		return baseUrl.trim().toLowerCase();
	}
}

/** The credential is hashed and never persisted in queue metadata. */
export function createLaneId(input: {
	provider: string;
	baseUrl?: string;
	apiKey?: unknown;
}): string {
	const credentialScope = typeof input.apiKey === "string" && input.apiKey.length > 0 ? input.apiKey : input.provider;
	return createHash("sha256")
		.update(`${sanitizeEndpoint(input.baseUrl)}\0${credentialScope}`)
		.digest("base64url");
}

function abortError(): Error {
	return new DOMException("Adaptive provider queue wait aborted", "AbortError");
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
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
		const onAbort = () => finish(abortError());
		const timer = setTimeout(() => finish(), Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function readTicketPid(filePath: string): Promise<number | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { pid?: unknown };
		return typeof parsed.pid === "number" ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

export class AdaptiveProviderQueue {
	readonly rootDir: string;
	readonly pollMs: number;
	readonly staleMs: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly retryStateTtlMs: number;
	readonly random: () => number;

	constructor(options: AdaptiveQueueOptions = {}) {
		this.rootDir = options.rootDir ?? defaultQueueRoot();
		this.pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
		this.staleMs = Math.max(1_000, options.staleMs ?? DEFAULT_STALE_MS);
		this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
		this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
		this.retryStateTtlMs = Math.max(1_000, options.retryStateTtlMs ?? DEFAULT_RETRY_STATE_TTL_MS);
		this.random = options.random ?? Math.random;
	}

	private laneDir(laneId: string): string {
		return path.join(this.rootDir, laneId);
	}

	private async ensureLaneDir(laneId: string): Promise<string> {
		const laneDir = this.laneDir(laneId);
		await fs.mkdir(laneDir, { recursive: true, mode: 0o700 });
		return laneDir;
	}

	private retryStatePath(laneId: string): string {
		return path.join(this.laneDir(laneId), RETRY_STATE_FILE_NAME);
	}

	private parseRetryState(value: unknown): LaneRetryState | undefined {
		if (!value || typeof value !== "object") return undefined;
		const candidate = value as Record<string, unknown>;
		if (candidate.version !== 1 || (candidate.status !== "active" && candidate.status !== "exhausted")) return undefined;
		if (!Number.isInteger(candidate.attempt) || (candidate.attempt as number) < 0) return undefined;
		if (!Number.isInteger(candidate.maxRetries) || (candidate.maxRetries as number) < 0) return undefined;
		if (
			typeof candidate.ownerFileName !== "string" ||
			!candidate.ownerFileName.endsWith(".ticket") ||
			path.basename(candidate.ownerFileName) !== candidate.ownerFileName
		) {
			return undefined;
		}
		if (typeof candidate.nextRetryAt !== "number" || !Number.isFinite(candidate.nextRetryAt)) return undefined;
		if (typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)) return undefined;
		if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) return undefined;
		if (candidate.lastKind !== "rate-limit" && candidate.lastKind !== "transport" && candidate.lastKind !== "terminal") return undefined;
		return candidate as unknown as LaneRetryState;
	}

	private async readRetryState(laneId: string): Promise<LaneRetryState | undefined> {
		const statePath = this.retryStatePath(laneId);
		let raw: string;
		try {
			raw = await fs.readFile(statePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			return undefined;
		}
		const state = this.parseRetryState(parsed);
		if (!state) return undefined;
		if (state.expiresAt > Date.now()) return state;
		if (state.status === "active") {
			try {
				await fs.stat(path.join(this.laneDir(laneId), state.ownerFileName));
				return state;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return undefined;
	}

	private async writeRetryState(laneId: string, state: LaneRetryState): Promise<void> {
		const laneDir = await this.ensureLaneDir(laneId);
		const statePath = this.retryStatePath(laneId);
		const tempPath = path.join(laneDir, `.retry-state-${process.pid}-${randomUUID()}.tmp`);
		try {
			await fs.writeFile(tempPath, JSON.stringify(state), { encoding: "utf8", flag: "wx", mode: 0o600 });
			await fs.rename(tempPath, statePath);
		} finally {
			await fs.unlink(tempPath).catch(() => {});
		}
	}

	private async listLiveTicketNames(laneId: string): Promise<string[]> {
		const laneDir = await this.ensureLaneDir(laneId);
		const names = (await fs.readdir(laneDir)).filter(name => name.endsWith(".ticket")).sort();
		const live: string[] = [];
		for (const name of names) {
			const filePath = path.join(laneDir, name);
			try {
				const stat = await fs.stat(filePath);
				const pid = await readTicketPid(filePath);
				const stale = Date.now() - stat.mtimeMs > this.staleMs;
				if ((pid !== undefined && !processIsAlive(pid)) || stale) {
					await fs.unlink(filePath).catch(() => {});
					continue;
				}
				live.push(name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return live;
	}

	async hasWaiters(laneId: string): Promise<boolean> {
		return (await this.listLiveTicketNames(laneId)).length > 0;
	}

	async getRetryState(laneId: string): Promise<LaneRetryState | undefined> {
		return this.readRetryState(laneId);
	}

	async hasRetryState(laneId: string): Promise<boolean> {
		return (await this.readRetryState(laneId)) !== undefined;
	}

	async acquire(laneId: string): Promise<QueueTicket> {
		const laneDir = await this.ensureLaneDir(laneId);
		const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
		const sequence = (++ticketSequence).toString().padStart(8, "0");
		const fileName = `${monotonic}-${process.pid.toString().padStart(10, "0")}-${sequence}-${randomUUID()}.ticket`;
		const filePath = path.join(laneDir, fileName);
		await fs.writeFile(
			filePath,
			JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
		const ticket: QueueTicket = {
			laneId,
			laneDir,
			fileName,
			filePath,
			heartbeat: undefined,
			released: false,
		};
		const heartbeatMs = Math.max(250, Math.floor(this.staleMs / HEARTBEAT_DIVISOR));
		ticket.heartbeat = setInterval(() => {
			const now = new Date();
			void fs.utimes(ticket.filePath, now, now).catch(() => {});
		}, heartbeatMs);
		ticket.heartbeat.unref?.();
		return ticket;
	}

	async waitForTurn(ticket: QueueTicket, signal?: AbortSignal): Promise<number> {
		while (true) {
			if (signal?.aborted) throw abortError();
			const names = await this.listLiveTicketNames(ticket.laneId);
			const position = names.indexOf(ticket.fileName);
			if (position < 0) throw new Error("Adaptive provider queue ticket disappeared while waiting");
			if (position === 0) return names.length;
			const jitter = Math.floor(this.pollMs * 0.25 * this.random());
			await sleepWithSignal(this.pollMs + jitter, signal);
		}
	}

	async position(ticket: QueueTicket): Promise<number> {
		const names = await this.listLiveTicketNames(ticket.laneId);
		const position = names.indexOf(ticket.fileName);
		if (position < 0) throw new Error("Adaptive provider queue ticket disappeared while checking position");
		return position;
	}

	private async assertFront(ticket: QueueTicket): Promise<void> {
		if (await this.position(ticket)) throw new Error("Only the front queue ticket may update shared retry state");
	}

	backoffDelayMs(attempt: number, retryAfterMs?: number): number {
		const retryNumber = Math.max(1, Math.floor(attempt));
		const exponential =
			retryNumber <= RETRY_STAGE_SIZE
				? Math.min(
						this.maxDelayMs,
						DEFAULT_FIRST_STAGE_MAX_DELAY_MS,
						this.baseDelayMs * 2 ** Math.min(20, retryNumber - 1),
					)
				: Math.min(
						this.maxDelayMs,
						RETRY_STAGE_DELAYS_MS[
							Math.min(
								RETRY_STAGE_DELAYS_MS.length - 1,
								Math.floor((retryNumber - RETRY_STAGE_SIZE - 1) / RETRY_STAGE_SIZE),
							)
						],
					);
		const serverDelay = retryAfterMs === undefined ? 0 : Math.max(0, retryAfterMs);
		const baseline = Math.min(this.maxDelayMs, Math.max(exponential, serverDelay));
		const jitter = baseline === 0 ? 0 : Math.floor(baseline * 0.2 * this.random());
		return Math.min(this.maxDelayMs, baseline + jitter);
	}

	async defer(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<number> {
		const delayMs = this.backoffDelayMs(attempt, retryAfterMs);
		await sleepWithSignal(delayMs, signal);
		return delayMs;
	}

	async recordRetryFailure(
		ticket: QueueTicket,
		options: { maxRetries: number; retryAfterMs?: number; kind: RetryFailureKind },
	): Promise<RetryFailureDecision> {
		await this.assertFront(ticket);
		const existing = await this.readRetryState(ticket.laneId);
		if (existing?.status === "exhausted") {
			return { status: "exhausted", attempt: existing.attempt, maxRetries: existing.maxRetries };
		}

		const requestedBudget = Math.max(0, Math.floor(options.maxRetries));
		const maxRetries = existing?.maxRetries ?? requestedBudget;
		const retryNumber = (existing?.attempt ?? 0) + 1;
		const now = Date.now();
		if (retryNumber > maxRetries) {
			const attempt = existing?.attempt ?? maxRetries;
			await this.writeRetryState(ticket.laneId, {
				version: 1,
				status: "exhausted",
				attempt,
				maxRetries,
				ownerFileName: ticket.fileName,
				nextRetryAt: now,
				updatedAt: now,
				expiresAt: now + this.retryStateTtlMs,
				lastKind: options.kind,
			});
			return { status: "exhausted", attempt, maxRetries };
		}

		const delayMs = this.backoffDelayMs(retryNumber, options.retryAfterMs);
		const nextRetryAt = now + delayMs;
		await this.writeRetryState(ticket.laneId, {
			version: 1,
			status: "active",
			attempt: retryNumber,
			maxRetries,
			ownerFileName: ticket.fileName,
			nextRetryAt,
			updatedAt: now,
			expiresAt: nextRetryAt + this.retryStateTtlMs,
			lastKind: options.kind,
		});
		return { status: "retry", attempt: retryNumber, maxRetries, delayMs };
	}

	async waitForRetryWindow(ticket: QueueTicket, signal?: AbortSignal): Promise<RetryWindowDecision> {
		await this.assertFront(ticket);
		let state = await this.readRetryState(ticket.laneId);
		if (!state) return { status: "ready", claimed: false };
		if (state.status === "exhausted") return { status: "exhausted", state };

		let claimed = false;
		if (state.ownerFileName !== ticket.fileName) {
			claimed = true;
			const now = Date.now();
			state = {
				...state,
				ownerFileName: ticket.fileName,
				updatedAt: now,
				expiresAt: Math.max(state.expiresAt, state.nextRetryAt + this.retryStateTtlMs, now + this.retryStateTtlMs),
			};
			await this.writeRetryState(ticket.laneId, state);
		}
		await sleepWithSignal(Math.max(0, state.nextRetryAt - Date.now()), signal);
		return { status: "ready", state, claimed };
	}

	async markRetryStateExhausted(ticket: QueueTicket): Promise<LaneRetryState | undefined> {
		await this.assertFront(ticket);
		const state = await this.readRetryState(ticket.laneId);
		if (!state || state.status === "exhausted" || state.ownerFileName !== ticket.fileName) return state;
		const now = Date.now();
		const exhausted: LaneRetryState = {
			...state,
			status: "exhausted",
			nextRetryAt: now,
			updatedAt: now,
			expiresAt: now + this.retryStateTtlMs,
			lastKind: "terminal",
		};
		await this.writeRetryState(ticket.laneId, exhausted);
		return exhausted;
	}

	async clearRetryState(ticket: QueueTicket | undefined): Promise<void> {
		if (!ticket || ticket.released) return;
		await this.assertFront(ticket);
		const state = await this.readRetryState(ticket.laneId);
		if (!state || state.ownerFileName !== ticket.fileName) return;
		await fs.unlink(this.retryStatePath(ticket.laneId)).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}

	async release(ticket: QueueTicket | undefined): Promise<void> {
		if (!ticket || ticket.released) return;
		ticket.released = true;
		if (ticket.heartbeat) clearInterval(ticket.heartbeat);
		await fs.unlink(ticket.filePath).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
	}
}
