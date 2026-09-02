import { Text, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import {
	findLatestCopyTurn,
	findLatestCopyTurnInEntries,
	type CopyTurn,
	type MessageLike,
	type SessionEntryLike,
} from "./copy-turn.ts";

const WIDGET_KEY = "omp-copy-turn";
const SHORTCUTS = ["ctrl+x", "f6"] as const;

export default function copyTurnExtension(pi: ExtensionAPI): void {
	let latest: CopyTurn | undefined;
	const restoreLatest = (ctx: ExtensionContext): void => {
		latest = findLatestCopyTurnInEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
	};

	const updateWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (!latest) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) =>
				new Text(
					`${theme.fg("accent", "[复制本轮问答]")} ${theme.fg("dim", "Ctrl+X · F6 · /copy-turn")}`,
					0,
					0,
				),
			{ placement: "aboveEditor" },
		);
	};

	const copyLatest = async (ctx: ExtensionContext): Promise<void> => {
		if (!latest) restoreLatest(ctx);
		if (!latest) {
			ctx.ui.notify("当前还没有已完成、可复制的问答。", "warning");
			return;
		}
		await copyToClipboard(latest.markdown);
		ctx.ui.notify("已复制最近一轮问题和回答。", "info");
	};

	const restoreAndRender = (ctx: ExtensionContext): void => {
		restoreLatest(ctx);
		updateWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => restoreAndRender(ctx));
	pi.on("session_switch", async (_event, ctx) => restoreAndRender(ctx));
	pi.on("session_branch", async (_event, ctx) => restoreAndRender(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		latest = findLatestCopyTurn(event.messages as MessageLike[]);
		updateWidget(ctx);
	});

	for (const shortcut of SHORTCUTS) {
		pi.registerShortcut(shortcut, {
			description: "Copy the latest user question and final assistant answer",
			handler: copyLatest,
		});
	}

	pi.registerCommand("copy-turn", {
		description: "Copy the latest user question and final assistant answer",
		handler: async (_args, ctx) => copyLatest(ctx),
	});
}
