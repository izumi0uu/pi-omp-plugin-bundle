import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADAPTIVE_5XX_POLICY_ENTRY,
	ADAPTIVE_SHARE_POLICY_ENTRY,
	DEFAULT_SHARED_RETRY_RECOVERY,
	DEFAULT_TRANSIENT_UPSTREAM_MODE,
	createSessionPolicyStore,
	formatAdaptivePolicyStatus,
	parseSharedRetryRecoveryCommand,
	parseTransientUpstreamModeCommand,
	restoreSessionPolicy,
	sessionPolicyMode,
	sessionSharedRetryRecovery,
	setSessionPolicy,
	setSessionSharedRetryRecovery,
	sharedRetryRecoveryFromEntries,
	sharedSessionPolicyStore,
	transientUpstreamModeFromEntries,
} from "../src/session-policy.ts";

test("sessions default to retrying generic upstream 5xx failures", () => {
	assert.equal(DEFAULT_TRANSIENT_UPSTREAM_MODE, "retry");
	assert.equal(transientUpstreamModeFromEntries([]), "retry");
	assert.equal(DEFAULT_SHARED_RETRY_RECOVERY, false);
	assert.equal(sharedRetryRecoveryFromEntries([]), false);
});

test("the latest valid policy entry on the active branch is restored", () => {
	const entries = [
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "fallback" } },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: ADAPTIVE_5XX_POLICY_ENTRY, data: { mode: "retry" } },
	];

	assert.equal(transientUpstreamModeFromEntries(entries), "retry");
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
		"retry",
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
	assert.equal(parseTransientUpstreamModeCommand("retry", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("FALLBACK", "retry"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "retry"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("unknown", "retry"), undefined);
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

test("the combined status reports both independent policies", () => {
	assert.equal(formatAdaptivePolicyStatus("retry", false), "5xx: retry 50x | shared: off");
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
	assert.equal(sessionPolicyMode(store, "root-b"), "retry");
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
	assert.equal(restoreSessionPolicy(store, { sessionId: "root", entries: [], hasUI: true }), "retry");
	assert.equal(sessionSharedRetryRecovery(store, "root"), false);
});

test("all extension module instances resolve one process-wide policy store", () => {
	assert.equal(sharedSessionPolicyStore(), sharedSessionPolicyStore());
});
