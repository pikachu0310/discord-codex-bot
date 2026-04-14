import { assertEquals, assertExists } from "std/assert/mod.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

Deno.test("WorkspaceManager: worker state を保存・読み込みできる", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "workspace_test_" });
  try {
    const manager = new WorkspaceManager(baseDir);
    await manager.initialize();

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: "w1",
      threadId: "123",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      sessionId: "s1",
    };
    await manager.saveWorkerState(state);

    const loaded = await manager.loadWorkerState("123");
    assertExists(loaded);
    assertEquals(loaded?.workerName, "w1");
    assertEquals(loaded?.sessionId, "s1");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test(
  "WorkspaceManager: thread info は初回メッセージ関連フィールドを補完する",
  async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "workspace_test_" });
    try {
      const manager = new WorkspaceManager(baseDir);
      await manager.initialize();

      await manager.saveThreadInfo({
        threadId: "thread-1",
        repositoryFullName: "a/b",
        repositoryLocalPath: "a/b",
        worktreePath: "/tmp/worktree",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: "active",
      });

      const loaded = await manager.loadThreadInfo("thread-1");
      assertExists(loaded);
      assertEquals(loaded?.firstUserMessageReceivedAt, null);
      assertEquals(loaded?.autoRenamedByFirstMessage, false);
    } finally {
      await Deno.remove(baseDir, { recursive: true });
    }
  },
);
