export const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODE_API = "adaptive-queued-kimi";
export const KIMI_CODE_API_KEY = "!omp token kimi-code --raw";

const KIMI_CLI_HEADERS = {
	"User-Agent": "KimiCLI/1.0",
	"X-Msh-Platform": "kimi_cli",
};

type KimiEffort = "minimal" | "low" | "medium" | "high" | "max";

interface KimiModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: {
		mode: "effort";
		efforts: KimiEffort[];
		requiresEffort?: boolean;
		defaultLevel?: KimiEffort;
	};
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: {
		thinkingFormat: "kimi" | "zai";
		reasoningContentField: "reasoning_content";
		supportsDeveloperRole: false;
	};
}

export const KIMI_MODEL_SPECS: KimiModelSpec[] = [
	{
		id: "k3",
		name: "K3 (Kimi Code, adaptive queue)",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: ["low", "high", "max"],
			requiresEffort: true,
			defaultLevel: "high",
		},
		input: ["text", "image"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: {
			thinkingFormat: "kimi",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	},
	{
		id: "k3-256k",
		name: "K3-256k (Kimi Code, adaptive queue)",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: ["low", "high", "max"],
			requiresEffort: true,
			defaultLevel: "high",
		},
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 131_072,
		compat: {
			thinkingFormat: "kimi",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	},
	{
		id: "kimi-for-coding",
		name: "K2.7 Coding (Kimi Code, adaptive queue)",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		headers: KIMI_CLI_HEADERS,
		compat: {
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	},
	{
		id: "kimi-for-coding-highspeed",
		name: "K2.7 Coding Highspeed (Kimi Code, adaptive queue)",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 32_768,
		compat: {
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			supportsDeveloperRole: false,
		},
	},
	{
		id: "kimi-k2",
		name: "Kimi K2 (Kimi Code, adaptive queue)",
		reasoning: false,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 262_144,
		headers: KIMI_CLI_HEADERS,
	},
	{
		id: "kimi-k2-turbo-preview",
		name: "Kimi K2 Turbo (Kimi Code, adaptive queue)",
		reasoning: false,
		input: ["text"],
		contextWindow: 262_144,
		maxTokens: 32_000,
		headers: KIMI_CLI_HEADERS,
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5 (Kimi Code, adaptive queue)",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
		input: ["text", "image"],
		contextWindow: 262_144,
		maxTokens: 65_536,
		headers: KIMI_CLI_HEADERS,
	},
];

export function kimiTransportOptions<T extends { apiKey?: string }>(options?: T): T & {
	apiKey: string | undefined;
	maxRetries: 0;
} {
	return {
		...(options ?? ({} as T)),
		apiKey: options?.apiKey,
		maxRetries: 0,
	};
}

export function kimiStreamModel<
	TModel extends {
		id: string;
		provider: string;
		compat?: object;
		compatConfig?: object;
	},
	TCanonical extends {
		compat?: object;
		compatConfig?: object;
	},
>(model: TModel, canonical: TCanonical): TModel & TCanonical & {
	api: "openai-completions";
	baseUrl: string;
	compat: Record<string, unknown>;
	compatConfig: Record<string, unknown>;
} {
	const spec = KIMI_MODEL_SPECS.find(candidate => candidate.id === model.id);
	return {
		...canonical,
		...spec,
		...model,
		api: "openai-completions",
		baseUrl: KIMI_CODE_BASE_URL,
		compat: {
			...(canonical.compat ?? {}),
			...(spec?.compat ?? {}),
			...(model.compat ?? {}),
		},
		compatConfig: {
			...(canonical.compatConfig ?? {}),
			...(spec?.compat ?? {}),
			...(model.compatConfig ?? {}),
		},
	};
}
