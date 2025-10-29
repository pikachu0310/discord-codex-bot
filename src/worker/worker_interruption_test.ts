import { assertEquals, assertExists } from "std/assert/mod.ts";
import { Worker } from "./worker.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import { afterEach, beforeEach, describe, it } from "std/testing/bdd.ts";
import { join } from "std/path/mod.ts";
import type { WorkerState } from "../workspace/workspace.ts";
import type { CodexCommandExecutor } from "./codex-executor.ts";
import { ok, Result } from "neverthrow";
import type { CodexExecutorError } from "./types.ts";

describe("Worker 中断イベントログ記録", () => {
  let tempDir: string;
  let workspaceManager: WorkspaceManager;
  let worker: Worker;

  beforeEach(async () => {
    tempDir = await Deno.makeTempDir();
    workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();
  });

  afterEach(async () => {
    await Deno.remove(tempDir, { recursive: true });
  });

  it("stopExecutionメソッドが中断ログを記録する", async () => {
    // モックのCodexExecutorを作成
    const mockExecutor: CodexCommandExecutor = {
      executeStreaming: async (
        _args: string[],
        _cwd: string,
        onData: (data: Uint8Array) => void,
        signal?: AbortSignal,
        onChildProcess?: (childProcess: Deno.ChildProcess) => void,
      ): Promise<
        Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>
      > => {
        // プロセスを模擬
        const mockProcess = {
          pid: 12345,
          status: new Promise<Deno.CommandStatus>((resolve) => {
            // AbortSignalをリッスンして中断される
            signal?.addEventListener("abort", () => {
              resolve({ success: false, code: 143, signal: null }); // SIGTERM
            });
          }),
          kill: (_signal?: Deno.Signal) => {},
        } as unknown as Deno.ChildProcess;

        if (onChildProcess) {
          onChildProcess(mockProcess);
        }

        // ストリームデータを送信
        const encoder = new TextEncoder();

        // セッション開始
        onData(encoder.encode(
          `${
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "test-session-123",
              tools: ["Read", "Edit", "Bash"],
            })
          }\n`,
        ));

        // ツール使用メッセージ
        await new Promise((resolve) => setTimeout(resolve, 100));
        onData(encoder.encode(
          `${
            JSON.stringify({
              type: "assistant",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "codex-3",
                content: [{
                  type: "tool_use",
                  id: "tool_1",
                  name: "Read",
                  input: { file_path: "/test/file.txt" },
                }],
                stop_reason: "tool_use",
              },
              session_id: "test-session-123",
            })
          }\n`,
        ));

        // 中断されるまで待機
        await mockProcess.status;

        return ok({ code: 143, stderr: new Uint8Array() });
      },
    };

    // Workerの作成
    const workerState: WorkerState = {
      workerName: "test-worker",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      repository: {
        fullName: "test-org/test-repo",
        org: "test-org",
        repo: "test-repo",
      },
      repositoryLocalPath: join(
        tempDir,
        "repositories",
        "test-org",
        "test-repo",
      ),
      worktreePath: join(tempDir, "worktrees", "test-thread-123"),
      sessionId: "test-session-123",
      threadId: "test-thread-123",
      status: "active",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
    };

    worker = new Worker(
      workerState,
      workspaceManager,
      mockExecutor,
    );

    // worktreeディレクトリを作成
    if (workerState.worktreePath) {
      await Deno.mkdir(workerState.worktreePath, { recursive: true });
    }

    // プロセスメッセージを開始（非同期）
    const messagePromise = worker.processMessage("テストメッセージ");

    // 少し待ってから中断
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = await worker.stopExecution();
    assertEquals(stopped, true);

    // メッセージ処理の完了を待つ
    const result = await messagePromise;
    assertEquals(result.isErr(), true);

    // セッションログを確認
    const sessionManager = workspaceManager.getSessionManager();
    const sessionLogs = await sessionManager.loadSessionLogs(
      "test-org/test-repo",
      "test-session-123",
    );

    assertExists(sessionLogs);
    if (sessionLogs.isOk()) {
      const logs = sessionLogs.value;

      // 中断ログを探す
      const interruptionLog = logs.find((log) => log.type === "interruption");
      assertExists(interruptionLog, "中断ログが記録されているべき");

      if (interruptionLog) {
        assertEquals(interruptionLog.type, "interruption");
        assertEquals(interruptionLog.sessionId, "test-session-123");
        assertExists(interruptionLog.interruption);
        assertEquals(interruptionLog.interruption?.reason, "user_requested");
        assertExists(interruptionLog.interruption?.executionTime);
        assertEquals(
          interruptionLog.interruption?.lastActivity,
          "ツール使用: Read",
        );
      }
    }
  });

  it("実行中でない場合はstopExecutionが中断ログを記録しない", async () => {
    const workerState: WorkerState = {
      workerName: "test-worker",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      repository: {
        fullName: "test-org/test-repo",
        org: "test-org",
        repo: "test-repo",
      },
      sessionId: "test-session-456",
      threadId: "test-thread-456",
      status: "active",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
    };

    worker = new Worker(
      workerState,
      workspaceManager,
    );

    // 実行していない状態で中断を試みる
    const stopped = await worker.stopExecution();
    assertEquals(stopped, false);

    // セッションログが作成されていないことを確認
    const sessionManager = workspaceManager.getSessionManager();
    const sessionLogs = await sessionManager.loadSessionLogs(
      "test-org/test-repo",
      "test-session-456",
    );

    if (sessionLogs.isOk()) {
      assertEquals(
        sessionLogs.value.length,
        0,
        "セッションログは記録されていないべき",
      );
    }
  });
});
