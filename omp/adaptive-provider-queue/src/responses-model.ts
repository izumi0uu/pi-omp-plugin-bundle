interface ResponsesModelLike {
	provider: string;
	id?: string;
	name?: string;
	reasoning?: boolean;
	compat?: unknown;
	compatConfig?: unknown;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Custom API models do not receive OMP's resolved Responses compatibility view. */
export function toOpenAIResponsesModel<T extends ResponsesModelLike>(model: T): T & {
	api: "openai-responses";
	compat: Record<string, unknown>;
} {
	const id = model.id ?? "";
	const name = model.name ?? "";
	const identity = `${id} ${name}`;
	const isKimi = /kimi/i.test(identity);
	const isDeepseek = /deepseek/i.test(identity);
	const isSamplingRestricted = /(?:^|[/ ])(?:o[134](?:$|[-:. ])|gpt-5(?:[.-]|$))/i.test(identity);
	const configuredCompat = isRecord(model.compat)
		? model.compat
		: isRecord(model.compatConfig)
			? model.compatConfig
			: {};

	const compat: Record<string, unknown> = {
		supportsDeveloperRole: false,
		supportsStrictMode: false,
		supportsReasoningEffort: true,
		supportsLongPromptCacheRetention: false,
		supportsPromptCacheBreakpoints: false,
		strictResponsesPairing: false,
		supportsImageDetailOriginal: true,
		reasoningEffortMap: {},
		supportsReasoningParams: true,
		supportsSamplingParams: !isSamplingRestricted,
		thinkingFormat: "openai",
		reasoningDisableMode: "lowest-effort",
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: false,
		disableReasoningOnForcedToolChoice: isKimi,
		disableReasoningOnToolChoice: isDeepseek && Boolean(model.reasoning),
		supportsToolChoice: true,
		supportsForcedToolChoice: true,
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls: (isKimi || isDeepseek) && Boolean(model.reasoning),
		requiresReasoningContentForAllAssistantTurns: isDeepseek && Boolean(model.reasoning),
		allowsSyntheticReasoningContentForToolCalls: !isDeepseek || !model.reasoning,
		replayReasoningContent: false,
		qwenPreserveThinking: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: isKimi,
		isOpenRouterHost: false,
		isVercelGatewayHost: false,
		wireModelIdMode: "raw",
		toolSchemaFlavor: isKimi ? "moonshot-mfjs" : undefined,
		alwaysSendMaxTokens: isKimi,
		enableGeminiThinkingLoopGuard: /gemini/i.test(identity),
		supportsObfuscationOptOut: false,
		stripDeepseekSpecialTokens: false,
		streamMarkupHealingPattern: "thinking",
		reasoningDeltasMayBeCumulative: /minimax/i.test(identity),
		emptyLengthFinishIsContextError: false,
		usesOpenAIToolCallIdLimit: false,
		...configuredCompat,
	};

	return { ...model, api: "openai-responses", compat };
}
