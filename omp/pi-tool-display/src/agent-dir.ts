import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PI_AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";
const OMP_CONFIG_DIR_ENV_VAR = "PI_CONFIG_DIR";
const OMP_PROFILE_ENV_VARS = ["OMP_PROFILE", "PI_PROFILE"] as const;
const DEFAULT_OMP_CONFIG_DIR = ".omp";

interface AgentDirEnvironment {
	[name: string]: string | undefined;
}

function expandHomeDirectory(configuredDir: string, homeDirectory: string): string {
	if (configuredDir === "~") {
		return homeDirectory;
	}

	if (configuredDir.startsWith("~/") || configuredDir.startsWith("~\\")) {
		return join(homeDirectory, configuredDir.slice(2));
	}

	return configuredDir;
}

function resolveConfiguredAgentDir(configuredDir: string, homeDirectory: string): string {
	const expanded = expandHomeDirectory(configuredDir, homeDirectory);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function getProfile(env: AgentDirEnvironment): string | undefined {
	for (const variable of OMP_PROFILE_ENV_VARS) {
		const value = env[variable]?.trim();
		if (value && value !== "default") {
			return value;
		}
	}
	return undefined;
}

/** Resolve the active OMP agent directory without importing the host runtime. */
export function resolvePiAgentDir(
	env: AgentDirEnvironment = process.env,
	homeDirectory = homedir(),
): string {
	const explicitAgentDir = env[PI_AGENT_DIR_ENV_VAR]?.trim();
	if (explicitAgentDir) {
		return resolveConfiguredAgentDir(explicitAgentDir, homeDirectory);
	}

	const configDir = env[OMP_CONFIG_DIR_ENV_VAR]?.trim() || DEFAULT_OMP_CONFIG_DIR;
	const configRoot = join(homeDirectory, configDir);
	const profile = getProfile(env);
	return profile
		? join(configRoot, "profiles", profile, "agent")
		: join(configRoot, "agent");
}
