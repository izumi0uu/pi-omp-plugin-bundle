export const ADAPTIVE_5XX_POLICY_ENTRY = "adaptive-provider-queue:5xx-policy";
export const DEFAULT_TRANSIENT_UPSTREAM_MODE = "retry" as const;

export type TransientUpstreamMode = "retry" | "fallback";

interface SessionEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function modeFromData(data: unknown): TransientUpstreamMode | undefined {
	if (!data || typeof data !== "object") return undefined;
	const mode = (data as Record<string, unknown>).mode;
	return mode === "retry" || mode === "fallback" ? mode : undefined;
}

export function transientUpstreamModeFromEntries(entries: readonly unknown[]): TransientUpstreamMode {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as SessionEntryLike | undefined;
		if (entry?.type !== "custom" || entry.customType !== ADAPTIVE_5XX_POLICY_ENTRY) continue;
		const mode = modeFromData(entry.data);
		if (mode) return mode;
	}
	return DEFAULT_TRANSIENT_UPSTREAM_MODE;
}

export function parseTransientUpstreamModeCommand(
	args: string,
	current: TransientUpstreamMode,
): TransientUpstreamMode | "status" | undefined {
	const action = args.trim().toLowerCase();
	if (!action || action === "status") return "status";
	if (action === "retry" || action === "fallback") return action;
	if (action === "toggle") return current === "retry" ? "fallback" : "retry";
	return undefined;
}
