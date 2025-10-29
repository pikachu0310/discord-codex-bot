import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import {
  type CodexStreamMessage,
  CodexStreamProcessor,
} from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";

Deno.test("extractOutputMessage - タスクエージェントの配列形式tool_resultを正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // タスクエージェントからの配列形式のtool_result
  const parsedMessage = {
    "type": "user",
    "message": {
      "id": "msg_01234",
      "type": "message",
      "role": "user",
      "model": "codex-opus-4-20250514",
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01234",
        "content": [
          {
            "type": "text",
            "text": "ファイル 'src/app.ts' を編集しました。",
          },
        ],
        "is_error": false,
      }],
      "stop_reason": "tool_use",
    },
    "session_id": "67330cb9-9877-491f-ba82-4c4c7a967ec5",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(typeof result, "string");
  assertEquals(result?.includes("✅ **ツール実行結果:**"), true);
  assertEquals(
    result?.includes("ファイル 'src/app.ts' を編集しました。"),
    true,
  );
});

Deno.test("extractOutputMessage - 複数のテキスト要素を持つ配列形式tool_resultを処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01234",
        "content": [
          {
            "type": "text",
            "text": "ステップ1: 初期化を完了しました。",
          },
          {
            "type": "text",
            "text": "ステップ2: データベース接続を確立しました。",
          },
          {
            "type": "text",
            "text": "ステップ3: 処理が完了しました。",
          },
        ],
        "is_error": false,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(typeof result, "string");
  assertEquals(result?.includes("✅ **ツール実行結果:**"), true);
  assertEquals(result?.includes("ステップ1: 初期化を完了しました。"), true);
  assertEquals(
    result?.includes("ステップ2: データベース接続を確立しました。"),
    true,
  );
  assertEquals(result?.includes("ステップ3: 処理が完了しました。"), true);
});

Deno.test("extractOutputMessage - エラー時の配列形式tool_resultを処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01234",
        "content": [
          {
            "type": "text",
            "text": "エラー: ファイルが見つかりません",
          },
        ],
        "is_error": true,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(typeof result, "string");
  assertEquals(result?.includes("❌ **ツール実行結果:**"), true);
  assertEquals(result?.includes("エラー: ファイルが見つかりません"), true);
});

Deno.test("extractOutputMessage - text以外の要素を含む配列は無視する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01234",
        "content": [
          {
            "type": "text",
            "text": "有効なテキスト",
          },
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/png",
              "data": "base64data",
            },
          },
        ],
        "is_error": false,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(typeof result, "string");
  assertEquals(result?.includes("✅ **ツール実行結果:**"), true);
  assertEquals(result?.includes("有効なテキスト"), true);
  // 画像データは含まれない
  assertEquals(result?.includes("image"), false);
  assertEquals(result?.includes("base64"), false);
});

Deno.test("extractOutputMessage - 空の配列形式contentを処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01234",
        "content": [],
        "is_error": false,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, "✅ **ツール実行結果:**\n```\n(空の結果)\n```");
});
