import { assertEquals } from "std/assert/mod.ts";
import { err } from "neverthrow";
import { MessageRouter } from "../src/admin/message-router.ts";
import type { WorkerManager } from "../src/admin/worker-manager.ts";
import type { IWorker, WorkerError } from "../src/worker/types.ts";

function createRouter(error: WorkerError): MessageRouter {
  const worker: IWorker = {
    processMessage: () => Promise.resolve(err(error)),
    getName: () => "test-worker",
    getRepository: () => null,
    setRepository: () => {
      throw new Error("not implemented");
    },
    save: () => {
      throw new Error("not implemented");
    },
    stopExecution: () => Promise.resolve(false),
    getModelPreset: () => "sol-xhigh",
    setModelPreset: () => {
      throw new Error("not implemented");
    },
    isPlanMode: () => false,
    setPlanMode: () => {},
  };

  const workerManager = {
    getWorker: () => worker,
  } as unknown as WorkerManager;

  return new MessageRouter(workerManager);
}

function createRejectingRouter(error: unknown): MessageRouter {
  const worker: IWorker = {
    processMessage: () => Promise.reject(error),
    getName: () => "test-worker",
    getRepository: () => null,
    setRepository: () => {
      throw new Error("not implemented");
    },
    save: () => {
      throw new Error("not implemented");
    },
    stopExecution: () => Promise.resolve(false),
    getModelPreset: () => "sol-xhigh",
    setModelPreset: () => {
      throw new Error("not implemented");
    },
    isPlanMode: () => false,
    setPlanMode: () => {},
  };

  const workerManager = {
    getWorker: () => worker,
  } as unknown as WorkerManager;

  return new MessageRouter(workerManager);
}

Deno.test("MessageRouter: Codex実行エラーの種別と詳細を保持する", async () => {
  const router = createRouter({
    type: "CODEX_EXECUTION_FAILED",
    error: "context length exceeded",
  });

  const result = await router.routeMessage("thread-1", "依頼");

  assertEquals(result.isErr(), true);
  const error = result._unsafeUnwrapErr();
  assertEquals(error.type, "MESSAGE_PROCESSING_ERROR");
  if (error.type === "MESSAGE_PROCESSING_ERROR") {
    assertEquals(error.workerErrorType, "CODEX_EXECUTION_FAILED");
    assertEquals(error.error, "context length exceeded");
  }
});

Deno.test("MessageRouter: workspaceエラーの操作名と詳細を保持する", async () => {
  const router = createRouter({
    type: "WORKSPACE_ERROR",
    operation: "saveWorkerState",
    error: "Permission denied",
  });

  const result = await router.routeMessage("thread-1", "依頼");

  assertEquals(result.isErr(), true);
  const error = result._unsafeUnwrapErr();
  assertEquals(error.type, "MESSAGE_PROCESSING_ERROR");
  if (error.type === "MESSAGE_PROCESSING_ERROR") {
    assertEquals(error.workerErrorType, "WORKSPACE_ERROR");
    assertEquals(error.error, "saveWorkerState: Permission denied");
  }
});

Deno.test("MessageRouter: Workerがrejectしても例外を外へ漏らさない", async () => {
  const router = createRejectingRouter(new Error("temporary codex failure"));

  const result = await router.routeMessage("thread-1", "依頼");

  assertEquals(result.isErr(), true);
  const error = result._unsafeUnwrapErr();
  assertEquals(error.type, "MESSAGE_PROCESSING_ERROR");
  if (error.type === "MESSAGE_PROCESSING_ERROR") {
    assertEquals(error.workerErrorType, "CODEX_EXECUTION_FAILED");
    assertEquals(error.error.includes("temporary codex failure"), true);
  }
});
