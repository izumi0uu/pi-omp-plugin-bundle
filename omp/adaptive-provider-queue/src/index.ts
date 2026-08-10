import {
	createAssistantMessageEventStream,
	streamSimple,
	type Api,
} from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AdaptiveProviderQueue } from "./queue.ts";
import { toOpenAIResponsesModel } from "./responses-model.ts";
import { createAdaptiveStream } from "./stream-wrapper.ts";

const QUEUED_RESPONSES_API = "adaptive-queued-openai-responses" as Api;
const queue = new AdaptiveProviderQueue({
	baseDelayMs: 500,
	maxDelayMs: 300_000,
});

export default function adaptiveProviderQueue(pi: ExtensionAPI): void {
	pi.registerProvider("adaptive-provider-queue", {
		api: QUEUED_RESPONSES_API,
		streamSimple: (model, context, options) =>
			createAdaptiveStream({
				model,
				requestOptions: options,
				queue,
				maxRetries: 50,
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
}
