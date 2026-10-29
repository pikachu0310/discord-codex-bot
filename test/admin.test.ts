import { assertEquals } from "std/assert/mod.ts";
import { Admin } from "../src/admin/admin.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";

Deno.test("Admin: active thread ids は内部状態のコピーを返す", () => {
  const admin = Admin.fromState(
    {
      activeThreadIds: ["thread-1", "thread-2"],
      lastUpdated: new Date().toISOString(),
    },
    new WorkspaceManager("."),
  );

  const ids = admin.getActiveThreadIds();
  ids.push("thread-3");

  assertEquals(admin.getActiveThreadIds(), ["thread-1", "thread-2"]);
});

Deno.test("Admin: closeは実行終了を待ってから作業コピーを削除する", async () => {
  const events: string[] = [];
  const workspace = new WorkspaceManager(".");
  workspace.removeWorktree = async () => {
    events.push("remove");
  };
  workspace.loadWorkerState = async () => null;
  workspace.loadThreadInfo = async () => null;
  workspace.saveAdminState = async () => {};
  workspace.appendAuditLog = async () => {};
  const admin = Admin.fromState(null, workspace);
  const internals = admin as unknown as {
    workerManager: {
      removeWorker: () => { stopExecution: () => Promise<boolean> };
    };
  };
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => release = resolve);
  internals.workerManager.removeWorker = () => ({
    async stopExecution() {
      events.push("stop");
      await stopped;
      events.push("stopped");
      return true;
    },
  });
  const closing = admin.closeThread("thread-1");
  await Promise.resolve();
  assertEquals(events, ["stop"]);
  release();
  assertEquals((await closing).isOk(), true);
  assertEquals(events, ["stop", "stopped", "remove"]);
});
