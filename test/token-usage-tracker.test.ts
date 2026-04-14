import { assertEquals } from "std/assert/mod.ts";
import { TokenUsageTracker } from "../src/token-usage-tracker.ts";

Deno.test("TokenUsageTracker: 残量%を正しく計算する", () => {
  const tracker = new TokenUsageTracker({
    tokenBase: 100000,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 0),
  });

  tracker.addTokenUsage(20000, 10000);
  const info = tracker.getUsageInfo();

  assertEquals(info.currentUsage, 30000);
  assertEquals(info.usagePercentage, 30);
  assertEquals(info.remainingPercentage, 70);
});

Deno.test("TokenUsageTracker: dedupeKeyで重複加算しない", () => {
  const tracker = new TokenUsageTracker({
    tokenBase: 100000,
    now: () => Date.UTC(2026, 0, 1, 0, 0, 0),
  });

  const first = tracker.addTokenUsage(10, 20, "k1");
  const second = tracker.addTokenUsage(10, 20, "k1");

  assertEquals(first, true);
  assertEquals(second, false);
  assertEquals(tracker.getCurrentUsage(), 30);
});
