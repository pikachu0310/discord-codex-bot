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
    return Promise.resolve(ok({ code: 0, stderr: new Uint8Array() }));
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
