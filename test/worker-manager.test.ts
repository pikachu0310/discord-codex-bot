import { assertEquals, assertExists } from "std/assert/mod.ts";
import { WorkerManager } from "../src/admin/worker-manager.ts";
import {
  type WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";

async function createTestWorkspace(prefix: string): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}

Deno.test("WorkerManager: forked workerの状態とthread infoを保存する", async () => {
  const baseDir = await createTestWorkspace("worker_manager_test_");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const now = new Date().toISOString();
    const sourceState: WorkerState = {
      workerName: "source-worker",
      threadId: "source-thread",
      repository: {
        fullName: "owner/repo",
        org: "owner",
        repo: "repo",
      },
      repositoryLocalPath: "/tmp/repositories/owner/repo",
      worktreePath: "/tmp/worktrees/source-thread",
      sessionId: "source-codex-thread",
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      isPlanMode: true,
    };
    await workspaceManager.saveWorkerState(sourceState);

    const workerManager = new WorkerManager(workspaceManager);
    const result = await workerManager.createForkedWorker(
      "source-thread",
      "target-thread",
      "fork-codex-thread",
      "/tmp/worktrees/target-thread",
    );

    assertEquals(result.isOk(), true);
    const targetState = await workspaceManager.loadWorkerState(
      "target-thread",
    );
    assertExists(targetState);
    assertEquals(targetState.repository?.fullName, "owner/repo");
    assertEquals(
      targetState.repositoryLocalPath,
      "/tmp/repositories/owner/repo",
    );
    assertEquals(targetState.worktreePath, "/tmp/worktrees/target-thread");
    assertEquals(targetState.sessionId, "fork-codex-thread");
    assertEquals(targetState.forkedFromThreadId, "source-thread");
    assertEquals(targetState.forkedFromSessionId, "source-codex-thread");
    assertEquals(targetState.isPlanMode, true);

    const threadInfo = await workspaceManager.loadThreadInfo("target-thread");
    assertExists(threadInfo);
    assertEquals(threadInfo.repositoryFullName, "owner/repo");
    assertEquals(threadInfo.worktreePath, "/tmp/worktrees/target-thread");
    assertEquals(threadInfo.status, "active");
    assertEquals(threadInfo.firstUserMessageReceivedAt, null);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("WorkerManager: source workerが無いforkは失敗する", async () => {
  const baseDir = await createTestWorkspace("worker_manager_test_");
  try {
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();
    const workerManager = new WorkerManager(workspaceManager);

    const result = await workerManager.createForkedWorker(
      "missing-thread",
      "target-thread",
      "fork-codex-thread",
      "/tmp/worktrees/target-thread",
    );

    assertEquals(result.isErr(), true);
    const error = result._unsafeUnwrapErr();
    assertEquals(error.type, "WORKER_FORK_FAILED");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
