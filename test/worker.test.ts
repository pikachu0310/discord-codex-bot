import { assertEquals } from "std/assert/mod.ts";
import { ok } from "neverthrow";
import type { CodexCommandExecutor } from "../src/worker/codex-executor.ts";
import { Worker } from "../src/worker/worker.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

class FakeCodexExecutor implements CodexCommandExecutor {
  constructor(private readonly lines: readonly string[]) {}

  executeStreaming(
    _args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
  ) {
    const encoder = new TextEncoder();
    onData(encoder.encode(this.lines.join("\n") + "\n"));
    return Promise.resolve(ok({ code: 0, stderr: new Uint8Array() }));
  }
}

Deno.test("Worker: 最終応答候補のagent_messageも進捗として送信する", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "worker_test_" });
  const worktreePath = await Deno.makeTempDir({ prefix: "worker_worktree_" });
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
