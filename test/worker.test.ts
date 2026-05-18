import { assertEquals } from "std/assert/mod.ts";
import { dirname, fromFileUrl } from "std/path/mod.ts";
import { ok } from "neverthrow";
import type { CodexCommandExecutor } from "../src/worker/codex-executor.ts";
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
  public readonly executedArgs: string[][] = [];

  constructor(
    private readonly lines: readonly string[],
    private readonly outputLastMessage?: string,
    private readonly code = 0,
    private readonly stderr = "",
  ) {}

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    this.executedArgs.push(args);
    const encoder = new TextEncoder();
    onData(encoder.encode(this.lines.join("\n") + "\n"));
    if (this.outputLastMessage !== undefined) {
      const outputArgIndex = args.indexOf("--output-last-message");
      const outputPath = args[outputArgIndex + 1];
      await Deno.writeTextFile(outputPath, this.outputLastMessage);
    }
    return Promise.resolve(ok({
      code: this.code,
      stderr: new TextEncoder().encode(this.stderr),
    }));
  }
}

Deno.test("Worker: 最終応答候補のagent_messageも進捗として送信する", async () => {
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
    assertEquals(progress.includes("最終返信です。"), true);
  } finally {
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
      "last message側の失敗理由です。",
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
    assertEquals(error.error.includes("last message側の失敗理由です。"), true);
    assertEquals(error.error.includes("stdout側の失敗理由です。"), true);
    assertEquals(error.error.includes("保存ログ:"), true);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: TMPDIRが壊れていてもWORK_BASE_DIRの一時ファイルを使う", async () => {
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

    const args = executor.executedArgs[0];
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    assertEquals(
      outputPath.startsWith(`${workspaceManager.getTempDir()}/`),
      true,
    );
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

Deno.test("Worker: usage情報があれば最終応答末尾にトークンと料金を表示する", async () => {
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
          text: "完了しました。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          reasoning_tokens: 25,
          output_tokens: 50,
          total_tokens: 175,
          cost_usd: 0.01,
        },
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    const result = await worker.processMessage("依頼");

    assertEquals(result.isOk(), true);
    assertEquals(
      result._unsafeUnwrap(),
      [
        "完了しました。",
        "",
        "```text",
        "トークン: 入力 100 / 処理 25 / 出力 50",
        "合計: 175",
        "料金： ¥2 JPY ($0.010000USD)",
        "※ OpenAI応答の cost_usd を表示",
        "※ 1 USD = 160 JPY の固定レートで換算",
        "スレッド累計トークン: 合計 175",
        "スレッド累計料金： ¥2 JPY ($0.010000USD)",
        "```",
      ].join("\n"),
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: costがないusageは料金未取得メッセージを表示する", async () => {
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
          text: "完了しました。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          reasoning_tokens: 25,
          output_tokens: 50,
          total_tokens: 175,
        },
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    const result = await worker.processMessage("依頼");

    assertEquals(result.isOk(), true);
    assertEquals(
      result._unsafeUnwrap(),
      [
        "完了しました。",
        "",
        "```text",
        "トークン: 入力 100 / 処理 25 / 出力 50",
        "合計: 175",
        "料金： 取得不可（cost_usd が無く、モデル単価表でも計算できません）",
        "スレッド累計トークン: 合計 175",
        "```",
      ].join("\n"),
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: cost_usdが無くてもモデル単価から料金計算できる", async () => {
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
          text: "完了しました。",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        response: {
          model: "gpt-5.1-codex",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            reasoning_tokens: 200,
            output_tokens: 300,
            total_tokens: 1500,
          },
        },
      }),
    ]);

    const worker = new Worker(state, workspaceManager, executor);
    const result = await worker.processMessage("依頼");

    assertEquals(result.isOk(), true);
    assertEquals(
      result._unsafeUnwrap(),
      [
        "完了しました。",
        "",
        "```text",
        "トークン: 入力 1000 / 処理 200 / 出力 300",
        "入力キャッシュ: 400",
        "合計: 1500",
        "モデル: gpt-5.1-codex",
        "料金： ¥1 JPY ($0.005800USD)",
        "※ cost_usd 欠落のためモデル単価から算出（gpt-5.1-codex）",
        "※ 1 USD = 160 JPY の固定レートで換算",
        "スレッド累計トークン: 合計 1500",
        "スレッド累計料金： ¥1 JPY ($0.005800USD)",
        "```",
      ].join("\n"),
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});

Deno.test("Worker: スレッド累計トークンがターンを跨いで加算される", async () => {
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

    const worker1 = new Worker(
      state,
      workspaceManager,
      new FakeCodexExecutor([
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "1回目" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            reasoning_tokens: 2,
            output_tokens: 3,
            cost_usd: 0.01,
          },
        }),
      ]),
    );
    const first = await worker1.processMessage("依頼1");
    assertEquals(first.isOk(), true);

    const loaded = await workspaceManager.loadWorkerState("thread-1");
    if (!loaded) throw new Error("worker state not found");

    const worker2 = new Worker(
      loaded,
      workspaceManager,
      new FakeCodexExecutor([
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "2回目" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            reasoning_tokens: 4,
            output_tokens: 6,
            cost_usd: 0.02,
          },
        }),
      ]),
    );
    const second = await worker2.processMessage("依頼2");
    assertEquals(second.isOk(), true);
    assertEquals(
      second._unsafeUnwrap().includes("スレッド累計トークン: 合計 45"),
      true,
    );
    assertEquals(
      second._unsafeUnwrap().includes(
        "スレッド累計料金： ¥5 JPY ($0.030000USD)",
      ),
      true,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
    await Deno.remove(worktreePath, { recursive: true });
  }
});
