import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	HANDOFF_ENTRY_TYPE,
	buildOrchestrationMessage,
	createHandoffPlan,
	formatPlan,
	normalizeHandoffRequest,
	parseHandoffCommand,
	type HandoffPlan,
} from "./handoff.ts";

type AnyContext = ExtensionContext & {
	hasUI?: boolean;
	getAsyncJobSnapshot?: () => unknown;
	ui: ExtensionContext["ui"] & { notify(message: string, level?: "info" | "warning" | "error"): void };
};

type CommandContext = ExtensionCommandContext & AnyContext;

function textResult(text: string, details?: unknown): { content: Array<{ type: "text"; text: string }>; details?: unknown } {
	return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
}

function contextSnapshot(ctx: AnyContext): unknown {
	try {
		return ctx.getAsyncJobSnapshot?.() ?? undefined;
	} catch {
		return undefined;
	}
}

function createPlan(raw: Record<string, unknown>): HandoffPlan {
	const request = normalizeHandoffRequest(raw);
	return createHandoffPlan(request, { requestId: `h-${randomUUID().slice(0, 12)}` });
}

function queueOrchestration(pi: ExtensionAPI, plan: HandoffPlan, ctx: AnyContext, explicitHandoff?: string): void {
	const message = buildOrchestrationMessage(plan, {
		cwd: ctx.cwd,
		snapshot: contextSnapshot(ctx),
		explicitHandoff,
	});
	pi.appendEntry(HANDOFF_ENTRY_TYPE, {
		requestId: plan.requestId,
		sourceAgentId: plan.sourceAgentId,
		targetAgent: plan.targetAgent,
		reason: plan.reason,
		createdAt: plan.createdAt,
		mode: "replacement",
	});
	pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
}

function notifyPlan(ctx: AnyContext, plan: HandoffPlan): void {
	ctx.ui.notify(`${formatPlan(plan)}\nThe parent Agent will now run the public hub/task sequence.`, "info");
}

function commandRequest(args: string, requireTarget: boolean): Record<string, unknown> | undefined {
	const parsed = parseHandoffCommand(args);
	if (!parsed || (requireTarget && !parsed.targetAgent)) return undefined;
	if (!requireTarget && parsed.targetAgent) {
		return { sourceAgentId: parsed.sourceAgentId, targetAgent: parsed.targetAgent, reason: parsed.reason };
	}
	return {
		sourceAgentId: parsed.sourceAgentId,
		targetAgent: parsed.targetAgent ?? "task",
		...(parsed.reason ? { reason: parsed.reason } : {}),
	};
}

export default function taskProviderHandoff(pi: ExtensionAPI): void {
	const runCommand = (args: string, ctx: CommandContext, requireTarget: boolean): void => {
		const raw = commandRequest(args, requireTarget);
		if (!raw) {
			ctx.ui.notify(
				requireTarget
					? "Usage: /task-replace <source-agent-id> <target-agent-profile> [reason]"
					: "Usage: /task-handoff <source-agent-id> [target-agent-profile] [reason]",
				"warning",
			);
			return;
		}
		try {
			const plan = createPlan(raw);
			queueOrchestration(pi, plan, ctx);
			notifyPlan(ctx, plan);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("task-handoff", {
		description: "Ask a running OMP task agent for a structured handoff",
		handler: (args, ctx) => runCommand(args, ctx as CommandContext, false),
	});
	pi.registerCommand("task-replace", {
		description: "Replace a task agent with another provider-bound agent profile",
		handler: (args, ctx) => runCommand(args, ctx as CommandContext, true),
	});

	const z = pi.zod;
	pi.registerTool({
		name: "task_provider_handoff",
		label: "task provider handoff",
		description: "Prepare a safe mid-run replacement of a subagent: request a handoff, stop the old child, and continue with a target agent/profile. This queues the public hub/task orchestration; it never mutates a running child model.",
		parameters: z.object({
			sourceAgentId: z.string(),
			targetAgent: z.string(),
			reason: z.string().optional(),
			task: z.string().optional(),
			explicitHandoff: z.string().optional(),
			timeoutMs: z.number().optional(),
		}),
		approval: "exec",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) return textResult("Handoff cancelled before it was queued.");
			try {
				const plan = createPlan(params as Record<string, unknown>);
				queueOrchestration(pi, plan, ctx as AnyContext, typeof (params as Record<string, unknown>).explicitHandoff === "string" ? (params as Record<string, unknown>).explicitHandoff as string : undefined);
				return textResult(
					`${formatPlan(plan)}\n\nThe follow-up orchestration message is queued. It must call hub/task and report their real results.`,
					{ ...plan, orchestrationQueued: true },
				);
			} catch (error) {
				return textResult(error instanceof Error ? error.message : String(error), { orchestrationQueued: false });
			}
		},
	});
}
