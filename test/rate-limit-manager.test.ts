import { assertEquals } from "std/assert/mod.ts";
import { RateLimitManager } from "../src/admin/rate-limit-manager.ts";

Deno.test("RateLimitManager: レート制限メッセージは即時エラー方針", () => {
  const manager = new RateLimitManager();
  assertEquals(
    manager.createRateLimitMessage(),
    "Codexのレート制限に達しました。時間を置いて再実行してください。",
  );
});
