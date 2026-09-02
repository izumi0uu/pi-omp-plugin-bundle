export interface ContentBlockLike {
	type?: string;
	text?: string;
}

export interface MessageLike {
	role?: string;
	attribution?: string;
	content?: string | ContentBlockLike[];
}

export interface SessionEntryLike {
	type?: string;
	message?: MessageLike;
}

export interface CopyTurn {
	question: string;
	answer: string;
	markdown: string;
}

/** Extract only visible text, excluding thinking, tool calls, results, and images. */
export function visibleText(message: MessageLike): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is ContentBlockLike & { text: string } => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("")
		.trim();
}

function isHumanUserMessage(message: MessageLike): boolean {
	return message.role === "user" && message.attribution !== "agent";
}

export function formatCopyTurn(question: string, answer: string): string {
	return `## Question\n\n${question.trim()}\n\n## Answer\n\n${answer.trim()}`;
}

/**
 * Locate the latest settled human turn. The answer is the last visible assistant
 * message after that prompt, rather than tool-only or retry bookkeeping messages.
 */
export function findLatestCopyTurn(messages: readonly MessageLike[]): CopyTurn | undefined {
	let questionIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && isHumanUserMessage(message) && visibleText(message)) {
			questionIndex = index;
			break;
		}
	}
	if (questionIndex < 0) return undefined;

	let answer = "";
	for (let index = messages.length - 1; index > questionIndex; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		answer = visibleText(message);
		if (answer) break;
	}
	if (!answer) return undefined;

	const question = visibleText(messages[questionIndex] as MessageLike);
	return { question, answer, markdown: formatCopyTurn(question, answer) };
}

/** Read persisted messages from the active session branch after /resume or a session switch. */
export function findLatestCopyTurnInEntries(entries: readonly SessionEntryLike[]): CopyTurn | undefined {
	return findLatestCopyTurn(
		entries
			.filter((entry): entry is SessionEntryLike & { message: MessageLike } => entry.type === "message" && !!entry.message)
			.map(entry => entry.message),
	);
}
