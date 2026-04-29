import { err, ok, Result } from "neverthrow";
import type { SavedAttachment } from "../attachments.ts";
import type { IWorker } from "../worker/types.ts";
import type { AdminError, DiscordMessage, IAdmin } from "./types.ts";
import {
  type AdminState,
  type AuditEntry,
  WorkspaceManager,
} from "../workspace/workspace.ts";
import { WorkerManager } from "./worker-manager.ts";
import { MessageRouter } from "./message-router.ts";
import { RateLimitManager } from "./rate-limit-manager.ts";

export class Admin implements IAdmin {
  private readonly workerManager: WorkerManager;
  private readonly rateLimitManager: RateLimitManager;
  private readonly messageRouter: MessageRouter;
  private onThreadClose?: (threadId: string) => Promise<void>;

  constructor(
    private state: AdminState,
    private readonly workspaceManager: WorkspaceManager,
    appendSystemPrompt?: string,
  ) {
    this.rateLimitManager = new RateLimitManager();
    this.workerManager = new WorkerManager(
      workspaceManager,
      appendSystemPrompt,
    );
    this.messageRouter = new MessageRouter(this.workerManager);
  }

  static fromState(
    adminState: AdminState | null,
    workspaceManager: WorkspaceManager,
    appendSystemPrompt?: string,
  ): Admin {
    return new Admin(
      adminState ?? {
        activeThreadIds: [],
        lastUpdated: new Date().toISOString(),
      },
      workspaceManager,
      appendSystemPrompt,
    );
  }

  async restoreActiveThreads(): Promise<Result<void, AdminError>> {
    for (const threadId of [...this.state.activeThreadIds]) {
      const threadInfo = await this.workspaceManager.loadThreadInfo(threadId);
      if (!threadInfo || threadInfo.status === "archived") {
        await this.removeActiveThread(threadId);
        continue;
      }
      const restored = await this.workerManager.restoreThread(threadInfo);
      if (restored.isErr()) {
        console.error("[Admin] thread restore failed", restored.error);
      }
    }
    return ok(undefined);
  }

  async createWorker(threadId: string): Promise<Result<IWorker, AdminError>> {
    const result = await this.workerManager.createWorker(threadId);
    if (result.isErr()) {
      const reason = result.error.type === "WORKER_CREATE_FAILED"
        ? result.error.reason
        : result.error.error;
      return err({
        type: "WORKER_CREATE_FAILED",
        threadId,
        reason,
      });
    }
    await this.addActiveThread(threadId);
    await this.logAudit(threadId, "worker_created", {
      workerName: result.value.getName(),
    });
    return ok(result.value);
  }

  getWorker(threadId: string): Result<IWorker, AdminError> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return err({ type: "WORKER_NOT_FOUND", threadId });
    }
    return ok(worker);
  }

  async routeMessage(
    threadId: string,
    message: string,
    attachments: readonly SavedAttachment[] = [],
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<Result<string | DiscordMessage, AdminError>> {
    const result = await this.messageRouter.routeMessage(
      threadId,
      message,
      attachments,
      onProgress,
      onReaction,
    );
    if (result.isErr()) {
      if (result.error.type === "WORKER_NOT_FOUND") {
        return err({ type: "WORKER_NOT_FOUND", threadId });
      }
      if (result.error.type === "RATE_LIMIT_ERROR") {
        return err({
          type: "RATE_LIMIT",
          timestamp: result.error.timestamp,
          retryAt: result.error.timestamp,
          message: result.error.message,
        });
      }
      return err({
        type: "WORKSPACE_ERROR",
        operation: "routeMessage",
        error: result.error.error,
      });
    }
    return ok(result.value);
  }

  async stopExecution(threadId: string): Promise<Result<void, AdminError>> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return err({ type: "WORKER_NOT_FOUND", threadId });
    }
    await worker.stopExecution();
    await this.logAudit(threadId, "worker_stopped", {});
    return ok(undefined);
  }

  async setPlanMode(
    threadId: string,
    planMode: boolean,
  ): Promise<Result<void, AdminError>> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return err({ type: "WORKER_NOT_FOUND", threadId });
    }
    worker.setPlanMode(planMode);
    const saved = await worker.save();
    if (saved.isErr()) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "saveWorkerState",
        error: saved.error.type,
      });
    }
    await this.logAudit(threadId, "plan_mode_changed", { planMode });
    return ok(undefined);
  }

  async terminateThread(threadId: string): Promise<Result<void, AdminError>> {
    this.workerManager.removeWorker(threadId);
    await this.workspaceManager.removeWorktree(threadId);

    const workerState = await this.workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      workerState.status = "archived";
      await this.workspaceManager.saveWorkerState(workerState);
    }
    const threadInfo = await this.workspaceManager.loadThreadInfo(threadId);
    if (threadInfo) {
      threadInfo.status = "archived";
      await this.workspaceManager.saveThreadInfo(threadInfo);
    }
    await this.removeActiveThread(threadId);

    if (this.onThreadClose) {
      await this.onThreadClose(threadId).catch(() => {});
    }

    await this.logAudit(threadId, "thread_terminated", {});
    return ok(undefined);
  }

  async closeThread(threadId: string): Promise<Result<void, AdminError>> {
    return await this.terminateThread(threadId);
  }

  setThreadCloseCallback(callback: (threadId: string) => Promise<void>): void {
    this.onThreadClose = callback;
  }

  createRateLimitMessage(): string {
    return this.rateLimitManager.createRateLimitMessage();
  }

  private async addActiveThread(threadId: string): Promise<void> {
    if (!this.state.activeThreadIds.includes(threadId)) {
      this.state.activeThreadIds.push(threadId);
      await this.saveState();
    }
  }

  private async removeActiveThread(threadId: string): Promise<void> {
    this.state.activeThreadIds = this.state.activeThreadIds.filter((id) =>
      id !== threadId
    );
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    await this.workspaceManager.saveAdminState(this.state);
  }

  private async logAudit(
    threadId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      threadId,
      action,
      details,
    };
    await this.workspaceManager.appendAuditLog(entry);
  }
}
