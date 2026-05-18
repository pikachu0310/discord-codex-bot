import { assertEquals } from "std/assert/mod.ts";
import {
  CodexStreamProcessor,
  extractRateLimitTimestamp,
} from "../src/worker/codex-stream-processor.ts";

Deno.test("CodexStreamProcessor: セッションIDを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "turn.completed",
    session_id: "s1",
  }));

  assertEquals(parsed.sessionId, "s1");
});

Deno.test("CodexStreamProcessor: thread_idをセッションIDとして抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "thread.started",
    thread_id: "019dd88b-3a4d-7233-b59a-386b0710fadd",
  }));

  assertEquals(parsed.sessionId, "019dd88b-3a4d-7233-b59a-386b0710fadd");
});

Deno.test("CodexStreamProcessor: レート制限時刻を抽出できる", () => {
  const ts = extractRateLimitTimestamp(
    "Codex AI usage limit reached|1710000000",
  );
  assertEquals(ts, 1710000000);
});

Deno.test("CodexStreamProcessor: resultイベントから最終テキストを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "最終返信です。",
  }));

  assertEquals(parsed.finalText, "最終返信です。");
});

Deno.test("CodexStreamProcessor: assistant end_turnから最終テキストを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "ユーザーに見せる返信です。",
        },
      ],
    },
  }));

  assertEquals(parsed.finalText, "ユーザーに見せる返信です。");
  assertEquals(parsed.text, undefined);
});

Deno.test("CodexStreamProcessor: item.completed agent_messageから最終テキストを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: "OK",
    },
  }));

  assertEquals(parsed.finalText, "OK");
  assertEquals(parsed.text, "OK");
});

Deno.test("CodexStreamProcessor: reasoning summaryを進捗テキストとして抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "実装方針を確認しています。",
        },
      ],
    },
  }));

  assertEquals(parsed.text, "実装方針を確認しています。");
  assertEquals(parsed.finalText, undefined);
});

Deno.test("CodexStreamProcessor: turn.completedのusageを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 120,
      reasoning_tokens: 30,
      output_tokens: 45,
      total_tokens: 195,
      cost_usd: 0.00123,
    },
  }));

  assertEquals(parsed.usage, {
    inputTokens: 120,
    cachedInputTokens: 0,
    processingTokens: 30,
    outputTokens: 45,
    totalTokens: 195,
    costUsd: 0.00123,
    model: undefined,
  });
});

Deno.test("CodexStreamProcessor: 文字列/ネスト形式のcostを抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "turn.completed",
    response: {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cost: {
          usd: "$0.012345 USD",
        },
      },
    },
  }));

  assertEquals(parsed.usage, {
    inputTokens: 10,
    cachedInputTokens: 0,
    processingTokens: 0,
    outputTokens: 5,
    totalTokens: undefined,
    costUsd: 0.012345,
    model: undefined,
  });
});

Deno.test("CodexStreamProcessor: model と cached_input_tokens を抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "turn.completed",
    response: {
      model: "gpt-5.1-codex",
      usage: {
        input_tokens: 200,
        cached_input_tokens: 80,
        output_tokens: 40,
      },
    },
  }));

  assertEquals(parsed.usage, {
    inputTokens: 200,
    cachedInputTokens: 80,
    processingTokens: 0,
    outputTokens: 40,
    totalTokens: undefined,
    costUsd: undefined,
    model: "gpt-5.1-codex",
  });
});
