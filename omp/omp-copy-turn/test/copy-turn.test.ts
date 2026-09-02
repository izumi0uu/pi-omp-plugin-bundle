import assert from "node:assert/strict";
import test from "node:test";
import {
	findLatestCopyTurn,
	findLatestCopyTurnInEntries,
	formatCopyTurn,
	visibleText,
} from "../src/copy-turn.ts";

test("visibleText keeps text blocks and excludes thinking and tool calls", () => {
	assert.equal(
		visibleText({
			content: [
				{ type: "thinking", text: "secret" },
				{ type: "text", text: "Hello" },
				{ type: "toolCall", text: "read" },
				{ type: "text", text: " world" },
			],
		}),
		"Hello world",
	);
});

test("findLatestCopyTurn pairs the latest human prompt with the final text answer", () => {
	const turn = findLatestCopyTurn([
		{ role: "user", attribution: "user", content: "First question" },
		{ role: "assistant", content: [{ type: "text", text: "First answer" }] },
		{ role: "user", attribution: "user", content: [{ type: "text", text: "Latest question" }] },
		{ role: "assistant", content: [{ type: "toolCall" }] },
		{ role: "toolResult", content: "ignored" },
		{ role: "assistant", content: [{ type: "text", text: "Final answer" }] },
	]);

	assert.deepEqual(turn, {
		question: "Latest question",
		answer: "Final answer",
		markdown: "## Question\n\nLatest question\n\n## Answer\n\nFinal answer",
	});
});

test("agent-attributed user messages are not treated as the human question", () => {
	const turn = findLatestCopyTurn([
		{ role: "user", attribution: "user", content: "Human request" },
		{ role: "assistant", content: [{ type: "text", text: "Working" }] },
		{ role: "user", attribution: "agent", content: "Automatic continuation" },
		{ role: "assistant", content: [{ type: "text", text: "Settled answer" }] },
	]);

	assert.equal(turn?.question, "Human request");
	assert.equal(turn?.answer, "Settled answer");
});

test("returns undefined when the turn has no visible final answer", () => {
	assert.equal(
		findLatestCopyTurn([
			{ role: "user", attribution: "user", content: "Question" },
			{ role: "assistant", content: [{ type: "thinking", text: "hidden" }, { type: "toolCall" }] },
		]),
		undefined,
	);
});

test("formatCopyTurn creates portable Markdown", () => {
	assert.equal(formatCopyTurn("  Q  ", "  A  "), "## Question\n\nQ\n\n## Answer\n\nA");
});

test("restores the latest turn from persisted session branch entries", () => {
	const turn = findLatestCopyTurnInEntries([
		{ type: "model_change" },
		{ type: "message", message: { role: "user", attribution: "user", content: "Restored question" } },
		{ type: "custom", message: { role: "user", content: "not a message entry" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Restored answer" }] } },
	]);

	assert.equal(turn?.question, "Restored question");
	assert.equal(turn?.answer, "Restored answer");
});
