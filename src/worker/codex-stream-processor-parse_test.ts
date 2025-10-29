import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.218.0/assert/mod.ts";
import {
  CodexStreamProcessor,
  JsonParseError,
} from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";

Deno.test("CodexStreamProcessor parseJsonLine - 正常なassistantメッセージをパース", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const validJson = JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "codex-3-opus",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
    },
    session_id: "session_123",
  });

  const result = processor.parseJsonLine(validJson);
  assertEquals(result.type, "assistant");
  assertEquals(result.session_id, "session_123");
});

Deno.test("CodexStreamProcessor parseJsonLine - 正常なresultメッセージをパース", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const validJson = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Task completed",
    session_id: "session_123",
    cost_usd: 0.05,
    duration_ms: 1000,
  });

  const result = processor.parseJsonLine(validJson);
  assertEquals(result.type, "result");
  if (result.type === "result" && result.subtype === "success") {
    assertEquals(result.subtype, "success");
    assertEquals(result.result, "Task completed");
  }
});

Deno.test("CodexStreamProcessor parseJsonLine - 正常なsystemメッセージをパース", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const validJson = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "session_123",
    tools: ["Read", "Write", "Edit"],
    mcp_servers: [{ name: "server1", status: "connected" }],
  });

  const result = processor.parseJsonLine(validJson);
  assertEquals(result.type, "system");
  if (result.type === "system") {
    assertEquals(result.subtype, "init");
  }
});

Deno.test("CodexStreamProcessor parseJsonLine - 空文字列でJsonParseErrorをスロー", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  assertThrows(
    () => processor.parseJsonLine(""),
    JsonParseError,
    "Failed to parse JSON",
  );
});

Deno.test("CodexStreamProcessor parseJsonLine - 無効なJSONでJsonParseErrorをスロー", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  assertThrows(
    () => processor.parseJsonLine("not json"),
    JsonParseError,
    "Failed to parse JSON",
  );

  assertThrows(
    () => processor.parseJsonLine("{invalid json}"),
    JsonParseError,
    "Failed to parse JSON",
  );
});
