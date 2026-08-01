import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheDir = mkdtempSync(join(tmpdir(), "omp-plugin-pack-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

try {
	const result = spawnSync(
		npmCommand,
		["pack", "--dry-run", "--cache", cacheDir],
		{ stdio: "inherit" },
	);

	if (result.error) {
		throw result.error;
	}
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(cacheDir, { recursive: true, force: true });
}
