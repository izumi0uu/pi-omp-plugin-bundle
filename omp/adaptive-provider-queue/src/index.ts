import {
	createAssistantMessageEventStream,
	isApiKeyResolver,
	resolveApiKeyOnce,
	seedApiKeyResolver,
	streamSimple,
	type ApiKey,
} from "@oh-my-pi/pi-ai";
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	AIINPUT_ENDPOINTS,
	AIINPUT_PROVIDER,
	AiInputEndpointRouter,
	formatAiInputRouteStatus,
	resolveAiInputEndpoint,
} from "./aiinput-router.ts";
import { AdaptiveProviderQueue } from "./queue.ts";
import { sharedRetryStatusController } from "./retry-progress.ts";
import {
	ADAPTIVE_5XX_POLICY_ENTRY,
	ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY,
	ADAPTIVE_SHARE_POLICY_ENTRY,
	formatAdaptivePolicyStatus,
	formatTransientUpstreamModeList,
	modeForcesIsolatedRetry,
	parseAiInputRouteCommand,
	parseSharedRetryRecoveryCommand,
	parseTransientUpstreamModeCommand,
	providerRequestAiInputRoutePolicy,
	restoreSessionPolicy,
	sessionAiInputRoutePolicy,
	sessionPolicyMode,
	sessionSharedRetryRecovery,
	setSessionAiInputRoutePolicy,
	setSessionPolicy,
	setSessionSharedRetryRecovery,
	sharedSessionPolicyStore,
	type SessionAiInputRoutePolicy,
	type TransientUpstreamMode,
} from "./session-policy.ts";
import {
	createAdaptiveStream,
	isAdaptiveTransientTransport,
	isAdaptiveTransientUpstream,
} from "./stream-wrapper.ts";
import {
	ADAPTIVE_RETRY_API,
	isQuotaFallbackProvider,
	modelForProviderRequest,
	modelRequestOptions,
	UniversalProviderRetry,
	type ModelRegistryLike,
} from "./universal-provider.ts";
import {
	findProviderConfigReferences,
	parseProviderConfigCommand,
	readProviderConfig,
	removeProviderConfig,
} from "./provider-config.ts";

const queue = new AdaptiveProviderQueue({
	baseDelayMs: 500,
	maxDelayMs: 300_000,
});
const sessionPolicies = sharedSessionPolicyStore();
const retryStatuses = sharedRetryStatusController();

export default function adaptiveProviderQueue(pi: ExtensionAPI): void {
	type SessionContextLike = {
		hasUI: boolean;
		ui: {
			setStatus(key: string, text: string | undefined): void;
			notify(message: string, level?: "info" | "warning" | "error"): void;
			select?(title: string, options: Array<{ label: string; description?: string }>): Promise<string | undefined>;
			confirm?(title: string, message: string): Promise<boolean>;
		};
		modelRegistry: ModelRegistryLike & {
			resolver?(model: unknown, sessionId?: string): unknown | Promise<unknown>;
		};
		localProtocolOptions?: { getSessionId?(): string | null };
		sessionManager: {
			getArtifactsDir(): string | null;
			getBranch(): unknown[];
			getEntries(): unknown[];
			getSessionId(): string;
		};
	};
	const universalRetry = new UniversalProviderRetry();
	const aiInputRouter = new AiInputEndpointRouter({
		logger: pi.logger,
		proxyForUrl: url => getProxyForUrl(AIINPUT_PROVIDER, url),
	});
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
	const effectiveSharedRetryRecovery = (mode: TransientUpstreamMode, sessionId: string | undefined) =>
		modeForcesIsolatedRetry(mode) ? false : sessionSharedRetryRecovery(sessionPolicies, sessionId);
	const updateAiInputRouteStatus = (ctx: SessionContextLike, policy: SessionAiInputRoutePolicy) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			"adaptive-provider-queue:aiinput-route",
			policy.mode === "pinned"
				? `AI Input: pinned ${policy.endpointId}`
				: undefined,
		);
	};
	const formatSessionAiInputRouteStatus = async (sessionId: string): Promise<string> => {
		const policy = sessionAiInputRoutePolicy(sessionPolicies, sessionId);
		const endpoint = policy.mode === "pinned" ? resolveAiInputEndpoint(policy.endpointId) : undefined;
		return formatAiInputRouteStatus(await aiInputRouter.snapshot(), {
			pinnedBaseUrl: endpoint?.baseUrl,
			pinExpiresAt: policy.mode === "pinned" ? policy.expiresAt : undefined,
		});
	};
	const prepareSession = (ctx: SessionContextLike) => {
		universalRetry.wrapRegistry(ctx.modelRegistry);
		const sessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI) retryStatuses.bindSession(sessionId, ctx.ui);
		const lineageSessionId = ctx.localProtocolOptions?.getSessionId?.() ?? undefined;
		const artifactsDir = ctx.sessionManager.getArtifactsDir() ?? undefined;
		const mode = restoreSessionPolicy(sessionPolicies, {
			sessionId,
			entries: ctx.sessionManager.getBranch(),
			routeEntries: ctx.sessionManager.getEntries(),
			hasUI: ctx.hasUI,
			lineageSessionId,
			artifactsDir,
		});
		updateStatus(ctx, mode, effectiveSharedRetryRecovery(mode, sessionId));
		updateAiInputRouteStatus(ctx, sessionAiInputRoutePolicy(sessionPolicies, sessionId));
	};
	const refreshWrappedModels = (ctx: SessionContextLike) => {
		universalRetry.wrapRegistry(ctx.modelRegistry);
		updateAiInputRouteStatus(ctx, sessionAiInputRoutePolicy(sessionPolicies, ctx.sessionManager.getSessionId()));
	};
	const streamOptions = (options: { sessionId?: string } | undefined) => {
		const mode = sessionPolicyMode(sessionPolicies, options?.sessionId);
		return {
			transientUpstream5xxMode: mode,
			retryTransientUpstream5xx: mode !== "fallback",
			sharedRetryRecovery: effectiveSharedRetryRecovery(mode, options?.sessionId),
			onProgress: retryStatuses.createReporter(options?.sessionId),
		};
	};
	const resolveAiInputApiKey = async (ctx: SessionContextLike): Promise<unknown> => {
		const model = ctx.modelRegistry.getAll().find(value => {
			if (!value || typeof value !== "object") return false;
			return (value as { provider?: unknown }).provider === AIINPUT_PROVIDER;
		});
		if (!model || !ctx.modelRegistry.resolver) return undefined;
		const credential = await Promise.resolve(
			ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId()),
		);
		return await resolveApiKeyOnce(
			credential as Parameters<typeof resolveApiKeyOnce>[0],
		);
	};

	pi.registerCommand("adaptive-5xx", {
		description: "List or select the retry, retry-stop, retry-5m, and fallback modes",
		handler: (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const currentMode = sessionPolicyMode(sessionPolicies, sessionId);
			const command = parseTransientUpstreamModeCommand(args, currentMode);
			if (!command) {
				ctx.ui.notify("Usage: /adaptive-5xx [status|list|retry|retry-stop|retry-5m|fallback|toggle]", "warning");
				return;
			}
			if (command === "list") {
				updateStatus(ctx, currentMode, effectiveSharedRetryRecovery(currentMode, sessionId));
				ctx.ui.notify(formatTransientUpstreamModeList(currentMode), "info");
				return;
			}
			if (command !== "status") {
				setSessionPolicy(sessionPolicies, sessionId, command);
				pi.appendEntry(ADAPTIVE_5XX_POLICY_ENTRY, { mode: command });
				if (modeForcesIsolatedRetry(command) && sessionSharedRetryRecovery(sessionPolicies, sessionId)) {
					setSessionSharedRetryRecovery(sessionPolicies, sessionId, false);
					pi.appendEntry(ADAPTIVE_SHARE_POLICY_ENTRY, { enabled: false });
					ctx.ui.notify(
						`${command} is request-local; shared retry was turned off for this session.`,
						"warning",
					);
				}
			}
			const mode = sessionPolicyMode(sessionPolicies, sessionId);
			const sharedRetryRecovery = effectiveSharedRetryRecovery(mode, sessionId);
			updateStatus(ctx, mode, sharedRetryRecovery);
			ctx.ui.notify(
				mode === "retry"
					? `Managed provider errors will use a ${sharedRetryRecovery ? "shared" : "local"} 50-retry budget, then enter OMP fallback.`
					: mode === "retry-stop"
						? "Managed provider errors will retry up to 50 times, then stop this turn without OMP fallback."
						: mode === "retry-5m"
							? "Generic 502/503/504/524 errors will retry on the current provider for up to 5 minutes, then enter OMP fallback. Press Esc to cancel."
							: "Generic 502/503/504/524 errors will immediately enter OMP fallback in this session.",
				"info",
			);
		},
	});
	pi.registerCommand("adaptive-share", {
		description: "Choose whether retry recovery state is shared across OMP sessions",
		handler: (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const mode = sessionPolicyMode(sessionPolicies, sessionId);
			const current = effectiveSharedRetryRecovery(mode, sessionId);
			const command = parseSharedRetryRecoveryCommand(args, current);
			if (command === undefined) {
				ctx.ui.notify("Usage: /adaptive-share [status|on|off|toggle]", "warning");
				return;
			}
			if (modeForcesIsolatedRetry(mode) && command === true) {
				ctx.ui.notify(
					`Shared retry cannot be enabled with ${mode}; choose /adaptive-5xx retry or fallback first.`,
					"warning",
				);
				return;
			}
			if (command !== "status") {
				setSessionSharedRetryRecovery(sessionPolicies, sessionId, command);
				pi.appendEntry(ADAPTIVE_SHARE_POLICY_ENTRY, { enabled: command });
			}
			const enabled = effectiveSharedRetryRecovery(mode, sessionId);
			updateStatus(ctx, mode, enabled);
			ctx.ui.notify(
				enabled
					? "Retry recovery will share queue state across OMP sessions."
					: "Retry recovery will use an isolated local retry budget.",
				"info",
			);
		},
	});
	pi.registerCommand("aiinput-route", {
		description: "Inspect, refresh, or pin AI Input routing for this session",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const command = parseAiInputRouteCommand(args);
			try {
				if (!command) {
					ctx.ui.notify("Usage: /aiinput-route [status|refresh|auto|pin <ai|eo|input> [duration]]", "warning");
					return;
				}
				if (command.action === "status") {
					const policy = sessionAiInputRoutePolicy(sessionPolicies, sessionId);
					updateAiInputRouteStatus(ctx as SessionContextLike, policy);
					ctx.ui.notify(await formatSessionAiInputRouteStatus(sessionId), "info");
					return;
				}
				if (command.action === "refresh") {
					const apiKey = await resolveAiInputApiKey(ctx as SessionContextLike);
					await aiInputRouter.selectEndpoint({ apiKey, forceRefresh: true });
					ctx.ui.notify(await formatSessionAiInputRouteStatus(sessionId), "info");
					return;
				}
				if (command.action === "auto") {
					const policy = { mode: "auto" } as const;
					setSessionAiInputRoutePolicy(sessionPolicies, sessionId, policy);
					pi.appendEntry(ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY, { ...policy, sessionId });
					updateAiInputRouteStatus(ctx as SessionContextLike, policy);
					ctx.ui.notify(
						`AI Input routing is automatic in this OMP session.\n${await formatSessionAiInputRouteStatus(sessionId)}`,
						"info",
					);
					return;
				}
				if (command.action === "pin") {
					const policy: SessionAiInputRoutePolicy = {
						mode: "pinned",
						endpointId: command.endpointId,
						...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
					};
					setSessionAiInputRoutePolicy(sessionPolicies, sessionId, policy);
					pi.appendEntry(ADAPTIVE_AIINPUT_ROUTE_POLICY_ENTRY, { ...policy, sessionId });
					updateAiInputRouteStatus(ctx as SessionContextLike, policy);
					const endpoint = resolveAiInputEndpoint(command.endpointId);
					if (endpoint) {
						await aiInputRouter.selectEndpoint({ pinnedBaseUrl: endpoint.baseUrl });
					}
					const duration = command.expiresAt === undefined ? "until changed" : "until its timer expires";
					ctx.ui.notify(
						`Pinned ${endpoint ? new URL(endpoint.baseUrl).hostname : command.endpointId} for this OMP session ${duration}.\n${await formatSessionAiInputRouteStatus(sessionId)}`,
						"info",
					);
					return;
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	const providerCommand = async (args: string, ctx: SessionContextLike): Promise<void> => {
		let command = parseProviderConfigCommand(args);
		if (command?.action === "list" && args.trim().length === 0 && ctx.hasUI && ctx.ui.select) {
			const inspected = await readProviderConfig();
			const providerChoice = await ctx.ui.select(
				"Provider to remove",
				inspected.providers.map(provider => ({
					label: provider.name,
					description: provider.models.length > 0
						? `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`
						: "no static models",
				})),
			);
			if (!providerChoice) return;
			const provider = inspected.providers.find(entry => entry.name === providerChoice);
			if (!provider) return;
			const actionChoice = await ctx.ui.select("Delete from provider", [
				{ label: "Delete one model", description: "Keep the provider and its other models" },
				{ label: "Delete entire provider", description: "Remove the provider block from models.yml" },
			]);
			if (!actionChoice) return;
			if (actionChoice === "Delete one model") {
				if (provider.models.length === 0) {
					ctx.ui.notify(`${provider.name} has no statically configured models.`, "warning");
					return;
				}
				const modelChoice = await ctx.ui.select(
					`Model in ${provider.name}`,
					provider.models.map(model => ({ label: model })),
				);
				if (!modelChoice) return;
				command = { action: "model", provider: provider.name, model: modelChoice, yes: false, force: false, dryRun: false };
			} else {
				command = { action: "provider", provider: provider.name, yes: false, force: false, dryRun: false };
			}
		}
		if (!command) {
			ctx.ui.notify(
				"Usage: /provider-remove [list|<provider>|<provider>/<model>] [--yes] [--force] [--dry-run]",
				"warning",
			);
			return;
		}
		try {
			const inspected = await readProviderConfig();
			if (command.action === "list") {
				const lines = inspected.providers.map(provider =>
					`${provider.name}${provider.models.length > 0 ? `: ${provider.models.join(", ")}` : " (no static models)"}`,
				);
				ctx.ui.notify(`Configured providers (${inspected.path}):\n${lines.join("\n")}`, "info");
				return;
			}
			const target = command.action === "provider"
				? command.provider
				: `${command.provider}/${command.model}`;
			const references = findProviderConfigReferences(inspected.text, {
				provider: command.provider,
				model: command.action === "model" ? command.model : undefined,
			});
			const scope = command.action === "provider" ? "entire provider" : "this model";
			let approved = command.yes;
			if (!command.dryRun && !command.yes) {
				if (!ctx.hasUI || typeof (ctx.ui as { confirm?: unknown }).confirm !== "function") {
					ctx.ui.notify(`Refusing to delete ${target} without --yes in a non-interactive session.`, "warning");
					return;
				}
				const confirmed = await (ctx.ui as { confirm(title: string, message: string): Promise<boolean> }).confirm(
					`Delete ${scope}?`,
					`${target}\nThis edits ${inspected.path} and creates a timestamped backup. Existing references are not changed${references.length > 0 ? ` (${references.length} found)` : ""}.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Deletion cancelled.", "info");
					return;
				}
				approved = true;
			}
			const result = await removeProviderConfig({
				kind: command.action,
				provider: command.provider,
				...(command.action === "model" ? { model: command.model } : {}),
				yes: approved,
				force: command.force,
				dryRun: command.dryRun,
			});
			const referenceNote = result.references.length > 0
				? `\nReferences remain and may need manual cleanup:\n${result.references.slice(0, 8).map(line => `- ${line}`).join("\n")}`
				: "";
			if (command.dryRun) {
				ctx.ui.notify(`Dry run: would remove ${result.removed} from ${result.path}.${referenceNote}`, "info");
				return;
			}
			ctx.ui.notify(
				`Removed ${result.removed}. Backup: ${result.backupPath}.\nRestart OMP or run /reload to refresh the model registry.${referenceNote}`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	pi.registerCommand("provider-remove", {
		description: "Safely remove a custom provider or one of its models from models.yml",
		handler: providerCommand,
	});
	pi.registerCommand("provider-delete", {
		description: "Alias for /provider-remove",
		handler: providerCommand,
	});
	pi.on("session_start", (_event, ctx) => prepareSession(ctx));
	pi.on("session_switch", (_event, ctx) => prepareSession(ctx));
	pi.on("session_branch", (_event, ctx) => prepareSession(ctx));
	pi.on("session_tree", (_event, ctx) => prepareSession(ctx));
	pi.on("model_select", (_event, ctx) => refreshWrappedModels(ctx));
	pi.on("before_provider_request", (_event, ctx) => refreshWrappedModels(ctx));
	pi.on("session_shutdown", () => aiInputRouter.stop());

	pi.registerProvider("adaptive-provider-queue", {
		api: ADAPTIVE_RETRY_API,
		streamSimple: (model, context, options) => {
			const requestApiKey = options?.apiKey as ApiKey | undefined;
			const aiInputCredential = model.provider === AIINPUT_PROVIDER
				? Promise.resolve().then(async () => {
					const resolvedKey = await resolveApiKeyOnce(requestApiKey, options?.signal);
					return {
						resolvedKey,
						downstreamKey: isApiKeyResolver(requestApiKey)
							? seedApiKeyResolver(resolvedKey, requestApiKey)
							: requestApiKey,
					};
				})
				: undefined;
			return createAdaptiveStream({
				model,
				requestOptions: options,
				queue,
				laneScope: model.provider === AIINPUT_PROVIDER ? "aiinput-account" : undefined,
				resolveLaneApiKey: aiInputCredential
					? async () => (await aiInputCredential).resolvedKey
					: undefined,
				maxRetries: 50,
				forwardQuotaToFallback: isQuotaFallbackProvider(model.provider),
				rotateEndpointOnError: error =>
					isAdaptiveTransientTransport(error) || isAdaptiveTransientUpstream(error),
				endpointPoolSize: model.provider === AIINPUT_PROVIDER ? AIINPUT_ENDPOINTS.length : undefined,
				...streamOptions(options),
				createOutputStream: () => createAssistantMessageEventStream(),
				createInputStream: async (attemptSignal, attempt) => {
					const restoredModel = modelForProviderRequest(universalRetry.restoreOriginalModel(model));
					const credential = await aiInputCredential;
					const routePolicy = providerRequestAiInputRoutePolicy(sessionPolicies, {
						sessionId: options?.sessionId,
						providerSessionState: options?.providerSessionState,
					});
					const pinnedEndpoint = routePolicy.mode === "pinned"
						? resolveAiInputEndpoint(routePolicy.endpointId)
						: undefined;
					const routed = await aiInputRouter.routeModel(restoredModel, {
						apiKey: credential?.resolvedKey,
						signal: attemptSignal,
						exclude: attempt?.excludeBaseUrls,
						pinnedBaseUrl: pinnedEndpoint?.baseUrl,
					});
					attempt?.setBaseUrl(routed.baseUrl);
					const upstreamOptions = modelRequestOptions(routed.model, options);
					return streamSimple(
						routed.model,
						context,
						{ ...upstreamOptions, apiKey: credential?.downstreamKey ?? requestApiKey, signal: attemptSignal, maxRetries: 0 },
					);
				},
				logger: pi.logger,
			});
		},
	});
}
