export const HANDOFF_ENTRY_TYPE = "omp-task-provider-handoff";
export const DEFAULT_HANDOFF_TIMEOUT_MS = 30_000;
export const MAX_HANDOFF_TIMEOUT_MS = 300_000;
export const MAX_HANDOFF_TEXT_CHARS = 12_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface HandoffRequest {
	sourceAgentId: string;
	targetAgent: string;
	reason?: string;
	task?: string;
	explicitHandoff?: string;
	timeoutMs: number;
}

export interface HandoffCommand {
	sourceAgentId: string;
	targetAgent?: string;
	reason?: string;
}

export interface HandoffPlan {
	requestId: string;
	sourceAgentId: string;
	targetAgent: string;
	sourceHistory: string;
	reason: string;
	task: string;
	timeoutMs: number;
	createdAt: string;
}

export function isSafeAgentId(value: string): boolean {
	return ID_PATTERN.test(value.trim());
}

function cleanText(value: unknown, maxChars = MAX_HANDOFF_TEXT_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n[truncated]` : trimmed;
}

export function normalizeHandoffRequest(input: Record<string, unknown>): HandoffRequest {
	const sourceAgentId = cleanText(input.sourceAgentId, 64);
	const targetAgent = cleanText(input.targetAgent, 64);
	if (!sourceAgentId || !isSafeAgentId(sourceAgentId)) {
		throw new Error("sourceAgentId must be an OMP agent id (letters, numbers, '.', '_' or '-').");
	}
	if (!targetAgent || !isSafeAgentId(targetAgent)) {
		throw new Error("targetAgent must be an OMP agent/profile name (letters, numbers, '.', '_' or '-').");
	}
	const timeoutValue = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
		? Math.floor(input.timeoutMs)
		: DEFAULT_HANDOFF_TIMEOUT_MS;
	const timeoutMs = Math.min(MAX_HANDOFF_TIMEOUT_MS, Math.max(1_000, timeoutValue));
	return {
		sourceAgentId,
		targetAgent,
		...(cleanText(input.reason) ? { reason: cleanText(input.reason) } : {}),
		...(cleanText(input.task) ? { task: cleanText(input.task) } : {}),
		...(cleanText(input.explicitHandoff) ? { explicitHandoff: cleanText(input.explicitHandoff) } : {}),
		timeoutMs,
	};
}

export function parseHandoffCommand(args: string): HandoffCommand | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || tokens.length > 1 && tokens[0] === "status") return undefined;
	const sourceAgentId = tokens[0];
	if (!sourceAgentId || !isSafeAgentId(sourceAgentId)) return undefined;
	if (sourceAgentId.toLowerCase() === "status") return undefined;
	if (tokens.length === 1) return { sourceAgentId };
	const targetAgent = tokens[1];
	if (!targetAgent || !isSafeAgentId(targetAgent)) return undefined;
	const reason = tokens.slice(2).join(" ").trim();
	return { sourceAgentId, targetAgent, ...(reason ? { reason } : {}) };
}

export function createHandoffPlan(
	request: HandoffRequest,
	options: { requestId: string; now?: Date } = { requestId: "handoff" },
): HandoffPlan {
	const now = options.now ?? new Date();
	return {
		requestId: options.requestId,
		sourceAgentId: request.sourceAgentId,
		targetAgent: request.targetAgent,
		sourceHistory: `history://${request.sourceAgentId}`,
		reason: request.reason ?? "The parent requested a provider/profile replacement.",
		task: request.task ?? "Continue the source task from the handoff and its history. Preserve the original acceptance criteria and do not redo completed work.",
		timeoutMs: request.timeoutMs,
		createdAt: now.toISOString(),
	};
}

function cap(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars)}\n[truncated]` : value;
}

export function buildOrchestrationMessage(
	plan: HandoffPlan,
	options: { cwd?: string; snapshot?: unknown; explicitHandoff?: string } = {},
): string {
	const handoff = cap(options.explicitHandoff ?? "Ask the source to return completed work, unfinished work, changed files, tests, blockers, and the exact next step. Keep it concise and factual.", MAX_HANDOFF_TEXT_CHARS);
	const snapshot = options.snapshot === undefined ? "unavailable" : cap(JSON.stringify(options.snapshot), 4_000);
	const task = cap(plan.task, MAX_HANDOFF_TEXT_CHARS);
	const reason = cap(plan.reason, 2_000);
	const cwd = options.cwd ? cap(options.cwd, 1_000) : "current workspace";
	return [
		"Provider replacement coordinator: execute this handoff now.",
		"This is replacement, not an in-place model mutation. Do not edit a running child session's model or model.api.",
		`source child: ${plan.sourceAgentId}`,
		`target agent/profile: ${plan.targetAgent}`,
		`reason: ${reason}`,
		`workspace: ${cwd}`,
		`source transcript: ${plan.sourceHistory}`,
		`handoff request: ${handoff}`,
		"",
		"Required sequence:",
		`1. Use hub with {\"op\":\"list\"} and/or {\"op\":\"jobs\"}; confirm ${plan.sourceAgentId} exists and note whether it is running, idle, parked, or aborted.`,
		`2. If it is running or idle, use hub with {\"op\":\"send\",\"to\":${JSON.stringify(plan.sourceAgentId)},\"message\":<handoff request>,\"await\":true,\"timeoutMs\":${plan.timeoutMs}}. Do not cancel before the reply unless the user explicitly asks to discard work.`,
		`3. If a handoff reply arrives, use hub with {\"op\":\"cancel\",\"ids\":[${JSON.stringify(plan.sourceAgentId)}]} to stop the old task. If it is already parked/aborted, do not send or cancel it.`,
		`4. Use task with {\"context\":<handoff reply plus ${plan.sourceHistory} plus the original acceptance criteria>,\"tasks\":[{\"name\":${JSON.stringify(`${plan.sourceAgentId}-replacement-${plan.requestId.slice(-6)}`)},\"agent\":${JSON.stringify(plan.targetAgent)},\"task\":${JSON.stringify(task)}]}}.`,
		"5. Report the new child id, resolved target agent/model, handoff status, and any work that could not be transferred.",
		"",
		"Do not call task_provider_handoff again for this request. Do not claim success until hub/task return a result.",
		`Coordinator snapshot at request time: ${snapshot}`,
	].join("\n");
}

export function formatPlan(plan: HandoffPlan): string {
	return [
		`Handoff ${plan.requestId} prepared`,
		`source: ${plan.sourceAgentId}`,
		`target: ${plan.targetAgent}`,
		`history: ${plan.sourceHistory}`,
		`timeout: ${Math.round(plan.timeoutMs / 1_000)}s`,
		"mode: replacement (handoff -> cancel -> new task)",
	].join("\n");
}
