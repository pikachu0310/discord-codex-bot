import { assertEquals } from "std/assert/mod.ts";
import { estimateCostUsd } from "../src/worker/model-pricing.ts";

Deno.test("estimateCostUsd: gpt-5.5 の料金を計算できる", () => {
  const estimated = estimateCostUsd({
    inputTokens: 1000,
    cachedInputTokens: 400,
    processingTokens: 200,
    outputTokens: 300,
    model: "gpt-5.5",
  });

  assertEquals(estimated, {
    usd: 0.0182,
    model: "gpt-5.5",
  });
});

Deno.test("estimateCostUsd: gpt-5.1-codex の料金を計算できる", () => {
  const estimated = estimateCostUsd({
    inputTokens: 1000,
    cachedInputTokens: 400,
    processingTokens: 200,
    outputTokens: 300,
    model: "gpt-5.1-codex",
  });

  assertEquals(estimated, {
    usd: 0.0058,
    model: "gpt-5.1-codex",
  });
});

Deno.test("estimateCostUsd: 固定日のモデル名は個別単価を使う", () => {
  const estimated = estimateCostUsd({
    inputTokens: 1000,
    cachedInputTokens: 0,
    processingTokens: 0,
    outputTokens: 500,
    model: "gpt-4o-2024-05-13",
  });

  assertEquals(estimated, {
    usd: 0.0125,
    model: "gpt-4o-2024-05-13",
  });
});

Deno.test("estimateCostUsd: 日付付きモデル名はベースモデル単価を使う", () => {
  const estimated = estimateCostUsd({
    inputTokens: 1000,
    cachedInputTokens: 0,
    processingTokens: 0,
    outputTokens: 500,
    model: "gpt-4o-2024-08-06",
  });

  assertEquals(estimated, {
    usd: 0.0075,
    model: "gpt-4o",
  });
});

Deno.test("estimateCostUsd: 未知モデルは null", () => {
  const estimated = estimateCostUsd({
    inputTokens: 1,
    cachedInputTokens: 0,
    processingTokens: 0,
    outputTokens: 1,
    model: "unknown-model",
  });

  assertEquals(estimated, null);
});
