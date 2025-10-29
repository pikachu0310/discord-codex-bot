import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseRepository } from "./git-utils.ts";
import { CodexCommandExecutor } from "./worker/codex-executor.ts";
import { ok } from "neverthrow";
import { WorkerState, WorkspaceManager } from "./workspace/workspace.ts";
import { Worker } from "./worker/worker.ts";

// モックのCodexCommandExecutor
class MockCodexCommandExecutor implements CodexCommandExecutor {
  private responses: string[] = [];
  private callCount = 0;
  public lastPrompt: string | null = null;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    _options?: { usePty?: boolean },
  ) {
    if (args.length > 0) {
      this.lastPrompt = args[args.length - 1];
    }

    // 各レスポンスを順番に送信（ストリーミングをシミュレート）
    while (this.callCount < this.responses.length) {
      const response = this.responses[this.callCount++];
      if (response) {
        const data = new TextEncoder().encode(response + "\n");
        onData(data);
        // 少し待機してストリーミングをシミュレート
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

// モックの翻訳サーバー
class MockTranslationServer {
  private server: Deno.HttpServer | null = null;
  private port: number;
  private translations: Map<string, string> = new Map();

  constructor(port: number) {
    this.port = port;
    // デフォルトの翻訳ルール
    this.translations.set(
      "認証機能を実装してください",
      "Implement authentication functionality",
    );
    this.translations.set(
      "エラーハンドリングを追加してください",
      "Add error handling",
    );
  }

  async start() {
    this.server = Deno.serve({ port: this.port }, (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return new Response("OK", { status: 200 });
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return req.json().then((body) => {
          const userMessage = body.messages.find((m: { role: string }) =>
            m.role === "user"
          );
          const content = userMessage?.content || "";

          // 登録された翻訳があればそれを返す
          const translated = this.translations.get(content) ||
            `Translated: ${content}`;

          return new Response(
            JSON.stringify({
              choices: [{
                message: {
                  content: translated,
                },
              }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        });
      }

      return new Response("Not Found", { status: 404 });
    });

    // サーバーが起動するまで少し待つ
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
    }
  }

  addTranslation(japanese: string, english: string) {
    this.translations.set(japanese, english);
  }
}

Deno.test("Worker - 翻訳機能が有効な場合、メッセージが翻訳される", async () => {
  const tempDir = await Deno.makeTempDir();
  const mockServer = new MockTranslationServer(8767);
  await mockServer.start();

  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const mockExecutor = new MockCodexCommandExecutor([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session",
        tools: [],
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_001",
          type: "message",
          role: "assistant",
          model: "codex-3-opus",
          content: [{
            type: "text",
            text: "Authentication has been implemented.",
          }],
          stop_reason: "end_turn",
        },
        session_id: "test-session",
      }),
      JSON.stringify({
        type: "result",
        result: "Authentication has been implemented.",
        subtype: "success",
        is_error: false,
        session_id: "test-session",
      }),
    ]);

    const state: WorkerState = {
      workerName: "test-worker",
      threadId: "test-thread",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    const worker = new Worker(
      state,
      workspaceManager,
      mockExecutor,
      false,
      undefined,
      "http://localhost:8767", // 翻訳URLを設定
    );

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false);

    // リポジトリを設定
    const repositoryResult = parseRepository("test/repo");
    if (repositoryResult.isOk()) {
      await worker.setRepository(repositoryResult.value, tempDir);
    }

    const result = await worker.processMessage("認証機能を実装してください");

    // 結果が正常に返されることを確認
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      // Codexに渡されたプロンプトが翻訳されているか確認
      assertEquals(
        mockExecutor.lastPrompt,
        "Implement authentication functionality",
      );
      assertEquals(
        result.value,
        "Authentication has been implemented.",
      );
    }
  } finally {
    await mockServer.stop();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Worker - 翻訳機能が無効な場合、元のメッセージがそのまま使用される", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const mockExecutor = new MockCodexCommandExecutor([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session",
        tools: [],
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_002",
          type: "message",
          role: "assistant",
          model: "codex-3-opus",
          content: [{ type: "text", text: "認証機能を実装しました。" }],
          stop_reason: "end_turn",
        },
        session_id: "test-session",
      }),
      JSON.stringify({
        type: "result",
        result: "認証機能を実装しました。",
        subtype: "success",
        is_error: false,
        session_id: "test-session",
      }),
    ]);

    const state: WorkerState = {
      workerName: "test-worker",
      threadId: "test-thread",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    const worker = new Worker(
      state,
      workspaceManager,
      mockExecutor,
      false,
      undefined,
      undefined, // 翻訳URLなし
    );

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false);

    // リポジトリを設定
    const repositoryResult = parseRepository("test/repo");
    if (repositoryResult.isOk()) {
      await worker.setRepository(repositoryResult.value, tempDir);
    }

    const result = await worker.processMessage("認証機能を実装してください");

    // 結果が正常に返されることを確認
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      // Codexに渡されたプロンプトが翻訳されていないことを確認
      assertEquals(mockExecutor.lastPrompt, "認証機能を実装してください");
      assertEquals(result.value, "認証機能を実装しました。");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Worker - 翻訳APIがエラーの場合、元のメッセージが使用される", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const mockExecutor = new MockCodexCommandExecutor([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "test-session",
        tools: [],
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_003",
          type: "message",
          role: "assistant",
          model: "codex-3-opus",
          content: [{
            type: "text",
            text: "エラーハンドリングを追加しました。",
          }],
          stop_reason: "end_turn",
        },
        session_id: "test-session",
      }),
      JSON.stringify({
        type: "result",
        result: "エラーハンドリングを追加しました。",
        subtype: "success",
        is_error: false,
        session_id: "test-session",
      }),
    ]);

    const state: WorkerState = {
      workerName: "test-worker",
      threadId: "test-thread",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    const worker = new Worker(
      state,
      workspaceManager,
      mockExecutor,
      false,
      undefined,
      "http://localhost:9999", // 存在しないサーバー
    );

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false);

    // リポジトリを設定
    const repositoryResult = parseRepository("test/repo");
    if (repositoryResult.isOk()) {
      await worker.setRepository(repositoryResult.value, tempDir);
    }

    const result = await worker.processMessage(
      "エラーハンドリングを追加してください",
    );

    // 結果が正常に返されることを確認
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      // 翻訳が失敗し、元のメッセージが使用されることを確認
      assertEquals(
        mockExecutor.lastPrompt,
        "エラーハンドリングを追加してください",
      );
      assertEquals(result.value, "エラーハンドリングを追加しました。");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test(
  "Worker - VERBOSEモードで翻訳結果がログに出力される",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const mockServer = new MockTranslationServer(8768);
    await mockServer.start();

    try {
      const workspaceManager = new WorkspaceManager(tempDir);
      await workspaceManager.initialize();

      const mockExecutor = new MockCodexCommandExecutor([
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "test-session",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "test-session",
          result: "Done!",
        }),
      ]);

      // consoleログをキャプチャ
      const originalLog = console.log;
      const logs: string[] = [];
      console.log = (message: string, ...args: unknown[]) => {
        logs.push(message);
        if (args.length > 0) {
          logs.push(...args.map((arg) => String(arg)));
        }
      };

      try {
        const state: WorkerState = {
          workerName: "test-worker",
          threadId: "test-thread",
          devcontainerConfig: {
            useDevcontainer: false,
            useFallbackDevcontainer: false,
            hasDevcontainerFile: false,
            hasAnthropicsFeature: false,
            isStarted: false,
          },
          status: "active",
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };
        const worker = new Worker(
          state,
          workspaceManager,
          mockExecutor,
          true, // VERBOSEモードを有効化
          undefined,
          "http://localhost:8768",
        );

        // devcontainer設定を完了させる
        worker.setUseDevcontainer(false);

        // リポジトリを設定
        const repositoryResult = parseRepository("test/repo");
        if (repositoryResult.isOk()) {
          await worker.setRepository(repositoryResult.value, tempDir);
        }

        const result = await worker.processMessage(
          "エラーハンドリングを追加してください",
        );

        // 結果が正常に返されることを確認
        assertEquals(result.isOk(), true);
        if (result.isOk()) {
          assertEquals(result.value, "Done!");
        }

        // 翻訳結果がログに記録されているか確認
        const hasTranslationLog = logs.some((log) =>
          log.includes("翻訳結果:") ||
          log.includes("元のメッセージ:") ||
          log.includes("翻訳後:")
        );

        // デバッグ用：ログの内容を確認
        if (!hasTranslationLog) {
          console.error("Captured logs:", logs);
        }

        assertEquals(hasTranslationLog, true);
      } finally {
        console.log = originalLog;
      }
    } finally {
      await mockServer.stop();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
