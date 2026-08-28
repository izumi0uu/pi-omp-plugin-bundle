import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type ProviderConfigEntry = {
	name: string;
	models: string[];
	startLine: number;
	endLine: number;
};

export type ProviderConfigInspection = {
	path: string;
	text: string;
	providers: ProviderConfigEntry[];
	references: string[];
};

export type ProviderConfigRemoval = {
	kind: "provider" | "model";
	provider: string;
	model?: string;
	yes?: boolean;
	force?: boolean;
	dryRun?: boolean;
};

export type ProviderConfigCommand =
	| { action: "list" }
	| { action: "provider"; provider: string; yes: boolean; force: boolean; dryRun: boolean }
	| { action: "model"; provider: string; model: string; yes: boolean; force: boolean; dryRun: boolean };

export type ProviderConfigRemovalResult = {
	path: string;
	backupPath?: string;
	removed: string;
	remainingModels: string[];
	references: string[];
	changed: boolean;
};

function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured.replace(/^~(?=$|\/)/, os.homedir());
	return path.join(os.homedir(), ".omp", "agent");
}

export function parseProviderConfigCommand(args: string): ProviderConfigCommand | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || /^(list|ls|status)$/i.test(tokens[0])) return { action: "list" };
	const action = /^(provider|p)$/i.test(tokens[0]) ? "provider" : /^(model|m)$/i.test(tokens[0]) ? "model" : undefined;
	if (!action) {
		const target = tokens[0];
		const separator = target.indexOf("/");
		if (separator > 0 && separator < target.length - 1) {
			const flags = tokens.slice(1).map(token => token.toLowerCase());
			return { action: "model", provider: target.slice(0, separator), model: target.slice(separator + 1), yes: flags.includes("--yes") || flags.includes("-y"), force: flags.includes("--force"), dryRun: flags.includes("--dry-run") || flags.includes("--check") };
		}
		const flags = tokens.slice(1).map(token => token.toLowerCase());
		return { action: "provider", provider: target, yes: flags.includes("--yes") || flags.includes("-y"), force: flags.includes("--force"), dryRun: flags.includes("--dry-run") || flags.includes("--check") };
	}
	const target = tokens[1];
	if (!target) return undefined;
	const separator = target.indexOf("/");
	const provider = action === "model" && separator > 0 ? target.slice(0, separator) : target;
	const model = action === "model" ? (separator > 0 ? target.slice(separator + 1) : tokens[2]) : undefined;
	if (!provider || (action === "model" && !model)) return undefined;
	const flags = tokens.slice(action === "model" && separator <= 0 ? 3 : 2).map(token => token.toLowerCase());
	return {
		action,
		provider,
		...(action === "model" ? { model: model as string } : {}),
		yes: flags.includes("--yes") || flags.includes("-y"),
		force: flags.includes("--force"),
		dryRun: flags.includes("--dry-run") || flags.includes("--check"),
	};
}

export function modelsPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(agentDir(env), "models.yml");
}

function providerKey(line: string): string | undefined {
	const match = /^  ([^\s#][^:]*):(?:\s|#|$)/.exec(line);
	return match?.[1];
}

function modelId(line: string): string | undefined {
	const match = /^      - id:\s*(\S+)\s*$/.exec(line);
	if (!match) return undefined;
	return match[1].replace(/^['"]|['"]$/g, "");
}

function yamlScalar(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inspectProviderConfig(text: string, configPath = "models.yml"): ProviderConfigInspection {
	const lines = text.split(/\r?\n/);
	const providersIndex = lines.findIndex(line => /^providers:\s*$/.test(line));
	if (providersIndex < 0) throw new Error(`No providers section found in ${configPath}`);

	const entries: ProviderConfigEntry[] = [];
	let current: ProviderConfigEntry | undefined;
	for (let index = providersIndex + 1; index < lines.length; index += 1) {
		const key = providerKey(lines[index]);
		if (key) {
			if (current) current.endLine = index;
			current = { name: key, models: [], startLine: index, endLine: lines.length };
			entries.push(current);
			continue;
		}
		if (current) {
			const id = modelId(lines[index]);
			if (id) current.models.push(id);
		}
	}

	return { path: configPath, text, providers: entries, references: [] };
}

export function findProviderConfigReferences(
	text: string,
	target: { provider: string; model?: string },
): string[] {
	const provider = yamlScalar(target.provider);
	const model = target.model === undefined ? undefined : yamlScalar(target.model);
	const providerPattern = new RegExp(`(?:^|[\\s'\"-])${provider}(?:/|\\*)`, "i");
	const modelPattern = model === undefined
		? undefined
		: new RegExp(`(?:^|[\\s'\"-])${provider}/${model}(?=$|[\\s:'\"#])`, "i");
	return text
		.split(/\r?\n/)
		.filter(line => (modelPattern ? modelPattern.test(line) : providerPattern.test(line)))
		.map(line => line.trim())
		.filter(Boolean);
}

function removeLines(text: string, start: number, end: number): string {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const trailing = text.endsWith("\n") || text.endsWith("\r");
	const lines = text.split(/\r?\n/);
	lines.splice(start, end - start);
	let output = lines.join(newline);
	if (trailing && !output.endsWith(newline)) output += newline;
	return output;
}

function timestamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function uniqueBackupPath(filePath: string): Promise<string> {
	const base = `${filePath}.bak-remove-${timestamp()}`;
	for (let index = 0; index < 100; index += 1) {
		const candidate = index === 0 ? base : `${base}-${index}`;
		try {
			await fs.access(candidate);
		} catch {
			return candidate;
		}
	}
	throw new Error(`Could not allocate a backup path for ${filePath}`);
}

async function writeAtomically(filePath: string, text: string): Promise<void> {
	const temporary = `${filePath}.tmp-remove-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await fs.rename(temporary, filePath);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export async function removeProviderConfig(
	request: ProviderConfigRemoval,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderConfigRemovalResult> {
	if (!request.dryRun && !request.yes) throw new Error("Deletion requires explicit confirmation (--yes or interactive confirmation)");
	if (!request.provider || /[\r\n/]/.test(request.provider)) throw new Error("Invalid provider name");
	if (request.model !== undefined && (!request.model || /[\r\n/]/.test(request.model))) {
		throw new Error("Invalid model name");
	}
	const filePath = modelsPath(env);
	const text = await fs.readFile(filePath, "utf8");
	const inspected = inspectProviderConfig(text, filePath);
	const provider = inspected.providers.find(entry => entry.name === request.provider);
	if (!provider) throw new Error(`Provider not found: ${request.provider}`);

	let nextText: string;
	let removed: string;
	let remainingModels: string[];
	if (request.kind === "provider") {
		const refs = findProviderConfigReferences(text, { provider: request.provider });
		const settingsPath = path.join(agentDir(env), "config.yml");
		try {
			const settings = await fs.readFile(settingsPath, "utf8");
			refs.push(...findProviderConfigReferences(settings, { provider: request.provider }).map(line => `config.yml: ${line}`));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (refs.length > 0 && !request.force) {
			throw new Error(`Provider ${request.provider} is referenced by config/roles/fallbacks. Use --force after reviewing them.`);
		}
		nextText = removeLines(text, provider.startLine, provider.endLine);
		removed = request.provider;
		remainingModels = [];
	} else {
		if (request.model === undefined) throw new Error("Model removal requires provider/model");
		const lines = text.split(/\r?\n/);
		const modelStart = lines.findIndex((line, index) => index >= provider.startLine && index < provider.endLine && modelId(line) === request.model);
		if (modelStart < 0) throw new Error(`Model not found: ${request.provider}/${request.model}`);
		let modelEnd = modelStart + 1;
		while (modelEnd < provider.endLine && !modelId(lines[modelEnd])) modelEnd += 1;
		nextText = removeLines(text, modelStart, modelEnd);
		removed = `${request.provider}/${request.model}`;
		remainingModels = provider.models.filter(id => id !== request.model);
	}

	const references = findProviderConfigReferences(text, {
		provider: request.provider,
		model: request.kind === "model" ? request.model : undefined,
	});
	if (request.kind === "model") {
		const settingsPath = path.join(agentDir(env), "config.yml");
		try {
			const settings = await fs.readFile(settingsPath, "utf8");
			references.push(...findProviderConfigReferences(settings, { provider: request.provider, model: request.model }).map(line => `config.yml: ${line}`));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	if (request.dryRun) {
		return { path: filePath, removed, remainingModels, references, changed: nextText !== text };
	}
	const backupPath = await uniqueBackupPath(filePath);
	await fs.copyFile(filePath, backupPath);
	await fs.chmod(backupPath, 0o600);
	await writeAtomically(filePath, nextText);
	return { path: filePath, backupPath, removed, remainingModels, references, changed: nextText !== text };
}

export async function readProviderConfig(env: NodeJS.ProcessEnv = process.env): Promise<ProviderConfigInspection> {
	const filePath = modelsPath(env);
	const text = await fs.readFile(filePath, "utf8");
	const inspected = inspectProviderConfig(text, filePath);
	return { ...inspected, references: [] };
}
