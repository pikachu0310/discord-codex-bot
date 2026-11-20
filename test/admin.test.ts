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
      removeWorker: () => { stopExecution: () => Promise<boolean> } | null;
    };
  };
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => release = resolve);
  const worker = {
    async stopExecution() {
      events.push("stop");
      await stopped;
      events.push("stopped");
      return true;
    },
  };
  let removed = false;
  internals.workerManager.removeWorker = () => {
    if (removed) return null;
    removed = true;
    return worker;
  };
  const closing = admin.closeThread("thread-1");
  const archived = admin.terminateThread("thread-1");
  await Promise.resolve();
  assertEquals(events, ["stop"]);
  release();
  assertEquals((await closing).isOk(), true);
  assertEquals((await archived).isOk(), true);
  assertEquals(events, ["stop", "stopped", "remove"]);
});

Deno.test("Admin: Botの管理外スレッドはcloseの対象にしない", async () => {
  const manager = new WorkspaceManager(".");
  manager.loadThreadInfo = async () => null;
  const operations: string[] = [];
  manager.removeWorktree = async () => {
    operations.push("remove");
  };
  manager.loadWorkerState = async () => null;
  manager.saveAdminState = async () => {
    operations.push("save");
  };
  manager.appendAuditLog = async () => {
    operations.push("audit");
  };
  const admin = Admin.fromState(null, manager);
  assertEquals((await admin.closeThread("unmanaged")).isErr(), true);
  assertEquals(operations, []);
});
