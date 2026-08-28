import type { Api } from "@oh-my-pi/pi-ai";

export const ADAPTIVE_RETRY_API = "adaptive-universal-provider-retry" as Api;

const ORIGINAL_API = Symbol.for("omp.adaptive-provider-queue.original-api.v1");
const AGENTROUTER_ORIGIN = "https://agentrouter.org";
const AGENTROUTER_CODEX_USER_AGENT = "codex_cli_rs/0.1.0";
const AGENTROUTER_CODEX_RESPONSE_PATHS = new Set([
	"/codex/responses",
	"/v1/codex/responses",
]);
const AGENTROUTER_RESPONSES_BASE_URL = `${AGENTROUTER_ORIGIN}/v1`;

interface MutableModel {
	provider: string;
	id: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	[key: PropertyKey]: unknown;
}

interface ProviderRequestOptions {
	betas?: string | string[];
	fetch?: typeof globalThis.fetch;
	[key: string]: unknown;
}

/** AgentRouter account aliases share the same wire protocol but use separate credentials. */
export function isAgentRouterProvider(provider: string): boolean {
	return /^agentrouter(?:-\d+)?$/.test(provider);
}

/** Providers whose numbered aliases represent independent accounts for quota fallback. */
export function isQuotaFallbackProvider(provider: string): boolean {
	return isAgentRouterProvider(provider) || /^justworker(?:-\d+)?$/.test(provider);
}

export interface ModelRegistryLike {
	getAll(): unknown[];
}

function isMutableModel(value: unknown): value is MutableModel {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<MutableModel>;
	return (
		typeof candidate.provider === "string" &&
		typeof candidate.id === "string" &&
		typeof candidate.api === "string"
	);
}

function modelKey(model: Pick<MutableModel, "provider" | "id" | "baseUrl">): string {
	return `${model.provider}\u0000${model.id}\u0000${model.baseUrl ?? ""}`;
}

function commaSeparatedValues(value: unknown): string[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return values
		.flatMap(entry => typeof entry === "string" ? entry.split(",") : [])
		.map(entry => entry.trim())
		.filter(Boolean);
}

function anthropicBetaFetch(
	baseFetch: typeof globalThis.fetch,
	requestBetas: readonly string[],
): typeof globalThis.fetch {
	return (input, init) => {
		const inputHeaders = input instanceof Request ? input.headers : undefined;
		const initHeaders = new Headers(init?.headers);
		const headers = new Headers(inputHeaders);
		initHeaders.forEach((value, name) => headers.set(name, value));

		const betas = [...new Set([
			...commaSeparatedValues(inputHeaders?.get("anthropic-beta")),
			...commaSeparatedValues(initHeaders.get("anthropic-beta")),
			...requestBetas,
		])];
		headers.set("anthropic-beta", betas.join(","));

		return baseFetch(new Request(input, { ...init, headers }));
	};
}

function agentRouterCodexResponsesFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const isCodexPath = AGENTROUTER_CODEX_RESPONSE_PATHS.has(url.pathname);
		if (url.origin !== AGENTROUTER_ORIGIN || (!isCodexPath && url.pathname !== "/v1/responses")) {
			return baseFetch(input, init);
		}

		if (isCodexPath) url.pathname = "/v1/responses";
		const originalHeaders = input instanceof Request ? input.headers : undefined;
		const headers = new Headers(originalHeaders);
		const overrideHeaders = new Headers(init?.headers);
		overrideHeaders.forEach((value, name) => headers.set(name, value));
		headers.set("user-agent", AGENTROUTER_CODEX_USER_AGENT);
		if (input instanceof Request) {
			return baseFetch(new Request(url, input), { ...init, headers });
		}
		return baseFetch(url, { ...init, headers });
	};
}

function isAgentRouterOrigin(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).origin === AGENTROUTER_ORIGIN;
	} catch {
		return false;
	}
}

/**
 * The OMP Codex transport owns its endpoint path and does not honor a
 * request-local fetch override. Use the ordinary Responses transport for
 * AgentRouter GPT models so the gateway receives `/v1/responses` directly.
 */
export function modelForProviderRequest<T extends MutableModel>(model: T): T {
	if (
		!isAgentRouterProvider(model.provider) ||
		(model.api !== "openai-codex-responses" && model.api !== "openai-responses") ||
		!isAgentRouterOrigin(model.baseUrl)
	) {
		return model;
	}
	return {
		...model,
		api: "openai-responses" as Api,
		baseUrl: AGENTROUTER_RESPONSES_BASE_URL,
		headers: {
			...model.headers,
			"user-agent": AGENTROUTER_CODEX_USER_AGENT,
		},
	};
}

/** Applies request-local compatibility options before the original provider transport runs. */
export function modelRequestOptions<T extends ProviderRequestOptions | undefined>(
	model: MutableModel,
	options: T,
): T | ProviderRequestOptions {
	if (
		isAgentRouterProvider(model.provider) &&
		(model.api === "openai-codex-responses" || model.api === "openai-responses") &&
		isAgentRouterOrigin(model.baseUrl)
	) {
		return {
			...options,
			headers: {
				...((options as ProviderRequestOptions | undefined)?.headers as Record<string, string> | undefined),
				"user-agent": AGENTROUTER_CODEX_USER_AGENT,
			},
			fetch: agentRouterCodexResponsesFetch(options?.fetch ?? globalThis.fetch),
		};
	}
	if (model.api !== "anthropic-messages" || !model.headers) return options ?? {};
	const configuredBetas = Object.entries(model.headers)
		.filter(([name]) => name.toLowerCase() === "anthropic-beta")
		.flatMap(([, value]) => commaSeparatedValues(value));
	if (configuredBetas.length === 0) return options ?? {};
	const betas = [...new Set([...commaSeparatedValues(options?.betas), ...configuredBetas])];
	const baseFetch = options?.fetch ?? globalThis.fetch;
	return {
		...options,
		betas: betas.join(","),
		fetch: anthropicBetaFetch(baseFetch, betas),
	};
}

/** Replaces model transports in place while retaining enough data to call the original API. */
export class UniversalProviderRetry {
	private readonly originalByModel = new WeakMap<object, Api>();
	private readonly originalByKey = new Map<string, Api>();

	wrapRegistry(registry: ModelRegistryLike): number {
		let wrapped = 0;
		for (const model of registry.getAll()) {
			if (this.wrapModel(model)) wrapped += 1;
		}
		return wrapped;
	}

	wrapModel(value: unknown): boolean {
		if (!isMutableModel(value) || value.api === ADAPTIVE_RETRY_API) return false;
		const originalApi = value.api;
		this.originalByModel.set(value, originalApi);
		this.originalByKey.set(modelKey(value), originalApi);
		try {
			Object.defineProperty(value, ORIGINAL_API, {
				value: originalApi,
				configurable: true,
			});
		} catch {
			// The WeakMap remains authoritative when a model rejects extra properties.
		}
		value.api = ADAPTIVE_RETRY_API;
		return true;
	}

	restoreOriginalModel<T extends MutableModel>(model: T): T {
		const taggedApi = model[ORIGINAL_API];
		const originalApi =
			(typeof taggedApi === "string" ? taggedApi as Api : undefined) ??
			this.originalByModel.get(model) ??
			this.originalByKey.get(modelKey(model));
		if (!originalApi || originalApi === ADAPTIVE_RETRY_API) {
			throw new Error(`Missing original provider API for ${model.provider}/${model.id}`);
		}
		return { ...model, api: originalApi };
	}
}
