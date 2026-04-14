import { assertEquals } from "std/assert/mod.ts";
import {
  CodexStreamProcessor,
  extractRateLimitTimestamp,
} from "../src/worker/codex-stream-processor.ts";

Deno.test("CodexStreamProcessor: usageを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "turn.completed",
    session_id: "s1",
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 25,
      output_tokens: 10,
    },
  }));

  assertEquals(parsed.sessionId, "s1");
  assertEquals(parsed.usage?.inputTokens, 175);
  assertEquals(parsed.usage?.outputTokens, 10);
  assertEquals(parsed.usage?.dedupeKey, "s1:turn.completed");
});

Deno.test("CodexStreamProcessor: レート制限時刻を抽出できる", () => {
  const ts = extractRateLimitTimestamp(
    "Codex AI usage limit reached|1710000000",
  );
  assertEquals(ts, 1710000000);
});
