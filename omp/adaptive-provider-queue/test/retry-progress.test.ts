import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RETRY_PROGRESS_STATUS_KEY,
	RetryStatusController,
	formatRetryProgress,
	sharedRetryStatusController,
	type AdaptiveRetryProgress,
} from "../src/retry-progress.ts";

const retrying: AdaptiveRetryProgress = {
	provider: "tokenking-queued",
	model: "gpt-5.6-sol",
	phase: "backoff",
	attempt: 2,
	maxRetries: 50,
	kind: "transport",
	queuePosition: 1,
	queueDepth: 2,
};

test("retry progress renders a compact fixed-width ASCII bar", () => {
	assert.equal(formatRetryProgress(retrying), "TokenKing retry 2/50 [#-----------] transport q1/2");
	assert.equal(
		formatRetryProgress({ ...retrying, phase: "queued", attempt: 0, kind: undefined, queuePosition: 2 }),
		"TokenKing queued [------------] q2/2",
	);
	assert.equal(
		formatRetryProgress({ ...retrying, attempt: 50, kind: "rate-limit", queueDepth: 1 }),
		"TokenKing retry 50/50 [############] rate limit q1/1",
	);
});

test("one status slot is replaced and stale streams cannot clear newer progress", () => {
	const updates: Array<{ key: string; text: string | undefined }> = [];
	const controller = new RetryStatusController();
	controller.bindSession("session", {
		setStatus: (key, text) => updates.push({ key, text }),
	});
	const first = controller.createReporter("session");
	const second = controller.createReporter("session");

	first(retrying);
	first(retrying);
	second({ ...retrying, attempt: 3 });
	first(undefined);
	second(undefined);

	assert.deepEqual(updates, [
		{ key: RETRY_PROGRESS_STATUS_KEY, text: "TokenKing retry 2/50 [#-----------] transport q1/2" },
		{ key: RETRY_PROGRESS_STATUS_KEY, text: "TokenKing retry 3/50 [#-----------] transport q1/2" },
		{ key: RETRY_PROGRESS_STATUS_KEY, text: undefined },
	]);
});

test("reporters from non-active sessions do not write into the interactive status", () => {
	const updates: Array<string | undefined> = [];
	const controller = new RetryStatusController();
	controller.bindSession("active", { setStatus: (_key, text) => updates.push(text) });
	controller.createReporter("detached")(retrying);
	controller.createReporter(undefined)(retrying);
	assert.deepEqual(updates, []);
});

test("all extension instances resolve one process-wide retry status controller", () => {
	assert.equal(sharedRetryStatusController(), sharedRetryStatusController());
});

test("a failed status update does not disable a later terminal clear", () => {
	const updates: Array<string | undefined> = [];
	let call = 0;
	const controller = new RetryStatusController();
	controller.bindSession("session", {
		setStatus: (_key, text) => {
			call += 1;
			if (call === 2) throw new Error("temporary UI failure");
			updates.push(text);
		},
	});
	const reporter = controller.createReporter("session");
	reporter(retrying);
	assert.throws(() => reporter({ ...retrying, attempt: 3 }), /temporary UI failure/);
	reporter(undefined);
	assert.deepEqual(updates, ["TokenKing retry 2/50 [#-----------] transport q1/2", undefined]);
});
