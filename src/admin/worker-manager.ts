import { err, ok, Result } from "neverthrow";
import { generateWorkerName } from "../worker-name-generator.ts";
import { Worker } from "../worker/worker.ts";
import type { IWorker } from "../worker/types.ts";
import type { ThreadInfo, WorkerState } from "../workspace/workspace.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";

export type WorkerManagerError =
  | { type: "WORKER_CREATE_FAILED"; threadId: string; reason: string }
  | { type: "THREAD_RESTORE_FAILED"; threadId: string; error: string };

export class WorkerManager {
  private readonly workers = new Map<string, IWorker>();

  constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly appendSystemPrompt?: string,
  ) {}

  async createWorker(
    threadId: string,
  ): Promise<Result<IWorker, WorkerManagerError>> {
    const existing = this.workers.get(threadId);
    if (existing) return ok(existing);

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: generateWorkerName(),
      threadId,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    };

    const worker = new Worker(
      state,
      this.workspaceManager,
      undefined,
      this.appendSystemPrompt,
    );
    const saved = await worker.save();
    if (saved.isErr()) {
      return err({
        type: "WORKER_CREATE_FAILED",
        threadId,
        reason: saved.error.type,
      });
    }

    const threadInfo: ThreadInfo = {
      threadId,
      repositoryFullName: null,
      repositoryLocalPath: null,
      worktreePath: null,
      firstUserMessageReceivedAt: null,
      autoRenamedByFirstMessage: false,
      createdAt: now,
      lastActiveAt: now,
      status: "active",
    };
    await this.workspaceManager.saveThreadInfo(threadInfo);
    this.workers.set(threadId, worker);
    return ok(worker);
  }

  getWorker(threadId: string): IWorker | null {
    return this.workers.get(threadId) ?? null;
  }

  removeWorker(threadId: string): IWorker | null {
    const worker = this.workers.get(threadId) ?? null;
    this.workers.delete(threadId);
    return worker;
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  async restoreThread(
    threadInfo: ThreadInfo,
  ): Promise<Result<void, WorkerManagerError>> {
    try {
      const workerState = await this.workspaceManager.loadWorkerState(
        threadInfo.threadId,
      );
      if (!workerState) {
        return ok(undefined);
      }

      const worker = await Worker.fromState(
        workerState,
        this.workspaceManager,
        this.appendSystemPrompt,
      );
      this.workers.set(threadInfo.threadId, worker);
      await this.workspaceManager.updateThreadLastActive(threadInfo.threadId);
      return ok(undefined);
    } catch (error) {
      return err({
        type: "THREAD_RESTORE_FAILED",
        threadId: threadInfo.threadId,
        error: (error as Error).message,
      });
    }
  }
}
