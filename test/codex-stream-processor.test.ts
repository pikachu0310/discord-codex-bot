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
  assertEquals(parsed.text, undefined);
});

Deno.test("CodexStreamProcessor: reasoning summaryはDiscordへ送信しない", () => {
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

  assertEquals(parsed.text, undefined);
  assertEquals(parsed.finalText, undefined);
});

Deno.test("CodexStreamProcessor: compact開始イベントを進捗テキストとして抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "context.compaction.started",
    trigger: "auto",
  }));

  assertEquals(parsed.text, "コンテキスト圧縮を開始しました。");
  assertEquals(parsed.finalText, undefined);
});

Deno.test("CodexStreamProcessor: compact完了イベントを進捗テキストとして抽出できる", () => {
  const processor = new CodexStreamProcessor();
  const parsed = processor.parseLine(JSON.stringify({
    type: "item.completed",
    item: {
      type: "compaction",
      status: "completed",
    },
  }));

  assertEquals(parsed.text, "コンテキスト圧縮が完了しました。");
  assertEquals(parsed.finalText, undefined);
});

Deno.test("CodexStreamProcessor: ツール出力と未知のイベントを返信へ混ぜない", () => {
  const processor = new CodexStreamProcessor();
  for (
    const packet of [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          stdout: "private log",
          stderr: "private error",
        },
      },
      {
        type: "item.completed",
        item: { type: "mcp_tool_call", content: [{ text: "tool result" }] },
      },
      {
        method: "item/completed",
        params: {
          item: { type: "commandExecution", aggregatedOutput: "raw RPC" },
        },
      },
      { type: "unknown", item: { text: "unknown output" } },
    ]
  ) {
    const parsed = processor.parseLine(JSON.stringify(packet));
    assertEquals(parsed.text, undefined);
    assertEquals(parsed.finalText, undefined);
  }
  assertEquals(processor.parseLine("raw subprocess log").text, undefined);
  const progress = processor.parseLine(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", phase: "commentary", text: "進めています" },
  }));
  assertEquals(progress.text, "進めています");
  assertEquals(progress.finalText, undefined);
  const final = processor.parseLine(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      phase: "final_answer",
      text: "完了しました",
    },
  }));
  assertEquals(final.text, undefined);
  assertEquals(final.finalText, "完了しました");
});
