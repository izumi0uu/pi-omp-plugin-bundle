import {
	resolveAiInputEndpoint,
	type AiInputEndpointId,
} from "./aiinput-router.ts";

export const ADAPTIVE_5XX_POLICY_ENTRY = "adaptive-provider-queue:5xx-policy";
export const ADAPTIVE_SHARE_POLICY_ENTRY = "adaptive-provider-queue:share-policy";
export const ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY = "adaptive-provider-queue:aiinput-route-policy";
export const DEFAULT_TRANSIENT_UPSTREAM_MODE = "retry-stop" as const;
export const DEFAULT_SHARED_RETRY_RECOVERY = false;
export const TRANSIENT_UPSTREAM_RETRY_WINDOW_MS = 300_000;
const MAX_AIINPUT_PIN_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

export const TRANSIENT_UPSTREAM_MODE_ORDER = ["retry", "retry-stop", "retry-5m", "fallback"] as const;

export type TransientUpstreamMode = (typeof TRANSIENT_UPSTREAM_MODE_ORDER)[number];
export type TransientUpstreamModeCommand = TransientUpstreamMode | "status" | "list";

export type SessionAiInputRoutePolicy =
	| { readonly mode: "auto" }
	| {
		readonly mode: "pinned";
		readonly endpointId: AiInputEndpointId;
		readonly expiresAt?: number;
	};

export type AiInputRouteCommand =
	| { readonly action: "status" | "refresh" | "auto" }
	| {
		readonly action: "pin";
		readonly endpointId: AiInputEndpointId;
		readonly expiresAt?: number;
	};

export interface SessionPolicyStore {
	readonly version: 5;
	readonly modes: Map<string, TransientUpstreamMode>;
	readonly sharedRetryRecovery: Map<string, boolean>;
	readonly aiInputRoutes: Map<string, SessionAiInputRoutePolicy>;
	readonly rootSessionIds: Map<string, string>;
	readonly rootSessionIdsByArtifactsDir: Map<string, string>;
	readonly providerSessionRootIds: Map<string, string>;
	providerStateRootIds: WeakMap<object, string>;
	activeInteractiveSessionId?: string;
}

const SHARED_SESSION_POLICY_STORE = Symbol.for("omp.adaptive-provider-queue.session-policy.v5");

interface SessionEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function modeFromData(data: unknown): TransientUpstreamMode | undefined {
	if (!data || typeof data !== "object") return undefined;
	const mode = (data as Record<string, unknown>).mode;
	return typeof mode === "string" && TRANSIENT_UPSTREAM_MODE_ORDER.includes(mode as TransientUpstreamMode)
		? (mode as TransientUpstreamMode)
		: undefined;
}

function sharedRetryRecoveryFromData(data: unknown): boolean | undefined {
	if (!data || typeof data !== "object") return undefined;
	const enabled = (data as Record<string, unknown>).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

function aiInputRoutePolicyFromData(
	data: unknown,
	expectedSessionId: string,
): SessionAiInputRoutePolicy | undefined {
	if (!data || typeof data !== "object") return undefined;
	const source = data as Record<string, unknown>;
	if (source.sessionId !== expectedSessionId) return undefined;
	if (source.mode === "auto") return { mode: "auto" };
	if (source.mode !== "pinned" || typeof source.endpointId !== "string") return undefined;
	const endpoint = resolveAiInputEndpoint(source.endpointId);
	if (!endpoint) return undefined;
	const expiresAt = typeof source.expiresAt === "number" && Number.isFinite(source.expiresAt)
		? source.expiresAt
		: undefined;
	return {
		mode: "pinned",
		endpointId: endpoint.id,
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
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

export function recordedSharedRetryRecovery(entries: readonly unknown[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== ADAPTIVE_SHARE_POLICY_ENTRY) continue;
		const enabled = sharedRetryRecoveryFromData(entry.data);
		if (enabled !== undefined) return enabled;
	}
	return undefined;
}

export function sharedRetryRecoveryFromEntries(entries: readonly unknown[]): boolean {
	return recordedSharedRetryRecovery(entries) ?? DEFAULT_SHARED_RETRY_RECOVERY;
}

export function recordedAiInputRoutePolicy(
	entries: readonly unknown[],
	expectedSessionId: string,
): SessionAiInputRoutePolicy | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY) continue;
		const policy = aiInputRoutePolicyFromData(entry.data, expectedSessionId);
		if (policy) return policy;
	}
	return undefined;
}

export function createSessionPolicyStore(): SessionPolicyStore {
	return {
		version: 5,
		modes: new Map<string, TransientUpstreamMode>(),
		sharedRetryRecovery: new Map<string, boolean>(),
		aiInputRoutes: new Map<string, SessionAiInputRoutePolicy>(),
		rootSessionIds: new Map<string, string>(),
		rootSessionIdsByArtifactsDir: new Map<string, string>(),
		providerSessionRootIds: new Map<string, string>(),
		providerStateRootIds: new WeakMap<object, string>(),
	};
}

function isSessionPolicyStore(value: unknown): value is SessionPolicyStore {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SessionPolicyStore>;
	return (
		candidate.version === 5 &&
		candidate.modes instanceof Map &&
		candidate.sharedRetryRecovery instanceof Map &&
		candidate.aiInputRoutes instanceof Map &&
		candidate.rootSessionIds instanceof Map &&
		candidate.rootSessionIdsByArtifactsDir instanceof Map &&
		candidate.providerSessionRootIds instanceof Map &&
		candidate.providerStateRootIds instanceof WeakMap
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
		routeEntries?: readonly unknown[];
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
	if (input.hasUI && store.activeInteractiveSessionId !== input.sessionId) {
		store.providerStateRootIds = new WeakMap<object, string>();
	}

	const recorded = recordedTransientUpstreamMode(input.entries);
	const recordedSharedRecovery = recordedSharedRetryRecovery(input.entries);
	const recordedRoute = recordedAiInputRoutePolicy(input.routeEntries ?? input.entries, input.sessionId);
	if (rootSessionId === input.sessionId) {
		store.modes.set(rootSessionId, recorded ?? DEFAULT_TRANSIENT_UPSTREAM_MODE);
		store.sharedRetryRecovery.set(rootSessionId, recordedSharedRecovery ?? DEFAULT_SHARED_RETRY_RECOVERY);
		store.aiInputRoutes.set(rootSessionId, recordedRoute ?? { mode: "auto" });
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

export function setSessionSharedRetryRecovery(
	store: SessionPolicyStore,
	sessionId: string,
	enabled: boolean,
): void {
	store.sharedRetryRecovery.set(store.rootSessionIds.get(sessionId) ?? sessionId, enabled);
}

export function setSessionAiInputRoutePolicy(
	store: SessionPolicyStore,
	sessionId: string,
	policy: SessionAiInputRoutePolicy,
): void {
	store.aiInputRoutes.set(store.rootSessionIds.get(sessionId) ?? sessionId, policy);
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

export function sessionSharedRetryRecovery(
	store: SessionPolicyStore,
	sessionId: string | undefined,
): boolean {
	if (sessionId) {
		const rootSessionId = store.rootSessionIds.get(sessionId) ?? sessionId;
		if (store.sharedRetryRecovery.has(rootSessionId)) {
			return store.sharedRetryRecovery.get(rootSessionId) ?? DEFAULT_SHARED_RETRY_RECOVERY;
		}
	}
	if (store.activeInteractiveSessionId) {
		return store.sharedRetryRecovery.get(store.activeInteractiveSessionId) ?? DEFAULT_SHARED_RETRY_RECOVERY;
	}
	return DEFAULT_SHARED_RETRY_RECOVERY;
}

export function sessionAiInputRoutePolicy(
	store: SessionPolicyStore,
	sessionId: string | undefined,
	now = Date.now(),
): SessionAiInputRoutePolicy {
	const rootSessionId = sessionId
		? store.rootSessionIds.get(sessionId) ?? sessionId
		: store.activeInteractiveSessionId;
	const policy = rootSessionId ? store.aiInputRoutes.get(rootSessionId) : undefined;
	if (!policy || policy.mode === "auto") return { mode: "auto" };
	if (policy.expiresAt !== undefined && policy.expiresAt <= now) {
		if (rootSessionId) store.aiInputRoutes.set(rootSessionId, { mode: "auto" });
		return { mode: "auto" };
	}
	return policy;
}

function knownRootSessionId(store: SessionPolicyStore, sessionId: string): string | undefined {
	const rootSessionId =
		store.rootSessionIds.get(sessionId) ??
		store.providerSessionRootIds.get(sessionId) ??
		(store.aiInputRoutes.has(sessionId) ? sessionId : undefined);
	return rootSessionId && store.aiInputRoutes.has(rootSessionId) ? rootSessionId : undefined;
}

function derivedProviderRootSessionId(store: SessionPolicyStore, sessionId: string): string | undefined {
	const markerIndex = Math.max(sessionId.lastIndexOf(":side:"), sessionId.lastIndexOf(":tan:"));
	if (markerIndex <= 0) return undefined;
	const parentSessionId = sessionId.slice(0, markerIndex);
	return knownRootSessionId(store, parentSessionId) ?? derivedProviderRootSessionId(store, parentSessionId);
}

function providerStateObject(value: unknown): object | undefined {
	return value !== null && (typeof value === "object" || typeof value === "function")
		? value as object
		: undefined;
}

function bindProviderRequestToRoot(
	store: SessionPolicyStore,
	input: { sessionId?: string; providerSessionState?: unknown },
	rootSessionId: string,
	rememberSessionId: boolean,
): void {
	if (rememberSessionId && input.sessionId) {
		store.providerSessionRootIds.set(input.sessionId, rootSessionId);
	}
	const state = providerStateObject(input.providerSessionState);
	const activeRoot = store.activeInteractiveSessionId
		? store.rootSessionIds.get(store.activeInteractiveSessionId) ?? store.activeInteractiveSessionId
		: undefined;
	if (state && (!activeRoot || activeRoot === rootSessionId)) {
		store.providerStateRootIds.set(state, rootSessionId);
	}
}

/** Resolves OMP's rotating and derived provider IDs back to the owning top-level session. */
export function providerRequestAiInputRoutePolicy(
	store: SessionPolicyStore,
	input: { sessionId?: string; providerSessionState?: unknown },
	now = Date.now(),
): SessionAiInputRoutePolicy {
	const directRoot = input.sessionId ? knownRootSessionId(store, input.sessionId) : undefined;
	if (directRoot) {
		bindProviderRequestToRoot(store, input, directRoot, false);
		return sessionAiInputRoutePolicy(store, directRoot, now);
	}

	const derivedRoot = input.sessionId
		? derivedProviderRootSessionId(store, input.sessionId)
		: undefined;
	if (derivedRoot) {
		bindProviderRequestToRoot(store, input, derivedRoot, false);
		return sessionAiInputRoutePolicy(store, derivedRoot, now);
	}

	const state = providerStateObject(input.providerSessionState);
	const stateRoot = state ? store.providerStateRootIds.get(state) : undefined;
	if (stateRoot && store.aiInputRoutes.has(stateRoot)) {
		bindProviderRequestToRoot(store, input, stateRoot, true);
		return sessionAiInputRoutePolicy(store, stateRoot, now);
	}

	const activeRoot = store.activeInteractiveSessionId
		? store.rootSessionIds.get(store.activeInteractiveSessionId) ?? store.activeInteractiveSessionId
		: undefined;
	if (activeRoot && store.aiInputRoutes.has(activeRoot)) {
		bindProviderRequestToRoot(store, input, activeRoot, true);
		return sessionAiInputRoutePolicy(store, activeRoot, now);
	}
	return { mode: "auto" };
}

export function parseTransientUpstreamModeCommand(
	args: string,
	current: TransientUpstreamMode,
): TransientUpstreamModeCommand | undefined {
	const action = args.trim().toLowerCase();
	if (!action || action === "status") return "status";
	if (action === "list" || action === "ls") return "list";
	if (action === "retry" || action === "fallback") return action;
	if (action === "retry-stop" || action === "retrystop" || action === "retry50-stop" || action === "stop") {
		return "retry-stop";
	}
	if (action === "retry-5m" || action === "retry5m" || action === "5m") return "retry-5m";
	if (action === "toggle") {
		const currentIndex = TRANSIENT_UPSTREAM_MODE_ORDER.indexOf(current);
		return TRANSIENT_UPSTREAM_MODE_ORDER[(currentIndex + 1) % TRANSIENT_UPSTREAM_MODE_ORDER.length];
	}
	return undefined;
}

export function modeForcesIsolatedRetry(mode: TransientUpstreamMode): boolean {
	return mode === "retry-stop" || mode === "retry-5m";
}

export function formatTransientUpstreamModeList(current: TransientUpstreamMode): string {
	const modes: ReadonlyArray<readonly [TransientUpstreamMode, string]> = [
		["retry", "managed errors retry 50x, then OMP fallback"],
		["retry-stop", "managed errors retry 50x, then stop without fallback"],
		["retry-5m", "ordinary 502/503/504/524 retry for 5m, then OMP fallback"],
		["fallback", "ordinary 502/503/504/524 immediately enter OMP fallback"],
	];
	return [
		"Adaptive retry modes:",
		...modes.map(([mode, description]) => `${mode === current ? ">" : " "} ${mode}: ${description}`),
		`toggle: ${TRANSIENT_UPSTREAM_MODE_ORDER.join(" -> ")} -> retry`,
	].join("\n");
}

export function parseSharedRetryRecoveryCommand(
	args: string,
	current: boolean,
): boolean | "status" | undefined {
	const action = args.trim().toLowerCase();
	if (!action || action === "status") return "status";
	if (action === "on") return true;
	if (action === "off") return false;
	if (action === "toggle") return !current;
	return undefined;
}

export function parseAiInputRouteCommand(args: string, now = Date.now()): AiInputRouteCommand | undefined {
	const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "status")) {
		return { action: "status" };
	}
	if (tokens.length === 1 && (tokens[0] === "refresh" || tokens[0] === "auto")) {
		return { action: tokens[0] };
	}
	if (tokens[0] !== "pin" || tokens.length < 2 || tokens.length > 3) return undefined;
	const endpoint = resolveAiInputEndpoint(tokens[1]);
	if (!endpoint) return undefined;
	if (tokens.length === 2) return { action: "pin", endpointId: endpoint.id };

	const duration = tokens[2].match(/^([1-9]\d*)(s|m|h|d)$/);
	if (!duration) return undefined;
	const amount = Number(duration[1]);
	const unitMs = duration[2] === "s"
		? 1_000
		: duration[2] === "m"
			? 60_000
			: duration[2] === "h"
				? 3_600_000
				: 86_400_000;
	const durationMs = amount * unitMs;
	if (!Number.isSafeInteger(durationMs) || durationMs > MAX_AIINPUT_PIN_DURATION_MS) return undefined;
	return { action: "pin", endpointId: endpoint.id, expiresAt: now + durationMs };
}

export function formatAdaptivePolicyStatus(
	mode: TransientUpstreamMode,
	sharedRetryRecovery: boolean,
): string {
	const upstream =
		mode === "fallback"
			? "5xx: immediate fallback"
			: mode === "retry-5m"
				? "5xx: retry 5m -> fallback"
				: mode === "retry-stop"
					? "5xx: retry 50x -> stop"
					: "5xx: retry 50x -> fallback";
	return `${upstream} | shared: ${sharedRetryRecovery ? "on" : "off"}`;
}
