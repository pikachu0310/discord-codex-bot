import { err, ok, Result } from "neverthrow";
import { generateWorkerName } from "../worker-name-generator.ts";
import { Worker } from "../worker/worker.ts";
import type { IWorker } from "../worker/types.ts";
import type { ThreadInfo, WorkerState } from "../workspace/workspace.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";

export type WorkerManagerError =
  | { type: "WORKER_CREATE_FAILED"; threadId: string; reason: string }
  | { type: "WORKER_FORK_FAILED"; threadId: string; reason: string }
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

  async createForkedWorker(
    sourceThreadId: string,
    targetThreadId: string,
    codexThreadId: string,
    worktreePath: string,
  ): Promise<Result<IWorker, WorkerManagerError>> {
    const existing = this.workers.get(targetThreadId);
    if (existing) return ok(existing);

    const sourceState = await this.workspaceManager.loadWorkerState(
      sourceThreadId,
    );
    if (!sourceState) {
      return err({
        type: "WORKER_FORK_FAILED",
        threadId: targetThreadId,
        reason: `source worker not found: ${sourceThreadId}`,
      });
    }

    if (!sourceState.repository || !sourceState.repositoryLocalPath) {
      return err({
        type: "WORKER_FORK_FAILED",
        threadId: targetThreadId,
        reason: "source worker repository is not set",
      });
    }

    const now = new Date().toISOString();
    const state: WorkerState = {
      workerName: generateWorkerName(),
      threadId: targetThreadId,
      repository: sourceState.repository,
      repositoryLocalPath: sourceState.repositoryLocalPath,
      worktreePath,
      sessionId: codexThreadId,
      forkedFromThreadId: sourceThreadId,
      forkedFromSessionId: sourceState.sessionId ?? null,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      isPlanMode: sourceState.isPlanMode,
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
        type: "WORKER_FORK_FAILED",
        threadId: targetThreadId,
        reason: saved.error.type,
      });
    }

    const threadInfo: ThreadInfo = {
      threadId: targetThreadId,
      repositoryFullName: sourceState.repository.fullName,
      repositoryLocalPath: sourceState.repositoryLocalPath,
      worktreePath,
      firstUserMessageReceivedAt: null,
      autoRenamedByFirstMessage: false,
      createdAt: now,
      lastActiveAt: now,
      status: "active",
    };

    try {
      await this.workspaceManager.saveThreadInfo(threadInfo);
    } catch (error) {
      return err({
        type: "WORKER_FORK_FAILED",
        threadId: targetThreadId,
        reason: (error as Error).message,
      });
    }

    this.workers.set(targetThreadId, worker);
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
