export const ADAPTIVE_5XX_POLICY_ENTRY = "adaptive-provider-queue:5xx-policy";
export const DEFAULT_TRANSIENT_UPSTREAM_MODE = "retry" as const;

export type TransientUpstreamMode = "retry" | "fallback";

export interface SessionPolicyStore {
	readonly version: 2;
	readonly modes: Map<string, TransientUpstreamMode>;
	readonly rootSessionIds: Map<string, string>;
	readonly rootSessionIdsByArtifactsDir: Map<string, string>;
	activeInteractiveSessionId?: string;
}

const SHARED_SESSION_POLICY_STORE = Symbol.for("omp.adaptive-provider-queue.5xx-policy.v2");

interface SessionEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function modeFromData(data: unknown): TransientUpstreamMode | undefined {
	if (!data || typeof data !== "object") return undefined;
	const mode = (data as Record<string, unknown>).mode;
	return mode === "retry" || mode === "fallback" ? mode : undefined;
}

export function recordedTransientUpstreamMode(entries: readonly unknown[]): TransientUpstreamMode | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== ADAPTIVE_5XX_POLICY_ENTRY) continue;
		const mode = modeFromData(entry.data);
		if (mode) return mode;
	}
	return undefined;
}

export function transientUpstreamModeFromEntries(entries: readonly unknown[]): TransientUpstreamMode {
	return recordedTransientUpstreamMode(entries) ?? DEFAULT_TRANSIENT_UPSTREAM_MODE;
}

export function createSessionPolicyStore(): SessionPolicyStore {
	return {
		version: 2,
		modes: new Map<string, TransientUpstreamMode>(),
		rootSessionIds: new Map<string, string>(),
		rootSessionIdsByArtifactsDir: new Map<string, string>(),
	};
}

function isSessionPolicyStore(value: unknown): value is SessionPolicyStore {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SessionPolicyStore>;
	return (
		candidate.version === 2 &&
		candidate.modes instanceof Map &&
		candidate.rootSessionIds instanceof Map &&
		candidate.rootSessionIdsByArtifactsDir instanceof Map
	);
}

/** Shared across OMP extension instances so subagent provider registration cannot replace root policy state. */
export function sharedSessionPolicyStore(): SessionPolicyStore {
	const root = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = root[SHARED_SESSION_POLICY_STORE];
	if (isSessionPolicyStore(existing)) return existing;
	const created = createSessionPolicyStore();
	root[SHARED_SESSION_POLICY_STORE] = created;
	return created;
}

export function restoreSessionPolicy(
	store: SessionPolicyStore,
	input: {
		sessionId: string;
		entries: readonly unknown[];
		hasUI: boolean;
		lineageSessionId?: string;
		artifactsDir?: string;
	},
): TransientUpstreamMode {
	const artifactRoot = input.artifactsDir
		? store.rootSessionIdsByArtifactsDir.get(input.artifactsDir)
		: undefined;
	const rootSessionId = input.hasUI
		? input.sessionId
		: artifactRoot ?? input.lineageSessionId ?? input.sessionId;
	store.rootSessionIds.set(input.sessionId, rootSessionId);
	if (input.artifactsDir && !artifactRoot) {
		store.rootSessionIdsByArtifactsDir.set(input.artifactsDir, rootSessionId);
	}

	const recorded = recordedTransientUpstreamMode(input.entries);
	if (rootSessionId === input.sessionId) {
		store.modes.set(rootSessionId, recorded ?? DEFAULT_TRANSIENT_UPSTREAM_MODE);
	}
	if (input.hasUI) store.activeInteractiveSessionId = input.sessionId;
	return sessionPolicyMode(store, input.sessionId);
}

export function setSessionPolicy(
	store: SessionPolicyStore,
	sessionId: string,
	mode: TransientUpstreamMode,
): void {
	store.modes.set(store.rootSessionIds.get(sessionId) ?? sessionId, mode);
}

export function sessionPolicyMode(
	store: SessionPolicyStore,
	sessionId: string | undefined,
): TransientUpstreamMode {
	if (sessionId) {
		const exact = store.modes.get(store.rootSessionIds.get(sessionId) ?? sessionId);
		if (exact) return exact;
	}
	if (store.activeInteractiveSessionId) {
		const active = store.modes.get(store.activeInteractiveSessionId);
		if (active) return active;
	}
	return DEFAULT_TRANSIENT_UPSTREAM_MODE;
}

export function parseTransientUpstreamModeCommand(
	args: string,
	current: TransientUpstreamMode,
): TransientUpstreamMode | "status" | undefined {
	const action = args.trim().toLowerCase();
	if (!action || action === "status") return "status";
	if (action === "retry" || action === "fallback") return action;
	if (action === "toggle") return current === "retry" ? "fallback" : "retry";
	return undefined;
}
