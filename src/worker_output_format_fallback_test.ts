import { assertEquals } from "https://deno.land/std@0.214.0/assert/mod.ts";
import { Worker } from "./worker/worker.ts";
import type { CodexCommandExecutor } from "./worker/codex-executor.ts";
import type { WorkerState } from "./workspace/workspace.ts";
import { WorkspaceManager } from "./workspace/workspace.ts";
import { parseRepository } from "./git-utils.ts";
import { ok } from "neverthrow";

function createWorkerState(threadId: string): WorkerState {
  const now = new Date().toISOString();
  return {
    workerName: "test-worker",
    threadId,
    devcontainerConfig: {
      useDevcontainer: false,
      useFallbackDevcontainer: false,
      hasDevcontainerFile: false,
      hasAnthropicsFeature: false,
      isStarted: false,
    },
    status: "active",
    createdAt: now,
    lastActiveAt: now,
  };
}

function emitSuccess(onData: (data: Uint8Array) => void, text: string): void {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "test-session-id",
  }) + "\n";
  onData(new TextEncoder().encode(line));
}

async function createReadyWorker(
  executor: CodexCommandExecutor,
  threadId: string,
): Promise<{
  worker: Worker;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await Deno.makeTempDir({ prefix: "worker_fixed_cmd_" });
  const repoPath = await Deno.makeTempDir({ prefix: "worker_repo_" });
  const workspaceManager = new WorkspaceManager(tempDir);
  await workspaceManager.initialize();

  const repositoryResult = parseRepository("test/repo");
  if (repositoryResult.isErr()) {
    throw new Error("repository parse failed");
  }

  const worker = new Worker(
    createWorkerState(threadId),
    workspaceManager,
    executor,
  );
  await worker.setRepository(repositoryResult.value, repoPath);

  return {
    worker,
    cleanup: async () => {
      await Deno.remove(repoPath, { recursive: true }).catch(() => {});
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    },
  };
}

class RecordingExecutor implements CodexCommandExecutor {
  readonly argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    this.argsHistory.push([...args]);
    emitSuccess(onData, "ok");
    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

class UnsupportedOptionExecutor implements CodexCommandExecutor {
  attempts = 0;
  readonly argsHistory: string[][] = [];

  async executeStreaming(
    args: string[],
    _cwd: string,
    _onData: (data: Uint8Array) => void,
  ) {
    this.attempts++;
    this.argsHistory.push([...args]);
    return ok({
      code: 2,
      stderr: new TextEncoder().encode(
        "error: unexpected argument '--search' found\n",
      ),
    });
  }
}

class TtyRetryExecutor implements CodexCommandExecutor {
  attempts = 0;
  readonly ptyHistory: boolean[] = [];

  async executeStreaming(
    _args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    _abortSignal?: AbortSignal,
    _onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    _env?: Record<string, string>,
    options?: { usePty?: boolean },
  ) {
    this.attempts++;
    this.ptyHistory.push(options?.usePty === true);

    if (this.attempts === 1) {
      return ok({
        code: 1,
        stderr: new TextEncoder().encode("stdout is not a terminal\n"),
      });
    }

    emitSuccess(onData, "tty-ok");
    return ok({ code: 0, stderr: new Uint8Array() });
  }
}

Deno.test("Worker - 固定コマンドで実行する", async () => {
  const executor = new RecordingExecutor();
  const { worker, cleanup } = await createReadyWorker(executor, "thread-fixed");

  try {
    const result = await worker.processMessage("固定コマンドテスト");
    assertEquals(result.isOk(), true);
    assertEquals(executor.argsHistory.length, 1);
    assertEquals(executor.argsHistory[0], [
      "--search",
      "exec",
      "--json",
      "--color",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      "固定コマンドテスト",
    ]);
  } finally {
    await cleanup();
  }
});

Deno.test("Worker - 未対応オプションエラー時に旧形式へフォールバックしない", async () => {
  const executor = new UnsupportedOptionExecutor();
  const { worker, cleanup } = await createReadyWorker(
    executor,
    "thread-no-fallback",
  );

  try {
    const result = await worker.processMessage("フォールバック不要テスト");
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "CODEX_CLI_UNSUPPORTED_OPTION");
    }
    assertEquals(executor.attempts, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("Worker - TTY必須エラー時はPTYモードで1回だけ再試行する", async () => {
  const executor = new TtyRetryExecutor();
  const { worker, cleanup } = await createReadyWorker(executor, "thread-tty");

  try {
    const result = await worker.processMessage("TTY再試行テスト");
    assertEquals(result.isOk(), true);
    assertEquals(executor.attempts, 2);
    assertEquals(executor.ptyHistory, [false, true]);
  } finally {
    await cleanup();
  }
});
