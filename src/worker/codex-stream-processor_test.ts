import { assertEquals } from "https://deno.land/std@0.211.0/assert/mod.ts";
import {
  CodexCodeRateLimitError,
  CodexExecJsonEvent,
  CodexStreamMessage,
  CodexStreamProcessor,
} from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";

Deno.test("CodexStreamProcessor - extractOutputMessage - assistantメッセージ", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const message = {
    type: "assistant" as const,
    message: {
      id: "msg-123",
      type: "message",
      role: "assistant",
      model: "codex",
      content: [
        { type: "text", text: "これはテストです", citations: null },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: null,
        service_tier: "standard",
      },
    },
    session_id: "session-123",
  } satisfies CodexStreamMessage;

  const result = processor.extractOutputMessage(message);
  assertEquals(result, "これはテストです");
});

Deno.test("CodexStreamProcessor - extractOutputMessage - tool_useメッセージ", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const message = {
    type: "assistant" as const,
    message: {
      id: "msg-123",
      type: "message",
      role: "assistant",
      model: "codex",
      content: [
        {
          type: "tool_use",
          id: "tool-123",
          name: "Bash",
          input: { command: "ls", description: "ファイル一覧" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: null,
        service_tier: "standard",
      },
    },
    session_id: "session-123",
  } satisfies CodexStreamMessage;

  const result = processor.extractOutputMessage(message);
  assertEquals(
    result,
    "⚡ **Bash**: ファイル一覧\n```bash\nls\n```",
  );
});

Deno.test("CodexStreamProcessor - extractOutputMessage - resultメッセージは無視", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const message = {
    type: "result" as const,
    subtype: "success" as const,
    is_error: false,
    result: "最終結果",
    session_id: "session-123",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    total_cost_usd: 0,
  } satisfies CodexStreamMessage;

  const result = processor.extractOutputMessage(message);
  assertEquals(result, null);
});

Deno.test("CodexStreamProcessor - extractOutputMessage - systemメッセージ", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const message = {
    type: "system" as const,
    subtype: "init" as const,
    apiKeySource: "default" as const,
    session_id: "session-123",
    cwd: "/workspace",
    tools: ["Bash", "Read", "Write"],
    mcp_servers: [
      { name: "server1", status: "active" },
    ],
    model: "codex",
    permissionMode: "default",
  } satisfies CodexStreamMessage;

  const result = processor.extractOutputMessage(message);
  assertEquals(
    result,
    "🔧 **システム初期化:** ツール: Bash, Read, Write, MCPサーバー: server1(active)",
  );
});

Deno.test("CodexStreamProcessor - processStreams - 基本的なストリーム処理", async () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // テスト用のストリームを作成
  const testData = new TextEncoder().encode("テストデータ");
  const stdout = new ReadableStream({
    start(controller) {
      controller.enqueue(testData);
      controller.close();
    },
  });

  const stderr = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  let receivedData: Uint8Array | null = null;
  const onData = (data: Uint8Array) => {
    receivedData = data;
  };

  const result = await processor.processStreams(stdout, stderr, onData);

  assertEquals(receivedData, testData);
  assertEquals(result.length, 0); // stderrは空
});

Deno.test("CodexStreamProcessor - processStreams - stderrの処理", async () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const stdout = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  const errorData = new TextEncoder().encode("エラーメッセージ");
  const stderr = new ReadableStream({
    start(controller) {
      controller.enqueue(errorData);
      controller.close();
    },
  });

  const onData = () => {};

  const result = await processor.processStreams(stdout, stderr, onData);

  assertEquals(result, errorData);
});

Deno.test("CodexCodeRateLimitError - エラー作成", () => {
  const timestamp = Date.now();
  const error = new CodexCodeRateLimitError(timestamp);

  assertEquals(error.name, "CodexCodeRateLimitError");
  assertEquals(error.timestamp, timestamp);
  assertEquals(error.message, `Codex AI usage limit reached|${timestamp}`);
});

Deno.test("CodexStreamProcessor - command_output deltaをツール結果として処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const event = {
    type: "item.command_output.delta",
    item: {
      id: "cmd_123",
      type: "command_output",
      is_error: false,
    },
    delta: {
      command_output: {
        stdout_delta: "Running tests...\nAll green!\n",
      },
    },
    session_id: "session-123",
  };

  const result = processor.extractOutputMessage(
    event as unknown as CodexExecJsonEvent,
  );

  assertEquals(
    result,
    "✅ **ツール実行結果:**\n```\nRunning tests...\nAll green!\n\n```",
  );
});

Deno.test("CodexStreamProcessor - command_outputのエラー出力を処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const event = {
    type: "item.command_output.delta",
    item: {
      id: "cmd_456",
      type: "command_output",
      is_error: true,
    },
    delta: {
      command_output: {
        stderr_delta: "Traceback (most recent call last)",
      },
    },
    session_id: "session-123",
  };

  const result = processor.extractOutputMessage(
    event as unknown as CodexExecJsonEvent,
  );

  assertEquals(
    result,
    "❌ **ツール実行結果:**\n```\nTraceback (most recent call last)\n```",
  );
});

Deno.test("CodexStreamProcessor - command metadata を表示する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const event = {
    type: "item.command_output.started",
    item: {
      id: "cmd_789",
      type: "command_output",
      command: ["bash", "-lc", "ls -la"],
      shell: "bash",
    },
    delta: {
      command_output: {
        command: ["bash", "-lc", "ls -la"],
        shell: "bash",
      },
    },
    session_id: "session-123",
  };

  const result = processor.extractOutputMessage(
    event as unknown as CodexExecJsonEvent,
  );

  assertEquals(result?.includes("💻 **Command"), true);
  assertEquals(result?.includes("ls -la"), true);
});
