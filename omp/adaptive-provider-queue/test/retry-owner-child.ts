import { AdaptiveProviderQueue } from "../src/queue.ts";

const [rootDir, laneId] = process.argv.slice(2);
if (!rootDir || !laneId) throw new Error("usage: retry-owner-child.ts ROOT LANE");

const queue = new AdaptiveProviderQueue({ rootDir, pollMs: 10, staleMs: 5_000, baseDelayMs: 0, maxDelayMs: 0 });
const ticket = await queue.acquire(laneId);
await queue.waitForTurn(ticket);
await queue.recordRetryFailure(ticket, { maxRetries: 50, kind: "rate-limit" });

// Deliberately exit without releasing so the next process must remove the dead
// ticket and claim the persisted recovery campaign.
process.exit(0);
