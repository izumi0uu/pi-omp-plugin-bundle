import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("credential migration supports anchored domestic providers and overseas aliases", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-credential-migration-test-"));
	tempDirs.push(dir);
	const modelsPath = path.join(dir, "models.yml");
	const envPath = path.join(dir, ".env");
	await fs.writeFile(
		modelsPath,
		`providers:
  aiinput: &aiinput1
    apiKey: account-one-key-1234567890
  aiinput-overseas:
    <<: *aiinput1
    baseUrl: https://input.codes/v1
  aiinput2: &aiinput2
    apiKey: account-two-key-1234567890
  aiinput2-overseas:
    <<: *aiinput2
    baseUrl: https://input.codes/v1
  tokenking-grok:
    apiKey: grok-account-key-1234567890
`,
	);
	await fs.writeFile(envPath, "TOKENKING_API_KEY=unchanged-key-1234567890\n");

	execFileSync("ruby", [
		path.resolve("scripts/migrate-credentials.rb"),
		modelsPath,
		envPath,
	]);

	const models = await fs.readFile(modelsPath, "utf8");
	const env = await fs.readFile(envPath, "utf8");
	assert.match(models, /aiinput: &aiinput1\n    apiKey: AIINPUT_API_KEY/);
	assert.match(models, /aiinput2: &aiinput2\n    apiKey: AIINPUT2_API_KEY/);
	assert.match(models, /tokenking-grok:\n    apiKey: TOKENKING_GROK_API_KEY/);
	assert.match(env, /^AIINPUT_API_KEY=account-one-key-1234567890$/m);
	assert.match(env, /^AIINPUT2_API_KEY=account-two-key-1234567890$/m);
	assert.match(env, /^TOKENKING_GROK_API_KEY=grok-account-key-1234567890$/m);
	assert.match(env, /^TOKENKING_API_KEY=unchanged-key-1234567890$/m);
	assert.equal((await fs.stat(modelsPath)).mode & 0o777, 0o600);
	assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600);
});
