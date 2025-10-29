import { assertEquals } from "std/assert/mod.ts";
import { afterEach, beforeEach, describe, it } from "std/testing/bdd.ts";
import { Worker } from "./worker.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import type { CodexCommandExecutor } from "../worker/codex-executor.ts";
import type { CodexExecutorError } from "./types.ts";
import { err, ok, Result } from "neverthrow";

// モックExecutor - 長時間実行をシミュレート
class MockLongRunningExecutor implements CodexCommandExecutor {
  private process: Deno.ChildProcess | null = null;

  async executeStreaming(
    _args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
  ): Promise<
    Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>
  > {
    // 長時間実行するプロセスをシミュレート
    const command = new Deno.Command("sleep", {
      args: ["30"], // 30秒スリープ
      stdout: "piped",
      stderr: "piped",
      signal: abortSignal,
    });

    this.process = command.spawn();

    // プロセス開始コールバックを呼び出す
    if (onProcessStart) {
      onProcessStart(this.process);
    }

    // 定期的にデータを送信
    const encoder = new TextEncoder();
    const interval = setInterval(() => {
      onData(encoder.encode("Processing...\n"));
    }, 100);

    try {
      // stdoutとstderrを読み捨てる（リソースリークを防ぐ）
      const readStdout = async () => {
        try {
          if (this.process?.stdout) {
            for await (const _ of this.process.stdout) {
              // 読み捨てる
            }
          }
        } catch {
          // エラーは無視
        }
      };

      const readStderr = async () => {
        try {
          if (this.process?.stderr) {
            for await (const _ of this.process.stderr) {
              // 読み捨てる
            }
          }
        } catch {
          // エラーは無視
        }
      };

      const [status] = await Promise.all([
        this.process.status,
        readStdout(),
        readStderr(),
      ]);

      clearInterval(interval);

      if (abortSignal?.aborted) {
        return ok({ code: 143, stderr: new Uint8Array() }); // SIGTERM
      }

      return ok({ code: status.code, stderr: new Uint8Array() });
    } catch (error) {
      clearInterval(interval);
      if (error instanceof Error && error.message.includes("aborted")) {
        return ok({ code: 143, stderr: new Uint8Array() }); // SIGTERM
      }
      return err({
        type: "STREAM_PROCESSING_ERROR",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

describe("Worker stopExecution", () => {
  let testDir: string;
  let workspaceManager: WorkspaceManager;

  beforeEach(async () => {
    testDir = await Deno.makeTempDir();
    workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();
  });

  afterEach(async () => {
    await Deno.remove(testDir, { recursive: true });
  });

  it("実行中のプロセスを正常に中断できる", async () => {
    const mockExecutor = new MockLongRunningExecutor();
    const worker = new Worker(
      {
        workerName: "test-worker",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
        repository: {
          fullName: "test/repo",
          org: "test",
          repo: "repo",
        },
        repositoryLocalPath: `${testDir}/repos/test/repo`,
        worktreePath: `${testDir}/worktrees/thread-123`,
        threadId: "thread-123",
        sessionId: null,
        devcontainerConfig: {
          useDevcontainer: false,
          useFallbackDevcontainer: false,
          hasDevcontainerFile: false,
          hasAnthropicsFeature: false,
          isStarted: false,
        },
      },
      workspaceManager,
      mockExecutor,
    );

    const messages: string[] = [];
    let isExecuting = false;

    // Codex実行を非同期で開始
    const executePromise = worker.processMessage(
      "長時間実行するタスク",
      async (message) => {
        messages.push(message);
      },
    ).then(() => {
      isExecuting = false;
    });

    isExecuting = true;

    // 少し待ってから中断
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 実行中であることを確認
    assertEquals(isExecuting, true);
    assertEquals(
      messages.some((m) => m.includes("Codexが考えています")),
      true,
    );

    // stopExecutionを呼び出す
    const stopResult = await worker.stopExecution(async (message) => {
      messages.push(message);
    });

    assertEquals(stopResult, true);
    assertEquals(
      messages.some((m) => m.includes("Codex Codeの実行を中断しました")),
      true,
    );

    // executePromiseが完了するのを待つ
    await executePromise;

    // 実行が終了していることを確認
    assertEquals(isExecuting, false);
  });

  it("実行中でない場合はfalseを返す", async () => {
    const worker = new Worker(
      {
        workerName: "test-worker",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
        threadId: "thread-123",
        sessionId: null,
        devcontainerConfig: {
          useDevcontainer: false,
          useFallbackDevcontainer: false,
          hasDevcontainerFile: false,
          hasAnthropicsFeature: false,
          isStarted: false,
        },
      },
      workspaceManager,
    );

    const messages: string[] = [];
    const stopResult = await worker.stopExecution(async (message) => {
      messages.push(message);
    });

    assertEquals(stopResult, false);
    assertEquals(messages.length, 0);
  });

  it("複数回の中断呼び出しを適切に処理する", async () => {
    const mockExecutor = new MockLongRunningExecutor();
    const worker = new Worker(
      {
        workerName: "test-worker",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
        repository: {
          fullName: "test/repo",
          org: "test",
          repo: "repo",
        },
        repositoryLocalPath: `${testDir}/repos/test/repo`,
        worktreePath: `${testDir}/worktrees/thread-123`,
        threadId: "thread-123",
        sessionId: null,
        devcontainerConfig: {
          useDevcontainer: false,
          useFallbackDevcontainer: false,
          hasDevcontainerFile: false,
          hasAnthropicsFeature: false,
          isStarted: false,
        },
      },
      workspaceManager,
      mockExecutor,
    );

    // Codex実行を非同期で開始
    const executePromise = worker.processMessage(
      "長時間実行するタスク",
      async () => {},
    );

    // 少し待ってから中断
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 最初の中断
    const stopResult1 = await worker.stopExecution();
    assertEquals(stopResult1, true);

    // 2回目の中断（既に中断されているのでfalseを返すはず）
    const stopResult2 = await worker.stopExecution();
    assertEquals(stopResult2, false);

    // executePromiseが完了するのを待つ
    await executePromise;
  });
});
