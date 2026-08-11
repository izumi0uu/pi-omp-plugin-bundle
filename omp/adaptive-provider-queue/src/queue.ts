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
	readonly lastStatus?: number;
}

export type RetryFailureDecision =
	| { status: "retry"; attempt: number; maxRetries: number; delayMs: number }
	| { status: "exhausted"; attempt: number; maxRetries: number };

export interface RetryAttemptEpoch {
	readonly wallMs: number;
	readonly monotonicNs: bigint;
}

export type RetryWindowDecision =
	| { status: "ready"; state?: LaneRetryState; claimed: boolean; recoveredSinceRequest?: boolean }
	| { status: "exhausted"; state: LaneRetryState };

interface LaneRecoveryMarker {
	readonly version: 1;
	readonly recoveredAt: number;
	readonly recoveredAtNs: string;
	readonly expiresAt: number;
}

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
const RETRY_RECOVERY_FILE_NAME = "retry-recovery.json";
const REQUEST_TICKET_SUFFIX = ".ticket";
const RETRY_STATE_LOCK_SUFFIX = ".state-lock";
const QUEUE_PUBLICATION_LOCK_FILE_NAME = ".queue-publication.lock";

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

function sameRetryState(left: LaneRetryState, right: LaneRetryState): boolean {
	return (
		left.version === right.version &&
		left.status === right.status &&
		left.attempt === right.attempt &&
		left.maxRetries === right.maxRetries &&
		left.ownerFileName === right.ownerFileName &&
		left.nextRetryAt === right.nextRetryAt &&
		left.updatedAt === right.updatedAt &&
		left.expiresAt === right.expiresAt &&
		left.lastKind === right.lastKind &&
		left.lastStatus === right.lastStatus
	);
}

async function readTicketPid(filePath: string): Promise<number | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { pid?: unknown };
		return typeof parsed.pid === "number" ? parsed.pid : undefined;
	} catch {
		return undefined;
	}
}

async function readPublicationLock(filePath: string): Promise<{ pid: number; token: string } | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { pid?: unknown; token?: unknown };
		return typeof parsed.pid === "number" && typeof parsed.token === "string"
			? { pid: parsed.pid, token: parsed.token }
			: undefined;
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

	private retryRecoveryPath(laneId: string): string {
		return path.join(this.laneDir(laneId), RETRY_RECOVERY_FILE_NAME);
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
		if (candidate.lastStatus !== undefined && (typeof candidate.lastStatus !== "number" || !Number.isInteger(candidate.lastStatus))) return undefined;
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

	private async readRecoveryMarker(laneId: string): Promise<LaneRecoveryMarker | undefined> {
		try {
			const parsed = JSON.parse(await fs.readFile(this.retryRecoveryPath(laneId), "utf8")) as Partial<LaneRecoveryMarker>;
			if (
				parsed.version !== 1 ||
				typeof parsed.recoveredAt !== "number" ||
				!Number.isFinite(parsed.recoveredAt) ||
				typeof parsed.recoveredAtNs !== "string" ||
				!/^\d+$/.test(parsed.recoveredAtNs) ||
				typeof parsed.expiresAt !== "number" ||
				!Number.isFinite(parsed.expiresAt) ||
				parsed.expiresAt <= Date.now()
			) {
				return undefined;
			}
			return parsed as LaneRecoveryMarker;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	private async writeRecoveryMarker(laneId: string): Promise<void> {
		const laneDir = await this.ensureLaneDir(laneId);
		const recoveredAt = Date.now();
		const marker: LaneRecoveryMarker = {
			version: 1,
			recoveredAt,
			recoveredAtNs: process.hrtime.bigint().toString(),
			expiresAt: recoveredAt + this.retryStateTtlMs,
		};
		const markerPath = this.retryRecoveryPath(laneId);
		const tempPath = path.join(laneDir, `.retry-recovery-${process.pid}-${randomUUID()}.tmp`);
		try {
			await fs.writeFile(tempPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx", mode: 0o600 });
			await fs.rename(tempPath, markerPath);
		} finally {
			await fs.unlink(tempPath).catch(() => {});
		}
	}

	private async listLiveQueueFileNames(laneId: string, suffix: string): Promise<string[]> {
		const laneDir = await this.ensureLaneDir(laneId);
		const names = (await fs.readdir(laneDir)).filter(name => name.endsWith(suffix)).sort();
		const live: string[] = [];
		for (const name of names) {
			const filePath = path.join(laneDir, name);
			try {
				const stat = await fs.stat(filePath);
				const pid = await readTicketPid(filePath);
				const stale = Date.now() - stat.mtimeMs > this.staleMs;
				if ((pid !== undefined && !processIsAlive(pid)) || (pid === undefined && stale)) {
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

	private async removeAbandonedPublicationLock(lockPath: string): Promise<boolean> {
		try {
			const [stat, owner] = await Promise.all([fs.stat(lockPath), readPublicationLock(lockPath)]);
			if (owner && processIsAlive(owner.pid)) return false;
			if (!owner && Date.now() - stat.mtimeMs <= this.staleMs) return false;
			const currentOwner = await readPublicationLock(lockPath);
			if (owner?.token !== currentOwner?.token) return false;
			if (currentOwner && processIsAlive(currentOwner.pid)) return false;
			await fs.unlink(lockPath).catch(error => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}

	private async withQueuePublicationLock<T>(laneId: string, operation: (laneDir: string) => Promise<T>): Promise<T> {
		const laneDir = await this.ensureLaneDir(laneId);
		const lockPath = path.join(laneDir, QUEUE_PUBLICATION_LOCK_FILE_NAME);
		while (true) {
			const token = randomUUID();
			let handle: Awaited<ReturnType<typeof fs.open>>;
			try {
				handle = await fs.open(lockPath, "wx", 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (!(await this.removeAbandonedPublicationLock(lockPath))) {
					const jitter = Math.floor(this.pollMs * 0.25 * this.random());
					await sleepWithSignal(this.pollMs + jitter);
				}
				continue;
			}

			let ownsPublishedLock = false;
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), "utf8");
				await handle.sync();
				ownsPublishedLock = (await readPublicationLock(lockPath))?.token === token;
				if (!ownsPublishedLock) continue;
				return await operation(laneDir);
			} finally {
				const openedStat = await handle.stat().catch(() => undefined);
				const publishedStat = await fs.stat(lockPath).catch(() => undefined);
				if (
					openedStat &&
					publishedStat &&
					openedStat.dev === publishedStat.dev &&
					openedStat.ino === publishedStat.ino
				) {
					await fs.unlink(lockPath).catch(error => {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					});
				}
				await handle.close().catch(() => {});
			}
		}
	}

	private async writeQueueFile(filePath: string, payload: string): Promise<void> {
		await fs.writeFile(filePath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
	}

	private async createQueueFile(laneId: string, suffix: string): Promise<QueueTicket> {
		return this.withQueuePublicationLock(laneId, async laneDir => {
			const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
			const sequence = (++ticketSequence).toString().padStart(8, "0");
			const fileName = `${monotonic}-${process.pid.toString().padStart(10, "0")}-${sequence}-${randomUUID()}${suffix}`;
			const filePath = path.join(laneDir, fileName);
			await this.writeQueueFile(filePath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
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
		});
	}

	private async waitForQueueFileTurn(ticket: QueueTicket, suffix: string, signal?: AbortSignal): Promise<number> {
		while (true) {
			if (signal?.aborted) throw abortError();
			const names = await this.listLiveQueueFileNames(ticket.laneId, suffix);
			const position = names.indexOf(ticket.fileName);
			if (position < 0) throw new Error("Adaptive provider queue coordination file disappeared while waiting");
			if (position === 0) return names.length;
			const jitter = Math.floor(this.pollMs * 0.25 * this.random());
			await sleepWithSignal(this.pollMs + jitter, signal);
		}
	}

	private async withRetryStateLock<T>(laneId: string, operation: () => Promise<T>): Promise<T> {
		const lock = await this.createQueueFile(laneId, RETRY_STATE_LOCK_SUFFIX);
		try {
			await this.waitForQueueFileTurn(lock, RETRY_STATE_LOCK_SUFFIX);
			return await operation();
		} finally {
			await this.release(lock);
		}
	}

	async hasWaiters(laneId: string): Promise<boolean> {
		return (await this.listLiveQueueFileNames(laneId, REQUEST_TICKET_SUFFIX)).length > 0;
	}

	async getRetryState(laneId: string): Promise<LaneRetryState | undefined> {
		return this.withRetryStateLock(laneId, () => this.readRetryState(laneId));
	}

	async hasRetryState(laneId: string): Promise<boolean> {
		return (await this.getRetryState(laneId)) !== undefined;
	}

	async acquire(laneId: string): Promise<QueueTicket> {
		return this.createQueueFile(laneId, REQUEST_TICKET_SUFFIX);
	}

	async waitForTurn(ticket: QueueTicket, signal?: AbortSignal): Promise<number> {
		return this.waitForQueueFileTurn(ticket, REQUEST_TICKET_SUFFIX, signal);
	}

	async position(ticket: QueueTicket): Promise<number> {
		const names = await this.listLiveQueueFileNames(ticket.laneId, REQUEST_TICKET_SUFFIX);
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
		options: { maxRetries: number; retryAfterMs?: number; kind: RetryFailureKind; status?: number },
	): Promise<RetryFailureDecision> {
		await this.assertFront(ticket);
		return this.withRetryStateLock(ticket.laneId, async () => {
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
					lastStatus: options.status,
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
				lastStatus: options.status,
			});
			return { status: "retry", attempt: retryNumber, maxRetries, delayMs };
		});
	}

	async waitForRetryWindow(
		ticket: QueueTicket,
		signal?: AbortSignal,
		requestStartedAt?: RetryAttemptEpoch,
	): Promise<RetryWindowDecision> {
		await this.assertFront(ticket);
		const decision = await this.withRetryStateLock<RetryWindowDecision>(ticket.laneId, async () => {
			let state = await this.readRetryState(ticket.laneId);
			if (!state) {
				const recovery = requestStartedAt === undefined ? undefined : await this.readRecoveryMarker(ticket.laneId);
				return {
					status: "ready",
					claimed: false,
					recoveredSinceRequest:
						recovery !== undefined &&
						recovery.recoveredAt >= requestStartedAt.wallMs &&
						BigInt(recovery.recoveredAtNs) > requestStartedAt.monotonicNs,
				};
			}
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
			return { status: "ready", state, claimed };
		});
		if (decision.status === "exhausted" || !decision.state) return decision;
		await sleepWithSignal(Math.max(0, decision.state.nextRetryAt - Date.now()), signal);
		return decision;
	}

	async markRetryStateExhausted(ticket: QueueTicket): Promise<LaneRetryState | undefined> {
		await this.assertFront(ticket);
		return this.withRetryStateLock(ticket.laneId, async () => {
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
		});
	}

	async clearRetryState(ticket: QueueTicket | undefined): Promise<void> {
		if (!ticket || ticket.released) return;
		await this.assertFront(ticket);
		await this.withRetryStateLock(ticket.laneId, async () => {
			const state = await this.readRetryState(ticket.laneId);
			if (!state || state.ownerFileName !== ticket.fileName) return;
			await fs.unlink(this.retryStatePath(ticket.laneId)).catch(error => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			await this.writeRecoveryMarker(ticket.laneId);
		});
	}

	/** Clear a campaign observed by a queue-bypassing health probe without deleting a newer state. */
	async clearRetryStateSnapshot(laneId: string, expected: LaneRetryState): Promise<boolean> {
		return this.withRetryStateLock(laneId, async () => {
			const current = await this.readRetryState(laneId);
			if (!current || !sameRetryState(current, expected)) return false;
			await fs.unlink(this.retryStatePath(laneId)).catch(error => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			await this.writeRecoveryMarker(laneId);
			return true;
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
