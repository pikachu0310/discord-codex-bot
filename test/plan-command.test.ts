import { assertEquals } from "jsr:@std/assert";
import { Admin } from "../src/admin/admin.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { DefaultCodexCommandExecutor } from "../src/worker/codex-executor.ts";
import { Worker } from "../src/worker/worker.ts";

// テスト用のディレクトリを作成
const testDir = await Deno.makeTempDir({ prefix: "plan_command_test_" });

Deno.test({
  name: "Adminクラス - setPlanMode メソッドのテスト",
  async fn() {
    const workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();

    const admin = new Admin(
      { activeThreadIds: [], lastUpdated: new Date().toISOString() },
      workspaceManager,
    );

    const threadId = "test_thread_123";

    // Worker が存在しない場合
    const resultNotFound = await admin.setPlanMode(threadId, true);
    assertEquals(resultNotFound.isErr(), true);
    if (resultNotFound.isErr()) {
      assertEquals(resultNotFound.error.type, "WORKER_NOT_FOUND");
    }

    // Worker を作成
    const createResult = await admin.createWorker(threadId);
    assertEquals(createResult.isOk(), true);

    // Plan モードを有効にする
    const planResult = await admin.setPlanMode(threadId, true);
    assertEquals(planResult.isOk(), true);

    // Worker の状態を確認
    const workerResult = admin.getWorker(threadId);
    assertEquals(workerResult.isOk(), true);
    if (workerResult.isOk()) {
      const worker = workerResult.value;
      assertEquals(worker.isPlanMode(), true);
    }

    // Plan モードを無効にする
    const disablePlanResult = await admin.setPlanMode(threadId, false);
    assertEquals(disablePlanResult.isOk(), true);

    // Worker の状態を確認
    const workerResult2 = admin.getWorker(threadId);
    assertEquals(workerResult2.isOk(), true);
    if (workerResult2.isOk()) {
      const worker = workerResult2.value;
      assertEquals(worker.isPlanMode(), false);
    }

    // クリーンアップ
    await admin.terminateThread(threadId);
    await Deno.remove(testDir, { recursive: true });
  },
});

Deno.test({
  name: "Workerクラス - Plan モードのテスト",
  async fn() {
    const workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();

    const workerState = {
      workerName: "test_worker",
      threadId: "test_thread_456",
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active" as const,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    const codexExecutor = new DefaultCodexCommandExecutor(false);
    const worker = new Worker(workerState, workspaceManager, codexExecutor);

    // 初期状態では Plan モードは無効
    assertEquals(worker.isPlanMode(), false);

    // Plan モードを有効にする
    worker.setPlanMode(true);
    assertEquals(worker.isPlanMode(), true);

    // Plan モードを無効にする
    worker.setPlanMode(false);
    assertEquals(worker.isPlanMode(), false);

    await Deno.remove(testDir, { recursive: true });
  },
});

Deno.test({
  name: "Adminクラス - closeThread メソッドのテスト",
  async fn() {
    const workspaceManager = new WorkspaceManager(testDir);
    await workspaceManager.initialize();

    const admin = new Admin(
      { activeThreadIds: [], lastUpdated: new Date().toISOString() },
      workspaceManager,
    );

    const threadId = "test_thread_close_789";

    // Worker が存在しない場合
    const resultNotFound = await admin.closeThread(threadId);
    assertEquals(resultNotFound.isOk(), true); // terminateThread は存在しないWorkerでも成功する

    // Worker を作成
    const createResult = await admin.createWorker(threadId);
    assertEquals(createResult.isOk(), true);

    // スレッドをクローズ
    const closeResult = await admin.closeThread(threadId);
    assertEquals(closeResult.isOk(), true);

    // Worker が削除されていることを確認
    const workerResult = admin.getWorker(threadId);
    assertEquals(workerResult.isErr(), true);
    if (workerResult.isErr()) {
      assertEquals(workerResult.error.type, "WORKER_NOT_FOUND");
    }

    await Deno.remove(testDir, { recursive: true });
  },
});
