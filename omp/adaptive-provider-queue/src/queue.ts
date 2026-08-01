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
	random?: () => number;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const HEARTBEAT_DIVISOR = 3;

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
	readonly random: () => number;

	constructor(options: AdaptiveQueueOptions = {}) {
		this.rootDir = options.rootDir ?? defaultQueueRoot();
		this.pollMs = Math.max(10, options.pollMs ?? DEFAULT_POLL_MS);
		this.staleMs = Math.max(1_000, options.staleMs ?? DEFAULT_STALE_MS);
		this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
		this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
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

	backoffDelayMs(attempt: number, retryAfterMs?: number): number {
		const exponent = Math.max(0, Math.min(20, attempt - 1));
		const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** exponent);
		const serverDelay = retryAfterMs === undefined ? 0 : Math.max(0, retryAfterMs);
		const baseline = Math.max(exponential, serverDelay);
		const jitter = baseline === 0 ? 0 : Math.floor(baseline * 0.2 * this.random());
		return baseline + jitter;
	}

	async defer(attempt: number, retryAfterMs: number | undefined, signal?: AbortSignal): Promise<number> {
		const delayMs = this.backoffDelayMs(attempt, retryAfterMs);
		await sleepWithSignal(delayMs, signal);
		return delayMs;
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
