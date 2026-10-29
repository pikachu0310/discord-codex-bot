import { assertEquals } from "std/assert/mod.ts";
import { dirname, fromFileUrl } from "std/path/mod.ts";
import { ok } from "neverthrow";
import type {
  CodexCommandExecutor,
  CodexExecutionOptions,
} from "../src/worker/codex-executor.ts";
import { Worker } from "../src/worker/worker.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

const testRoot = dirname(fromFileUrl(import.meta.url));
const fixtureRoot = `${testRoot}/fixtures`;

async function createTestDir(prefix: string): Promise<string> {
  await Deno.mkdir(fixtureRoot, { recursive: true });
  return await Deno.makeTempDir({ dir: fixtureRoot, prefix });
}

class FakeCodexExecutor implements CodexCommandExecutor {
  public readonly executedOptions: CodexExecutionOptions[] = [];

  constructor(
    private readonly lines: readonly string[],
    private readonly outputLastMessage?: string,
    private readonly code = 0,
    private readonly stderr = "",
  ) {}

  async executeStreaming(
    options: CodexExecutionOptions,
    onData: (data: Uint8Array) => void,
  ) {
    this.executedOptions.push(options);
    const encoder = new TextEncoder();
    onData(encoder.encode(this.lines.join("\n") + "\n"));
    if (this.outputLastMessage !== undefined) {
      onData(
        encoder.encode(
          JSON.stringify({ type: "result", result: this.outputLastMessage }) +
            "\n",
        ),
      );
    }
    return Promise.resolve(ok({
      code: this.code,
      stderr: new TextEncoder().encode(this.stderr),
    }));
  }

  sendInput(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

Deno.test("Worker: 途中経過と最終回答を分け、最終回答を重複送信しない", async () => {
  const baseDir = await createTestDir("worker_test_");
  const worktreePath = await createTestDir("worker_worktree_");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "thread-1",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: worktreePath,
      worktreePath,
      sessionId: null,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    const executor = new FakeCodexExecutor([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          phase: "commentary",
          text: "途中ログです。",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "最終返信です。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        session_id: "session-1",
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    const progress: string[] = [];
    const result = await worker.processMessage(
      "依頼",
      [],
      (content) => {
        progress.push(content);
        return Promise.resolve();
      },
    );

    assertEquals(result.isOk(), true);
    assertEquals(result._unsafeUnwrap(), "最終返信です。");
    assertEquals(progress.includes("途中ログです。"), true);
    assertEquals(progress.includes("最終返信です。"), false);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: compactイベントを進捗として送信する", async () => {
  const baseDir = await createTestDir("worker_test_");
  const worktreePath = await createTestDir("worker_worktree_");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "thread-1",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: worktreePath,
      worktreePath,
      sessionId: "session-1",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    const executor = new FakeCodexExecutor([
      JSON.stringify({
        type: "context.compaction.started",
        trigger: "auto",
      }),
      JSON.stringify({
        type: "context.compaction.completed",
        trigger: "auto",
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "agent_message",
          text: "最終返信です。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        session_id: "session-1",
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    const progress: string[] = [];
    const result = await worker.processMessage(
      "依頼",
      [],
      (content) => {
        progress.push(content);
        return Promise.resolve();
      },
    );

    assertEquals(result.isOk(), true);
    assertEquals(progress.includes("コンテキスト圧縮を開始しました。"), true);
    assertEquals(progress.includes("コンテキスト圧縮が完了しました。"), true);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: 進捗通知が失敗してもCodex処理は継続する", async () => {
  const baseDir = await createTestDir("worker_test_");
  const worktreePath = await createTestDir("worker_worktree_");
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "thread-1",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: worktreePath,
      worktreePath,
      sessionId: null,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    const executor = new FakeCodexExecutor([
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "最終返信です。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        session_id: "session-1",
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    let progressAttempts = 0;
    const result = await worker.processMessage(
      "依頼",
      [],
      () => {
        progressAttempts += 1;
        return Promise.reject(new Error("discord bad request"));
      },
    );

    assertEquals(result.isOk(), true);
    assertEquals(result._unsafeUnwrap(), "最終返信です。");
    assertEquals(progressAttempts > 0, true);
  } finally {
    console.error = originalConsoleError;
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: Codex非ゼロ終了時に診断情報を返してrawログを保存する", async () => {
  const baseDir = await createTestDir("worker_test_");
  const worktreePath = await createTestDir("worker_worktree_");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "thread-1",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: worktreePath,
      worktreePath,
      sessionId: "session-1",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    const executor = new FakeCodexExecutor(
      [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "agent_message",
            text: "stdout側の失敗理由です。",
          },
        }),
      ],
      "result側の失敗理由です。",
      1,
      "stderr側の失敗理由です。",
    );
    const worker = new Worker(state, workspaceManager, executor);

    const result = await worker.processMessage("依頼");

    assertEquals(result.isErr(), true);
    const error = result._unsafeUnwrapErr();
    assertEquals(error.type, "CODEX_EXECUTION_FAILED");
    if (error.type !== "CODEX_EXECUTION_FAILED") {
      throw new Error("expected CODEX_EXECUTION_FAILED");
    }
    assertEquals(error.error.includes("終了コード: 1"), true);
    assertEquals(error.error.includes("stderr側の失敗理由です。"), true);
    assertEquals(error.error.includes("result側の失敗理由です。"), true);
    assertEquals(error.error.includes("stdout側の失敗理由です。"), true);
    assertEquals(error.error.includes("保存ログ:"), true);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: TMPDIRが壊れていてもApp Serverの最終返信を取得する", async () => {
  const baseDir = await createTestDir("worker_test_");
  const worktreePath = await createTestDir("worker_worktree_");
  const originalTmpDir = Deno.env.get("TMPDIR");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "thread-1",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: worktreePath,
      worktreePath,
      sessionId: null,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    Deno.env.set("TMPDIR", "tmpfile");
    const executor = new FakeCodexExecutor([], "ファイル由来の最終返信です。");
    const worker = new Worker(state, workspaceManager, executor);
    const result = await worker.processMessage("依頼");

    assertEquals(result.isOk(), true);
    assertEquals(result._unsafeUnwrap(), "ファイル由来の最終返信です。");

    assertEquals(executor.executedOptions[0].cwd, worktreePath);
  } finally {
    if (originalTmpDir === undefined) {
      Deno.env.delete("TMPDIR");
    } else {
      Deno.env.set("TMPDIR", originalTmpDir);
    }
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}

class ControlledExecutor implements CodexCommandExecutor {
  readonly started = deferred<void>();
  readonly finished = deferred<void>();
  readonly inputs: CodexExecutionOptions[] = [];
  readonly executions: CodexExecutionOptions[] = [];
  accepting = true;

  async executeStreaming(
    options: CodexExecutionOptions,
    onData: (data: Uint8Array) => void,
  ) {
    this.executions.push(options);
    this.started.resolve();
    onData(
      new TextEncoder().encode(
        JSON.stringify({ type: "thread.started", thread_id: "new-session" }) +
          "\n",
      ),
    );
    if (this.executions.length === 1) await this.finished.promise;
    onData(
      new TextEncoder().encode(
        JSON.stringify({ type: "result", result: "完了" }) + "\n",
      ),
    );
    return ok({ code: 0, stderr: new Uint8Array() });
  }

  sendInput(options: CodexExecutionOptions): Promise<boolean> {
    this.inputs.push(options);
    return Promise.resolve(this.accepting);
  }
}

async function withControlledWorker(
  test: (
    worker: Worker,
    executor: ControlledExecutor,
    manager: WorkspaceManager,
  ) => Promise<void>,
) {
  const baseDir = await createTestDir("worker_concurrent_");
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();
    const executor = new ControlledExecutor();
    const now = new Date().toISOString();
    const worker = new Worker(
      {
        workerName: "test",
        threadId: "thread-concurrent",
        repository: { fullName: "owner/repo", org: "owner", repo: "repo" },
        repositoryLocalPath: baseDir,
        worktreePath: baseDir,
        sessionId: null,
        status: "active",
        createdAt: now,
        lastActiveAt: now,
      },
      manager,
      executor,
    );
    await test(worker, executor, manager);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Worker: 開始通知中の連続投稿も同じ実行に渡す", async () => {
  await withControlledWorker(async (worker, executor) => {
    worker.setPlanMode(true);
    const progressGate = deferred<void>();
    const run = worker.processMessage("最初", [], () => progressGate.promise);
    assertEquals(worker.isRunning(), true);
    const followup = worker.processMessage("追加");
    progressGate.resolve();
    const accepted = await followup;
    assertEquals(accepted.isOk(), true);
    assertEquals(executor.executions.length, 1);
    assertEquals(executor.inputs.map((input) => input.prompt), ["追加"]);
    assertEquals(
      executor.executions[0].prompt.startsWith("You are in plan mode."),
      true,
    );
    executor.finished.resolve();
    assertEquals((await run)._unsafeUnwrap(), "完了");
    assertEquals(worker.isRunning(), false);
  });
});

Deno.test("Worker: 完了直前に受け付けられなかった投稿を保存済みセッションで再実行する", async () => {
  await withControlledWorker(async (worker, executor, manager) => {
    executor.accepting = false;
    const run = worker.processMessage("最初");
    await executor.started.promise;
    const followup = worker.processMessage("追加");
    executor.finished.resolve();
    await run;
    assertEquals((await followup)._unsafeUnwrap(), "完了");
    assertEquals(executor.executions.length, 2);
    assertEquals(executor.executions[1].sessionId, "new-session");
    assertEquals(
      (await manager.loadWorkerState("thread-concurrent"))?.sessionId,
      "new-session",
    );
  });
});

Deno.test("Worker: 開始通知中のstopでも新しいCodexを起動しない", async () => {
  await withControlledWorker(async (worker, executor) => {
    const progressGate = deferred<void>();
    const run = worker.processMessage("最初", [], () => progressGate.promise);
    assertEquals(await worker.stopExecution(), true);
    progressGate.resolve();
    assertEquals((await run)._unsafeUnwrap(), "⛔ Codex実行を中断しました。");
    assertEquals(executor.executions.length, 0);
    assertEquals(worker.isRunning(), false);
  });
});
