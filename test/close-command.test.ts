import { assertEquals } from "jsr:@std/assert";
import { Admin } from "../src/admin/admin.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

// テスト用のディレクトリを作成
const testDir = await Deno.makeTempDir({ prefix: "close_command_test_" });

Deno.test({
  name: "Adminクラス - closeThread メソッドの詳細テスト",
  async fn() {
    const workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();

    const admin = new Admin(
      { activeThreadIds: [], lastUpdated: new Date().toISOString() },
      workspaceManager,
    );

    const threadId = "test_thread_close_detailed";

    // Worker を作成
    const createResult = await admin.createWorker(threadId);
    assertEquals(createResult.isOk(), true);

    // ThreadInfo を作成
    const threadInfo = {
      threadId: threadId,
      repositoryFullName: "test/repo",
      repositoryLocalPath: "/tmp/test/repo",
      worktreePath: "/tmp/test/worktree",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active" as const,
    };
    await workspaceManager.saveThreadInfo(threadInfo);

    // スレッドをクローズ
    const closeResult = await admin.closeThread(threadId);
    assertEquals(closeResult.isOk(), true);

    // Worker が削除されていることを確認
    const workerResult = admin.getWorker(threadId);
    assertEquals(workerResult.isErr(), true);
    if (workerResult.isErr()) {
      assertEquals(workerResult.error.type, "WORKER_NOT_FOUND");
    }

    // ThreadInfo がアーカイブ状態になっていることを確認
    const updatedThreadInfo = await workspaceManager.loadThreadInfo(threadId);
    assertEquals(updatedThreadInfo?.status, "archived");

    await Deno.remove(testDir, { recursive: true });
  },
});

Deno.test({
  name: "closeThread - 存在しないスレッドのテスト",
  async fn() {
    const workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();

    const admin = new Admin(
      { activeThreadIds: [], lastUpdated: new Date().toISOString() },
      workspaceManager,
    );

    const threadId = "non_existent_thread";

    // 存在しないスレッドをクローズ（エラーにならない）
    const closeResult = await admin.closeThread(threadId);
    assertEquals(closeResult.isOk(), true);

    await Deno.remove(testDir, { recursive: true });
  },
});
