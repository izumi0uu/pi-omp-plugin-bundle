import {
	createAssistantMessageEventStream,
	getModel,
	streamKimi,
	streamSimple,
	type Api,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	KIMI_CODE_API,
	KIMI_CODE_API_KEY,
	KIMI_CODE_BASE_URL,
	KIMI_MODEL_SPECS,
	kimiStreamModel,
	kimiTransportOptions,
} from "./kimi-config.ts";
import { AdaptiveProviderQueue } from "./queue.ts";
import { toOpenAIResponsesModel } from "./responses-model.ts";
import { sharedRetryStatusController } from "./retry-progress.ts";
import {
	ADAPTIVE_5XX_POLICY_ENTRY,
	ADAPTIVE_SHARE_POLICY_ENTRY,
	formatAdaptivePolicyStatus,
	parseSharedRetryRecoveryCommand,
	parseTransientUpstreamModeCommand,
	restoreSessionPolicy,
	sessionPolicyMode,
	sessionSharedRetryRecovery,
	setSessionPolicy,
	setSessionSharedRetryRecovery,
	sharedSessionPolicyStore,
	type TransientUpstreamMode,
} from "./session-policy.ts";
import { createAdaptiveStream } from "./stream-wrapper.ts";

const QUEUED_RESPONSES_API = "adaptive-queued-openai-responses" as Api;
const KIMI_MODELS = KIMI_MODEL_SPECS.map(model => ({
	...model,
	api: KIMI_CODE_API as Api,
	baseUrl: KIMI_CODE_BASE_URL,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

const queue = new AdaptiveProviderQueue({
	baseDelayMs: 500,
	maxDelayMs: 300_000,
});
const sessionPolicies = sharedSessionPolicyStore();
const retryStatuses = sharedRetryStatusController();

export default function adaptiveProviderQueue(pi: ExtensionAPI): void {
	type SessionContextLike = {
		hasUI: boolean;
		ui: { setStatus(key: string, text: string | undefined): void };
		localProtocolOptions?: { getSessionId?(): string | null };
		sessionManager: {
			getArtifactsDir(): string | null;
			getBranch(): unknown[];
			getSessionId(): string;
		};
	};
	const updateStatus = (
		ctx: SessionContextLike,
		mode: TransientUpstreamMode,
		sharedRetryRecovery: boolean,
	) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"adaptive-provider-queue:5xx",
			formatAdaptivePolicyStatus(mode, sharedRetryRecovery),
		);
	};
	const rehydrateSessionPolicy = (ctx: SessionContextLike) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI) retryStatuses.bindSession(sessionId, ctx.ui);
		const lineageSessionId = ctx.localProtocolOptions?.getSessionId?.() ?? undefined;
		const artifactsDir = ctx.sessionManager.getArtifactsDir() ?? undefined;
		const mode = restoreSessionPolicy(sessionPolicies, {
			sessionId,
			entries: ctx.sessionManager.getBranch(),
			hasUI: ctx.hasUI,
			lineageSessionId,
			artifactsDir,
		});
		updateStatus(ctx, mode, sessionSharedRetryRecovery(sessionPolicies, sessionId));
	};
	const streamOptions = (options: { sessionId?: string } | undefined) => ({
		retryTransientUpstream5xx: sessionPolicyMode(sessionPolicies, options?.sessionId) === "retry",
		sharedRetryRecovery: sessionSharedRetryRecovery(sessionPolicies, options?.sessionId),
		onProgress: retryStatuses.createReporter(options?.sessionId),
	});

	pi.registerCommand("adaptive-5xx", {
		description: "Choose whether generic 502/503/504 errors retry or immediately fall back in this session",
		handler: (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const currentMode = sessionPolicyMode(sessionPolicies, sessionId);
			const command = parseTransientUpstreamModeCommand(args, currentMode);
			if (!command) {
				ctx.ui.notify("Usage: /adaptive-5xx [status|retry|fallback|toggle]", "warning");
				return;
			}
			if (command !== "status") {
				setSessionPolicy(sessionPolicies, sessionId, command);
				pi.appendEntry(ADAPTIVE_5XX_POLICY_ENTRY, { mode: command });
			}
			const mode = sessionPolicyMode(sessionPolicies, sessionId);
			const sharedRetryRecovery = sessionSharedRetryRecovery(sessionPolicies, sessionId);
			updateStatus(ctx, mode, sharedRetryRecovery);
			ctx.ui.notify(
				mode === "retry"
					? `Generic 502/503/504 errors will use a ${sharedRetryRecovery ? "shared" : "local"} 50-attempt retry budget in this session.`
					: "Generic 502/503/504 errors will immediately enter OMP fallback in this session.",
				"info",
			);
		},
	});
	pi.registerCommand("adaptive-share", {
		description: "Choose whether retry recovery state is shared across OMP sessions",
		handler: (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const current = sessionSharedRetryRecovery(sessionPolicies, sessionId);
			const command = parseSharedRetryRecoveryCommand(args, current);
			if (command === undefined) {
				ctx.ui.notify("Usage: /adaptive-share [status|on|off|toggle]", "warning");
				return;
			}
			if (command !== "status") {
				setSessionSharedRetryRecovery(sessionPolicies, sessionId, command);
				pi.appendEntry(ADAPTIVE_SHARE_POLICY_ENTRY, { enabled: command });
			}
			const enabled = sessionSharedRetryRecovery(sessionPolicies, sessionId);
			updateStatus(ctx, sessionPolicyMode(sessionPolicies, sessionId), enabled);
			ctx.ui.notify(
				enabled
					? "Retry recovery will share queue state across OMP sessions."
					: "Retry recovery will use an isolated local retry budget.",
				"info",
			);
		},
	});
	pi.on("session_start", (_event, ctx) => rehydrateSessionPolicy(ctx));
	pi.on("session_switch", (_event, ctx) => rehydrateSessionPolicy(ctx));
	pi.on("session_branch", (_event, ctx) => rehydrateSessionPolicy(ctx));
	pi.on("session_tree", (_event, ctx) => rehydrateSessionPolicy(ctx));

	pi.registerProvider("adaptive-provider-queue", {
		api: QUEUED_RESPONSES_API,
		streamSimple: (model, context, options) =>
			createAdaptiveStream({
				model,
				requestOptions: options,
				queue,
				maxRetries: 50,
				...streamOptions(options),
				createOutputStream: () => createAssistantMessageEventStream(),
				createInputStream: () =>
					streamSimple(
						toOpenAIResponsesModel(model),
						context,
						{ ...options, maxRetries: 0 },
					),
				logger: pi.logger,
			}),
	});

	pi.registerProvider("aiinput-queued", {
		baseUrl: "https://ai.input.im/v1",
		apiKey: "AIINPUT_API_KEY",
		api: QUEUED_RESPONSES_API,
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT 5.6 Sol (AI Input, adaptive queue)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 372_000,
				maxTokens: 32_768,
			},
		],
	});

	pi.registerProvider("aiinput-overseas-queued", {
		baseUrl: "https://input.codes/v1",
		apiKey: "AIINPUT_API_KEY",
		api: QUEUED_RESPONSES_API,
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT 5.6 Sol (AI Input overseas, adaptive queue)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 372_000,
				maxTokens: 32_768,
			},
		],
	});

	pi.registerProvider("aiinput2-overseas-queued", {
		baseUrl: "https://input.codes/v1",
		apiKey: "AIINPUT2_API_KEY",
		api: QUEUED_RESPONSES_API,
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT 5.6 Sol (AI Input 2 overseas, adaptive queue)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 372_000,
				maxTokens: 32_768,
			},
		],
	});

	pi.registerProvider("tokenking-queued", {
		baseUrl: "https://api.tokenskingdom.com/v1",
		apiKey: "TOKENKING_API_KEY",
		api: QUEUED_RESPONSES_API,
		models: [
			{
				id: "gpt-5.6-sol",
				name: "GPT 5.6 Sol (TokenKing, adaptive queue)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 372_000,
				maxTokens: 32_768,
			},
		],
	});

	pi.registerProvider("tokenking-grok-queued", {
		baseUrl: "https://api.tokenskingdom.com/v1",
		apiKey: "TOKENKING_GROK_API_KEY",
		api: QUEUED_RESPONSES_API,
		models: [
			{
				id: "grok-4.5",
				name: "Grok 4.5 (TokenKing, adaptive queue)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 256_000,
				maxTokens: 32_768,
			},
		],
	});

	pi.registerProvider("kimi-code-queued", {
		baseUrl: KIMI_CODE_BASE_URL,
		apiKey: KIMI_CODE_API_KEY,
		api: KIMI_CODE_API as Api,
		streamSimple: (model, context, options) =>
			createAdaptiveStream({
				model,
				requestOptions: options,
				queue,
				maxRetries: 50,
				...streamOptions(options),
				createOutputStream: () => createAssistantMessageEventStream(),
				createInputStream: () => {
					const canonicalModel = getModel("kimi-code", model.id);
					if (!canonicalModel) {
						throw new Error(`Missing canonical Kimi Code model: ${model.id}`);
					}
					return streamKimi(
						kimiStreamModel(model, canonicalModel) as Parameters<typeof streamKimi>[0],
						context,
						kimiTransportOptions(options),
					);
				},
				logger: pi.logger,
			}),
		models: KIMI_MODELS,
	});
}
