import { assertEquals } from "std/assert/mod.ts";
import { RateLimitManager } from "../src/admin/rate-limit-manager.ts";

Deno.test("RateLimitManager: status summary に残量%を含む", () => {
  const manager = new RateLimitManager(false, { tokenBase: 1000 });
  manager.trackTokenUsage(100, 100, "k1");

  const summary = manager.getStatusSummary();
  assertEquals(summary.windows[0].label, "24h");
  assertEquals(summary.windows[0].remainingPercentage, 80);
});

Deno.test("RateLimitManager: レート制限メッセージは即時エラー方針", () => {
  const manager = new RateLimitManager();
  assertEquals(
    manager.createRateLimitMessage(),
    "Codexのレート制限に達しました。時間を置いて再実行してください。",
  );
});
