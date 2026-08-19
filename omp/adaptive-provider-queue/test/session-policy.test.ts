import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADAPTIVE_5XX_POLICY_ENTRY,
	ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
	ADAPTIVE_SHARE_POLICY_ENTRY,
	DEFAULT_SHARED_RETRY_RECOVERY,
	DEFAULT_TRANSIENT_UPSTREAM_MODE,
	createSessionPolicyStore,
	formatAdaptivePolicyStatus,
	formatTransientUpstreamModeList,
	modeForcesIsolatedRetry,
	parseAiInputRouteCommand,
	parseSharedRetryRecoveryCommand,
	parseTransientUpstreamModeCommand,
	providerRequestAiInputRoutePolicy,
	recordedAiInputRoutePolicy,
	restoreSessionPolicy,
	sessionAiInputRoutePolicy,
	sessionPolicyMode,
	sessionSharedRetryRecovery,
	setSessionPolicy,
	setSessionAiInputRoutePolicy,
	setSessionSharedRetryRecovery,
	sharedRetryRecoveryFromEntries,
	sharedSessionPolicyStore,
	transientUpstreamModeFromEntries,
} from "../src/session-policy.ts";

test("sessions default to retrying managed failures and stopping before fallback", () => {
	assert.equal(DEFAULT_TRANSIENT_UPSTREAM_MODE, "retry-stop");
	assert.equal(transientUpstreamModeFromEntries([]), "retry-stop");
	assert.equal(DEFAULT_SHARED_RETRY_RECOVERY, false);
	assert.equal(sharedRetryRecoveryFromEntries([]), false);
});

test("the latest valid policy entry on the active branch is restored", () => {
	const entries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "retry-5m" } },
	];

	assert.equal(transientUpstreamModeFromEntries(entries), "retry-5m");
});

test("malformed and unrelated custom entries are ignored", () => {
	const entries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "custom", customType: "another-extension", data: { mode: "retry" } },
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "invalid" } },
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: null },
	];

	assert.equal(transientUpstreamModeFromEntries(entries), "fallback");
	assert.equal(
		transientUpstreamModeFromEntries([
			{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "invalid" } },
		]),
		"retry-stop",
	);
});

test("the latest valid shared recovery entry is restored independently", () => {
	const entries = [
		{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: true } },
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: "off" } },
		{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: false } },
	];

	assert.equal(sharedRetryRecoveryFromEntries(entries), false);
	assert.equal(transientUpstreamModeFromEntries(entries), "fallback");
	assert.equal(
		sharedRetryRecoveryFromEntries([
			{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: "on" } },
		]),
		false,
	);
});

test("the session command parses status, explicit modes and toggle", () => {
	assert.equal(parseTransientUpstreamModeCommand("", "retry"), "status");
	assert.equal(parseTransientUpstreamModeCommand(" STATUS ", "fallback"), "status");
	assert.equal(parseTransientUpstreamModeCommand("list", "retry-stop"), "list");
	assert.equal(parseTransientUpstreamModeCommand("LS", "retry"), "list");
	assert.equal(parseTransientUpstreamModeCommand("retry", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("retry-stop", "retry"), "retry-stop");
	assert.equal(parseTransientUpstreamModeCommand("STOP", "retry"), "retry-stop");
	assert.equal(parseTransientUpstreamModeCommand("retry-5m", "retry"), "retry-5m");
	assert.equal(parseTransientUpstreamModeCommand("RETRY5M", "fallback"), "retry-5m");
	assert.equal(parseTransientUpstreamModeCommand("5m", "retry"), "retry-5m");
	assert.equal(parseTransientUpstreamModeCommand("FALLBACK", "retry"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "retry"), "retry-stop");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "retry-stop"), "retry-5m");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "retry-5m"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("unknown", "retry"), undefined);
});

test("the mode list documents the same order used by toggle", () => {
	assert.equal(
		formatTransientUpstreamModeList("retry-stop"),
		[
			"Adaptive retry modes:",
			"  retry: managed errors retry 50x, then OMP fallback",
			"> retry-stop: managed errors retry 50x, then stop without fallback",
			"  retry-5m: ordinary 502/503/504 retry for 5m, then OMP fallback",
			"  fallback: ordinary 502/503/504 immediately enter OMP fallback",
			"toggle: retry -> retry-stop -> retry-5m -> fallback -> retry",
		].join("\n"),
	);
	assert.equal(modeForcesIsolatedRetry("retry"), false);
	assert.equal(modeForcesIsolatedRetry("fallback"), false);
	assert.equal(modeForcesIsolatedRetry("retry-stop"), true);
	assert.equal(modeForcesIsolatedRetry("retry-5m"), true);
});

test("the shared recovery command parses status, explicit modes and toggle", () => {
	assert.equal(parseSharedRetryRecoveryCommand("", false), "status");
	assert.equal(parseSharedRetryRecoveryCommand(" STATUS ", true), "status");
	assert.equal(parseSharedRetryRecoveryCommand("ON", false), true);
	assert.equal(parseSharedRetryRecoveryCommand("off", true), false);
	assert.equal(parseSharedRetryRecoveryCommand("toggle", false), true);
	assert.equal(parseSharedRetryRecoveryCommand("toggle", true), false);
	assert.equal(parseSharedRetryRecoveryCommand("unknown", false), undefined);
});

test("the AI Input route command accepts allowlisted aliases and bounded temporary pins", () => {
	const now = 1_000_000;
	assert.deepEqual(parseAiInputRouteCommand("", now), { action: "status" });
	assert.deepEqual(parseAiInputRouteCommand(" STATUS ", now), { action: "status" });
	assert.deepEqual(parseAiInputRouteCommand("refresh", now), { action: "refresh" });
	assert.deepEqual(parseAiInputRouteCommand("auto", now), { action: "auto" });
	assert.deepEqual(parseAiInputRouteCommand("pin ai", now), { action: "pin", endpointId: "ai" });
	assert.deepEqual(parseAiInputRouteCommand("pin eo 30m", now), {
		action: "pin",
		endpointId: "eo",
		expiresAt: now + 30 * 60_000,
	});
	assert.deepEqual(parseAiInputRouteCommand("pin input 2h", now), {
		action: "pin",
		endpointId: "input",
		expiresAt: now + 2 * 3_600_000,
	});
	assert.deepEqual(parseAiInputRouteCommand("pin edge", now), { action: "pin", endpointId: "eo" });
	assert.equal(parseAiInputRouteCommand("pin https://attacker.invalid/v1", now), undefined);
	assert.equal(parseAiInputRouteCommand("pin eo 0m", now), undefined);
	assert.equal(parseAiInputRouteCommand("pin eo 366d", now), undefined);
	assert.equal(parseAiInputRouteCommand("pin eo 30minutes", now), undefined);
});

test("AI Input pins are isolated by root session and inherited only by that session's subagents", () => {
	const store = createSessionPolicyStore();
	restoreSessionPolicy(store, {
		sessionId: "root-a",
		entries: [{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "pinned", endpointId: "eo", sessionId: "root-a" },
		}],
		hasUI: true,
		artifactsDir: "/sessions/root-a",
	});
	restoreSessionPolicy(store, {
		sessionId: "child-a",
		entries: [],
		hasUI: false,
		lineageSessionId: "root-a",
		artifactsDir: "/sessions/root-a",
	});
	restoreSessionPolicy(store, {
		sessionId: "root-b",
		entries: [],
		hasUI: true,
		artifactsDir: "/sessions/root-b",
	});

	assert.deepEqual(sessionAiInputRoutePolicy(store, "root-a"), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(sessionAiInputRoutePolicy(store, "child-a"), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root-b"), { mode: "auto" });
	setSessionAiInputRoutePolicy(store, "root-b", { mode: "pinned", endpointId: "ai" });
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root-a"), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root-b"), { mode: "pinned", endpointId: "ai" });
});

test("copied AI Input route entries do not leak into a forked session", () => {
	const copiedEntries = [
		{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "pinned", endpointId: "eo", sessionId: "root-a" },
		},
	];
	const original = createSessionPolicyStore();
	restoreSessionPolicy(original, {
		sessionId: "root-a",
		entries: copiedEntries,
		hasUI: true,
	});
	assert.deepEqual(sessionAiInputRoutePolicy(original, "root-a"), {
		mode: "pinned",
		endpointId: "eo",
	});

	const fork = createSessionPolicyStore();
	restoreSessionPolicy(fork, {
		sessionId: "root-b",
		entries: copiedEntries,
		hasUI: true,
	});
	assert.deepEqual(sessionAiInputRoutePolicy(fork, "root-b"), { mode: "auto" });
});

test("AI Input route restoration skips foreign and legacy entries", () => {
	const entries = [
		{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "pinned", endpointId: "input", sessionId: "root-b" },
		},
		{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "pinned", endpointId: "eo" },
		},
		{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "auto", sessionId: "root-a" },
		},
	];

	assert.deepEqual(recordedAiInputRoutePolicy(entries, "root-a"), { mode: "auto" });
	assert.deepEqual(recordedAiInputRoutePolicy(entries, "root-b"), {
		mode: "pinned",
		endpointId: "input",
	});
	assert.equal(recordedAiInputRoutePolicy(entries, "root-c"), undefined);
});

test("AI Input route restoration is session-wide when the active branch predates the pin", () => {
	const store = createSessionPolicyStore();
	const branchEntries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
	];
	const allEntries = [
		...branchEntries,
		{
			type: "custom",
			customType: ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
			data: { mode: "pinned", endpointId: "eo", sessionId: "root" },
		},
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "retry" } },
	];

	assert.equal(restoreSessionPolicy(store, {
		sessionId: "root",
		entries: branchEntries,
		routeEntries: allEntries,
		hasUI: true,
	}), "fallback");
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root"), {
		mode: "pinned",
		endpointId: "eo",
	});
});

test("rotating and derived provider IDs retain the owning session route", () => {
	const store = createSessionPolicyStore();
	restoreSessionPolicy(store, {
		sessionId: "root-a",
		entries: [],
		hasUI: true,
	});
	setSessionAiInputRoutePolicy(store, "root-a", { mode: "pinned", endpointId: "eo" });
	const providerState = new Map();

	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "root-a",
		providerSessionState: providerState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "fresh-provider-id",
		providerSessionState: providerState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "clear-provider-id",
		providerSessionState: providerState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "clear-provider-id:side:123",
		providerSessionState: providerState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "advisor-provider-id",
		providerSessionState: providerState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "root-a:tan:456",
		providerSessionState: new Map(),
	}), { mode: "pinned", endpointId: "eo" });
});

test("provider identity keeps background sessions isolated after the active session switches", () => {
	const store = createSessionPolicyStore();
	restoreSessionPolicy(store, { sessionId: "root-a", entries: [], hasUI: true });
	setSessionAiInputRoutePolicy(store, "root-a", { mode: "pinned", endpointId: "eo" });
	const sharedProviderState = new Map();
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "root-a",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "advisor-a",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "eo" });

	restoreSessionPolicy(store, { sessionId: "root-b", entries: [], hasUI: true });
	setSessionAiInputRoutePolicy(store, "root-b", { mode: "pinned", endpointId: "input" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "new-advisor-b",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "input" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "advisor-a",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "eo" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "root-a:side:late",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "eo" });

	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "clear-provider-b",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "input" });
	assert.deepEqual(providerRequestAiInputRoutePolicy(store, {
		sessionId: "new-advisor-b:side:1",
		providerSessionState: sharedProviderState,
	}), { mode: "pinned", endpointId: "input" });
});

test("temporary AI Input pins expire lazily at the exact deadline", () => {
	const store = createSessionPolicyStore();
	restoreSessionPolicy(store, { sessionId: "root", entries: [], hasUI: true });
	setSessionAiInputRoutePolicy(store, "root", {
		mode: "pinned",
		endpointId: "input",
		expiresAt: 2_000,
	});
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root", 1_999), {
		mode: "pinned",
		endpointId: "input",
		expiresAt: 2_000,
	});
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root", 2_000), { mode: "auto" });
	assert.deepEqual(sessionAiInputRoutePolicy(store, "root", 1_000), { mode: "auto" });
});

test("the combined status reports both independent policies", () => {
	assert.equal(formatAdaptivePolicyStatus("retry", false), "5xx: retry 50x -> fallback | shared: off");
	assert.equal(formatAdaptivePolicyStatus("retry-stop", false), "5xx: retry 50x -> stop | shared: off");
	assert.equal(formatAdaptivePolicyStatus("retry-5m", false), "5xx: retry 5m -> fallback | shared: off");
	assert.equal(formatAdaptivePolicyStatus("fallback", true), "5xx: immediate fallback | shared: on");
});

test("subagents stay attached to their root policy after the interactive session switches", () => {
	const store = createSessionPolicyStore();
	const rootEntries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: true } },
	];

	assert.equal(
		restoreSessionPolicy(store, {
			sessionId: "root-a",
			entries: rootEntries,
			hasUI: true,
			artifactsDir: "/sessions/root-a",
		}),
		"fallback",
	);
	assert.equal(
		restoreSessionPolicy(store, {
			sessionId: "child-a",
			entries: [],
			hasUI: false,
			lineageSessionId: "root-a",
			artifactsDir: "/sessions/root-a",
		}),
		"fallback",
	);
	restoreSessionPolicy(store, {
		sessionId: "root-b",
		entries: [],
		hasUI: true,
		artifactsDir: "/sessions/root-b",
	});
	assert.equal(
		restoreSessionPolicy(store, {
			sessionId: "nested-child-a",
			entries: [],
			hasUI: false,
			lineageSessionId: "root-b",
			artifactsDir: "/sessions/root-a",
		}),
		"fallback",
	);

	assert.equal(sessionPolicyMode(store, "child-a"), "fallback");
	assert.equal(sessionPolicyMode(store, "nested-child-a"), "fallback");
	assert.equal(sessionPolicyMode(store, "root-b"), "retry-stop");
	assert.equal(sessionSharedRetryRecovery(store, "child-a"), true);
	assert.equal(sessionSharedRetryRecovery(store, "nested-child-a"), true);
	assert.equal(sessionSharedRetryRecovery(store, "root-b"), false);
	setSessionPolicy(store, "root-a", "retry");
	setSessionSharedRetryRecovery(store, "root-a", false);
	assert.equal(sessionPolicyMode(store, "child-a"), "retry");
	assert.equal(sessionPolicyMode(store, "nested-child-a"), "retry");
	assert.equal(sessionSharedRetryRecovery(store, "child-a"), false);
	assert.equal(sessionSharedRetryRecovery(store, "nested-child-a"), false);
});

test("headless roots and their children resolve policy without an interactive session", () => {
	const store = createSessionPolicyStore();
	const rootEntries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "custom", customType: ADAPTIVE_SHARE_POLICY_ENTRY, data: { enabled: true } },
	];

	assert.equal(
		restoreSessionPolicy(store, {
			sessionId: "headless-root",
			entries: rootEntries,
			hasUI: false,
			lineageSessionId: "headless-root",
			artifactsDir: "/sessions/headless-root",
		}),
		"fallback",
	);
	assert.equal(
		restoreSessionPolicy(store, {
			sessionId: "headless-child",
			entries: [],
			hasUI: false,
			lineageSessionId: "headless-root",
			artifactsDir: "/sessions/headless-root",
		}),
		"fallback",
	);
	assert.equal(sessionSharedRetryRecovery(store, "headless-root"), true);
	assert.equal(sessionSharedRetryRecovery(store, "headless-child"), true);
});

test("session policy is keyed by request session and tree restoration can return to the default", () => {
	const store = createSessionPolicyStore();
	restoreSessionPolicy(store, { sessionId: "root", entries: [], hasUI: true });
	setSessionPolicy(store, "root", "fallback");
	setSessionSharedRetryRecovery(store, "root", true);
	setSessionPolicy(store, "other", "retry");

	assert.equal(sessionPolicyMode(store, "root"), "fallback");
	assert.equal(sessionPolicyMode(store, "other"), "retry");
	assert.equal(sessionPolicyMode(store, "unknown-provider-session"), "fallback");
	assert.equal(sessionSharedRetryRecovery(store, "root"), true);
	assert.equal(sessionSharedRetryRecovery(store, "unknown-provider-session"), true);
	assert.equal(restoreSessionPolicy(store, { sessionId: "root", entries: [], hasUI: true }), "retry-stop");
	assert.equal(sessionSharedRetryRecovery(store, "root"), false);
});

test("all extension module instances resolve one process-wide policy store", () => {
	assert.equal(sharedSessionPolicyStore(), sharedSessionPolicyStore());
});
