import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ADAPTIVE_5XX_POLICY_ENTRY,
	DEFAULT_TRANSIENT_UPSTREAM_MODE,
	parseTransientUpstreamModeCommand,
	transientUpstreamModeFromEntries,
} from "../src/session-policy.ts";

test("sessions default to retrying generic upstream 5xx failures", () => {
	assert.equal(DEFAULT_TRANSIENT_UPSTREAM_MODE, "retry");
	assert.equal(transientUpstreamModeFromEntries([]), "retry");
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

test("the session command parses status, explicit modes and toggle", () => {
	assert.equal(parseTransientUpstreamModeCommand("", "retry"), "status");
	assert.equal(parseTransientUpstreamModeCommand(" STATUS ", "fallback"), "status");
	assert.equal(parseTransientUpstreamModeCommand("retry", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("FALLBACK", "retry"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "retry"), "fallback");
	assert.equal(parseTransientUpstreamModeCommand("toggle", "fallback"), "retry");
	assert.equal(parseTransientUpstreamModeCommand("unknown", "retry"), undefined);
});
