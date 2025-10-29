import { assert, assertEquals, assertExists } from "std/assert/mod.ts";
import { Admin } from "./admin.ts";
import { AdminState, WorkspaceManager } from "../workspace/workspace.ts";

Deno.test("Admin - 基本的な初期化とWorker作成", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "test-thread-1";

    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk());
    const worker = workerResult.value;
    assertEquals(typeof worker.getName(), "string");

    // Workerを取得
    const retrievedWorkerResult = admin.getWorker(threadId);
    assert(retrievedWorkerResult.isOk());
    const retrievedWorker = retrievedWorkerResult.value;
    assertEquals(worker.getName(), retrievedWorker.getName());

    // Admin状態が更新されていることを確認
    await admin.save();
    const savedState = await workspaceManager.loadAdminState();
    assertExists(savedState);
    assertEquals(savedState.activeThreadIds.includes(threadId), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - スレッドの終了処理", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "test-thread-2";

    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk());

    // スレッドを終了
    const terminateResult = await admin.terminateThread(threadId);
    assert(terminateResult.isOk());

    // Workerが削除されていることを確認
    const getWorkerResult = admin.getWorker(threadId);
    assert(getWorkerResult.isErr());
    assertEquals(getWorkerResult.error.type, "WORKER_NOT_FOUND");

    // Admin状態からも削除されていることを確認
    await admin.save();
    const savedState = await workspaceManager.loadAdminState();
    assertExists(savedState);
    assertEquals(savedState.activeThreadIds.includes(threadId), false);

    // ThreadInfoがアーカイブされていることを確認
    const threadInfo = await workspaceManager.loadThreadInfo(threadId);
    assertExists(threadInfo);
    assertEquals(threadInfo?.status, "archived");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - スレッドの終了処理でdevcontainerも削除される", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "test-thread-devcontainer";

    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk());

    // devcontainer設定を保存（コンテナが起動している状態を模擬）
    await admin.saveDevcontainerConfig(threadId, {
      useDevcontainer: true,
      hasDevcontainerFile: true,
      hasAnthropicsFeature: true,
      containerId: "test-container-123",
      isStarted: true,
    });

    // 元のコマンド実行関数を保存
    const originalCommand = globalThis.Deno.Command;
    let dockerRmCalled = false;
    let dockerRmContainerId = "";

    // Deno.Commandをモック
    globalThis.Deno.Command = class MockCommand {
      constructor(command: string, options?: { args?: string[] }) {
        if (command === "docker" && options?.args?.[0] === "rm") {
          dockerRmCalled = true;
          dockerRmContainerId = options.args[3]; // rm -f -v {containerId}
        }
      }

      output(): Promise<
        { code: number; stdout: Uint8Array; stderr: Uint8Array }
      > {
        return Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode("container-id\n"),
          stderr: new Uint8Array(),
        });
      }
    } as unknown as typeof Deno.Command;

    try {
      // スレッドを終了
      const terminateResult = await admin.terminateThread(threadId);
      assert(terminateResult.isOk());

      // docker rmが呼ばれたことを確認
      assertEquals(dockerRmCalled, true);
      assertEquals(dockerRmContainerId, "test-container-123");

      // devcontainer設定が更新されていることを確認
      const devcontainerConfig = await admin.getDevcontainerConfig(threadId);
      assertExists(devcontainerConfig);
      assertEquals(devcontainerConfig.containerId, undefined);
      assertEquals(devcontainerConfig.isStarted, false);
    } finally {
      // Deno.Commandを復元
      globalThis.Deno.Command = originalCommand;
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - 初期メッセージの作成", () => {
  const tempDir = "dummy"; // このテストではファイルシステムを使用しない
  const workspaceManager = new WorkspaceManager(tempDir);
  const adminState: AdminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };

  const admin = new Admin(adminState, workspaceManager);
  const message = admin.createInitialMessage("test-thread");

  assertExists(message);
  assertEquals(typeof message.content, "string");
  assertEquals(
    message.content.includes("Codex Code Bot スレッドが開始されました"),
    true,
  );
  assertEquals(Array.isArray(message.components), true);
});

Deno.test("Admin - レートリミットメッセージの作成", () => {
  const tempDir = "dummy"; // このテストではファイルシステムを使用しない
  const workspaceManager = new WorkspaceManager(tempDir);
  const adminState: AdminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };

  const admin = new Admin(adminState, workspaceManager);
  const timestamp = Math.floor(Date.now() / 1000);
  const message = admin.createRateLimitMessage("test-thread", timestamp);

  assertEquals(typeof message, "string");
  assertEquals(
    message.includes("Codex Codeのレートリミットに達しました"),
    true,
  );
  assertEquals(message.includes("制限解除予定時刻"), true);
});

Deno.test("Admin - fromStateメソッド", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    // nullの状態から作成
    const admin1 = Admin.fromState(null, workspaceManager);
    assertExists(admin1);

    // 既存の状態から作成
    const existingState: AdminState = {
      activeThreadIds: ["thread-1", "thread-2"],
      lastUpdated: new Date().toISOString(),
    };
    const admin2 = Admin.fromState(existingState, workspaceManager);
    assertExists(admin2);

    // 状態を保存して確認
    await admin2.save();
    const savedState = await workspaceManager.loadAdminState();
    assertExists(savedState);
    assertEquals(savedState.activeThreadIds.length, 2);
    assertEquals(savedState.activeThreadIds[0], "thread-1");
    assertEquals(savedState.activeThreadIds[1], "thread-2");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - Codex Code実行の中断", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "test-thread-stop-execution";

    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk());
    const worker = workerResult.value;

    // Workerのメソッドをモック
    let stopExecutionCalled = false;
    worker.stopExecution = async () => {
      stopExecutionCalled = true;
      return true;
    };

    // 実行中断を呼び出す
    const stopResult = await admin.stopExecution(threadId);
    assert(stopResult.isOk());
    assertEquals(stopExecutionCalled, true);

    // 監査ログの検証は、listAuditLogsメソッドが実装されていないため、
    // 現時点ではスキップ
    // TODO: WorkspaceManagerにlistAuditLogsメソッドを実装後、以下のコメントを解除
    // const auditLogs = await workspaceManager.listAuditLogs();
    // const stopLog = auditLogs.find(
    //   (log: AuditEntry) => log.action === "worker_stopped" && log.threadId === threadId,
    // );
    // assertExists(stopLog);
    // assertEquals(stopLog.details.workerName, worker.getName());
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - 存在しないスレッドの実行中断", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "non-existent-thread";

    // 存在しないスレッドの実行中断を試みる
    const stopResult = await admin.stopExecution(threadId);
    assert(stopResult.isErr());
    assertEquals(stopResult.error.type, "WORKER_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Admin - 実行中でないWorkerの中断", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    const admin = new Admin(adminState, workspaceManager);
    const threadId = "test-thread-not-executing";

    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk());
    const worker = workerResult.value;

    // Workerのメソッドをモック（実行中でない状態を返す）
    worker.stopExecution = async () => {
      return false; // 実行中でない
    };

    // 実行中断を呼び出す
    const stopResult = await admin.stopExecution(threadId);
    assert(stopResult.isOk()); // 実行中でなくても成功として扱う
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
