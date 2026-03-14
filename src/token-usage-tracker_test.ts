import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import { TokenUsageTracker } from "./token-usage-tracker.ts";

Deno.test("TokenUsageTracker - 基本的なトークン追跡", () => {
  const tracker = new TokenUsageTracker();

  // 初期状態
  assertEquals(tracker.getCurrentUsage(), 0);
  assertEquals(tracker.getUsagePercentage(), 0);

  // トークン使用量を追加
  tracker.addTokenUsage(1000, 2000);
  assertEquals(tracker.getCurrentUsage(), 3000);
  assertEquals(tracker.getUsagePercentage(), 3); // 3000/100000 * 100 = 3%

  // さらに追加
  tracker.addTokenUsage(5000, 10000);
  assertEquals(tracker.getCurrentUsage(), 18000);
  assertEquals(tracker.getUsagePercentage(), 18); // 18000/100000 * 100 = 18%
});

Deno.test("TokenUsageTracker - ステータス文字列生成", () => {
  const tracker = new TokenUsageTracker({
    fiveHourLimit: 100000,
    weeklyLimit: 500000,
  });

  // トークン使用量を追加
  tracker.addTokenUsage(25000, 25000);

  const statusString = tracker.getStatusString();

  // 50000/100000 (50%) の形式で表示されることを確認
  assertEquals(statusString.includes("50000/100000"), true);
  assertEquals(statusString.includes("(50%)"), true);
  assertEquals(statusString.includes("5h:"), true);
  assertEquals(statusString.includes("1w:"), true);
  assertEquals(statusString.includes("次回リセット:"), true);
});

Deno.test("TokenUsageTracker - 使用量情報取得", () => {
  const tracker = new TokenUsageTracker();

  // トークン使用量を追加
  tracker.addTokenUsage(30000, 20000);

  const info = tracker.getUsageInfo();

  assertEquals(info.currentUsage, 50000);
  assertEquals(info.maxTokens, 100000);
  assertEquals(info.usagePercentage, 50);

  // 次回リセット時刻が設定されていることを確認
  assertEquals(info.nextResetTime instanceof Date, true);
  assertEquals(typeof info.nextResetTimeUTC, "string");
  assertEquals(info.nextResetTimeUTC.includes(":"), true); // 時刻フォーマット確認
});

Deno.test("TokenUsageTracker - リセット機能", () => {
  const tracker = new TokenUsageTracker();

  // トークン使用量を追加
  tracker.addTokenUsage(40000, 30000);
  assertEquals(tracker.getCurrentUsage(), 70000);

  // リセット
  tracker.reset();
  assertEquals(tracker.getCurrentUsage(), 0);
  assertEquals(tracker.getUsagePercentage(), 0);
});

Deno.test("TokenUsageTracker - 時間窓ごとの使用率計算", () => {
  let current = Date.parse("2025-01-01T00:00:00Z");
  const tracker = new TokenUsageTracker({
    fiveHourLimit: 1000,
    weeklyLimit: 10000,
    now: () => current,
  });

  tracker.addTokenUsage(100, 0); // t = 0h
  current += 2 * 60 * 60 * 1000;
  tracker.addTokenUsage(200, 0); // t = 2h
  current += 4 * 60 * 60 * 1000;
  tracker.addTokenUsage(300, 0); // t = 6h

  const status = tracker.getStatusString();
  assertEquals(status.includes("5h:50%"), true);
  assertEquals(status.includes("1w:6%"), true);
});
