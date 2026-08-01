import * as fs from "node:fs/promises";
import { AdaptiveProviderQueue, sleepWithSignal } from "../src/queue.ts";

const [rootDir, laneId, auditPath, holdMsText] = process.argv.slice(2);
if (!rootDir || !laneId || !auditPath || !holdMsText) {
	throw new Error("usage: queue-child.ts ROOT LANE AUDIT HOLD_MS");
}

const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 5_000, random: () => 0 });
const ticket = await queue.acquire(laneId);
try {
	await queue.waitForTurn(ticket);
	await fs.appendFile(auditPath, `start\t${ticket.fileName}\t${Date.now()}\n`);
	await sleepWithSignal(Number(holdMsText));
	await fs.appendFile(auditPath, `end\t${ticket.fileName}\t${Date.now()}\n`);
} finally {
	await queue.release(ticket);
}
