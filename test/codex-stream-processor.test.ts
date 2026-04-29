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
