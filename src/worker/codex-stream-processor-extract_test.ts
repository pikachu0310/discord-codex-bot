import { assertEquals } from "https://deno.land/std@0.208.0/testing/asserts.ts";
import {
  type CodexExecJsonEvent,
  type CodexStreamMessage,
  CodexStreamProcessor,
} from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";

Deno.test("extractOutputMessage - TODOリスト更新（tool_use）を正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // TODOリスト更新のCodexStreamMessageをシミュレート
  const parsedMessage = {
    "type": "assistant",
    "message": {
      "id": "msg_016qk6hg3rkefqrzxprwZMCu",
      "type": "message",
      "role": "assistant",
      "model": "codex-opus-4-20250514",
      "content": [{
        "type": "tool_use",
        "id": "toolu_01ChHKW78mBDo3MZWBNsSQFy",
        "name": "TodoWrite",
        "input": {
          "todos": [
            {
              "id": "1",
              "content": "extractOutputMessage関数の現在の実装を確認",
              "status": "completed",
              "priority": "high",
            },
            {
              "id": "2",
              "content":
                "TODOリスト更新ログを適切にパースして変更後の状態を抽出",
              "status": "completed",
              "priority": "high",
            },
            {
              "id": "3",
              "content": "チェックマーク付きリスト形式で出力する機能を実装",
              "status": "in_progress",
              "priority": "high",
            },
            {
              "id": "4",
              "content": "テストを実行して動作確認",
              "status": "pending",
              "priority": "medium",
            },
          ],
        },
      }],
      "stop_reason": "tool_use",
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );

  assertEquals(typeof result, "string");
  assertEquals(result?.includes("📋 **TODOリスト更新:**"), true);
  assertEquals(
    result?.includes("✅ extractOutputMessage関数の現在の実装を確認"),
    true,
  );
  assertEquals(
    result?.includes(
      "✅ TODOリスト更新ログを適切にパースして変更後の状態を抽出",
    ),
    true,
  );
  assertEquals(
    result?.includes("🔄 チェックマーク付きリスト形式で出力する機能を実装"),
    true,
  );
  assertEquals(result?.includes("⬜ テストを実行して動作確認"), true);
});

Deno.test("extractOutputMessage - 通常のテキストメッセージを正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "assistant",
    "message": {
      "id": "msg_016qk6hg3rkefqrzxprwZMCu",
      "type": "message",
      "role": "assistant",
      "model": "codex-opus-4-20250514",
      "content": [{
        "type": "text",
        "text": "これは通常のテキストメッセージです。",
      }],
      "stop_reason": "end_turn",
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, "これは通常のテキストメッセージです。");
});

Deno.test("extractOutputMessage - resultメッセージは進捗表示しない", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "result",
    "subtype": "success",
    "cost_usd": 0.01,
    "duration_ms": 5000,
    "duration_api_ms": 4500,
    "is_error": false,
    "num_turns": 1,
    "result": "処理が完了しました。",
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, null);
});

Deno.test("extractOutputMessage - systemメッセージを正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "system",
    "subtype": "init",
    "session_id": "session-123",
    "tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    "mcp_servers": [
      { "name": "filesystem", "status": "ready" },
    ],
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(
    result,
    "🔧 **システム初期化:** ツール: Bash, Read, Write, Edit, Glob, Grep, MCPサーバー: filesystem(ready)",
  );
});

Deno.test("extractOutputMessage - Bashツール実行を正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "assistant",
    "message": {
      "content": [{
        "type": "tool_use",
        "id": "tool-123",
        "name": "Bash",
        "input": {
          "command": "ls -la",
          "description": "ファイル一覧を表示",
        },
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, "⚡ **Bash**: ファイル一覧を表示");
});

Deno.test("extractOutputMessage - ツール結果（tool_result）を正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": "実行結果:\nファイル1.txt\nファイル2.txt\nファイル3.txt",
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
  assertEquals(result?.includes("```"), true);
  assertEquals(result?.includes("実行結果:"), true);
});

Deno.test("extractOutputMessage - エラーツール結果を正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": "Error: ファイルが見つかりません\n詳細情報...",
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
  assertEquals(result?.includes("Error: ファイルが見つかりません"), true);
});

Deno.test("extractOutputMessage - 短いツール結果を正しく処理する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": "OK",
        "is_error": false,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, "✅ **ツール実行結果:**\n```\nOK\n```");
});

Deno.test("extractOutputMessage - TodoWrite成功メッセージをスキップする", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": "Todos have been modified successfully",
        "is_error": false,
      }],
    },
    "session_id": "session-123",
  };

  const result = processor.extractOutputMessage(
    parsedMessage as unknown as CodexStreamMessage,
  );
  assertEquals(result, null);
});

Deno.test("extractOutputMessage - TodoWriteエラーメッセージは表示する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": "Error: Failed to update todos",
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
  assertEquals(result?.includes("Error: Failed to update todos"), true);
});

Deno.test("extractOutputMessage - 長いツール結果をスマート要約する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // 長いコンテンツを生成（gitコミット結果のシミュレーション）
  const content =
    `[feature-branch 1234567] Add new feature for user authentication
 3 files changed, 150 insertions(+), 20 deletions(-)
 create mode 100644 src/auth/login.ts
 create mode 100644 src/auth/logout.ts
 modified src/main.ts
${"詳細な変更内容が続く...\n".repeat(200)}`;

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": content,
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
  assertEquals(result?.includes("📊 **要約:**"), true);
  assertEquals(result?.includes("コミット 1234567"), true);
  assertEquals(result?.includes("3ファイル変更"), true);
});

Deno.test("extractOutputMessage - エラー結果から重要部分を抽出する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  const content = `デバッグ情報1
INFO: 処理を開始
DEBUG: 詳細ログ
${"DEBUG: 詳細ログ行が続く...\n".repeat(20)}
ERROR: ファイルが見つかりません: /path/to/file.txt
FAILED: 処理が失敗しました
Exception: NullPointerException
Fatal: システムエラーが発生しました
デバッグ情報2
INFO: 追加情報
${"INFO: 追加情報が続く...\n".repeat(10)}`;

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": content,
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
  assertEquals(result?.includes("ERROR: ファイルが見つかりません"), true);
  assertEquals(result?.includes("FAILED: 処理が失敗しました"), true);
  assertEquals(result?.includes("Exception: NullPointerException"), true);
  assertEquals(result?.includes("Fatal: システムエラーが発生しました"), true);
  // デバッグ情報は含まれない
  assertEquals(result?.includes("DEBUG:"), false);
});

Deno.test("extractOutputMessage - 中程度の長さの結果を先頭末尾で表示する", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // 中程度の長さのコンテンツを生成（500文字以上にする）
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    lines.push(`行${i}: 処理結果の詳細な情報がここに表示されます`);
  }
  const content = lines.join("\n");

  const parsedMessage = {
    "type": "user",
    "message": {
      "content": [{
        "type": "tool_result",
        "tool_use_id": "tool-123",
        "content": content,
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
  assertEquals(result?.includes("行1: 処理結果"), true);
  assertEquals(result?.includes("行10: 処理結果"), true);
  assertEquals(result?.includes("行省略"), true);
  assertEquals(result?.includes("行50: 処理結果"), true);
});

Deno.test(
  "extractSessionId - response.session.id をフォールバックとして取得する",
  () => {
    const formatter = new MessageFormatter();
    const processor = new CodexStreamProcessor(formatter);

    const event: CodexExecJsonEvent = {
      type: "turn.completed",
      response: {
        session: {
          id: "nested-session-id",
          path: "/tmp/workspaces/nested-session-id",
        },
      },
    };

    const sessionId = processor.extractSessionId(event);
    assertEquals(sessionId, "nested-session-id");
  },
);

Deno.test(
  "extractSessionId - sessionが文字列の場合も取得する",
  () => {
    const formatter = new MessageFormatter();
    const processor = new CodexStreamProcessor(formatter);

    const event = {
      type: "session.created",
      session: "session-from-string",
    } as unknown as CodexExecJsonEvent;

    const sessionId = processor.extractSessionId(event);
    assertEquals(sessionId, "session-from-string");
  },
);

Deno.test(
  "extractSessionId - session内の入れ子session_idも検出する",
  () => {
    const formatter = new MessageFormatter();
    const processor = new CodexStreamProcessor(formatter);

    const event = {
      type: "turn.completed",
      response: {
        session: {
          metadata: { session_id: "deep-session-id" },
        },
      },
    } as unknown as CodexExecJsonEvent;

    const sessionId = processor.extractSessionId(event);
    assertEquals(sessionId, "deep-session-id");
  },
);

Deno.test(
  "extractSessionId - session_pathのみの場合はnullを返す",
  () => {
    const formatter = new MessageFormatter();
    const processor = new CodexStreamProcessor(formatter);

    const event = {
      type: "turn.completed",
      session_path: "/tmp/workspaces/only-path",
    } as unknown as CodexExecJsonEvent;

    const sessionId = processor.extractSessionId(event);
    assertEquals(sessionId, null);
  },
);
