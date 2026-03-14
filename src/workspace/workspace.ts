import { join } from "std/path/mod.ts";
import { ensureDir } from "std/fs/mod.ts";
import { ThreadManager } from "./thread-manager.ts";
import { SessionManager } from "./session-manager.ts";
import { AuditLogger } from "./audit-logger.ts";
import { PatManager } from "./pat-manager.ts";
import { QueueManager } from "./queue-manager.ts";
import {
  validateAdminStateSafe,
  validateWorkerStateSafe,
} from "./schemas/admin-schema.ts";

export interface WorkspaceConfig {
  baseDir: string;
  repositoriesDir: string;
  threadsDir: string;
  sessionsDir: string;
  auditDir: string;
  worktreesDir: string;
  patsDir: string;
  queuedMessagesDir: string;
  adminDir: string;
  workersDir: string;
}

export interface ThreadInfo {
  threadId: string;
  repositoryFullName: string | null;
  repositoryLocalPath: string | null;
  worktreePath: string | null;
  createdAt: string;
  lastActiveAt: string;
  status: "active" | "inactive" | "archived";
}

export interface AuditEntry {
  timestamp: string;
  threadId: string;
  action: string;
  details: Record<string, unknown>;
}

export interface RepositoryPatInfo {
  repositoryFullName: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
}

export interface QueuedMessage {
  messageId: string;
  content: string;
  timestamp: number;
  authorId: string;
}

export interface ThreadQueue {
  threadId: string;
  messages: QueuedMessage[];
}

export interface AdminState {
  activeThreadIds: string[];
  lastUpdated: string;
}

export interface WorkerState {
  workerName: string;
  threadId: string;
  threadName?: string;
  repository?: {
    fullName: string;
    org: string;
    repo: string;
  };
  repositoryLocalPath?: string;
  worktreePath?: string | null;
  devcontainerConfig: {
    useDevcontainer: boolean;
    useFallbackDevcontainer: boolean;
    hasDevcontainerFile: boolean;
    hasAnthropicsFeature: boolean;
    containerId?: string;
    isStarted: boolean;
  };
  sessionId?: string | null;
  status: "active" | "inactive" | "archived";
  rateLimitTimestamp?: number;
  autoResumeAfterRateLimit?: boolean;
  queuedMessages?: QueuedMessage[];
  createdAt: string;
  lastActiveAt: string;
  isPlanMode?: boolean;
}

export class WorkspaceManager {
  private readonly config: WorkspaceConfig;
  private readonly threadManager: ThreadManager;
  private readonly sessionManager: SessionManager;
  private readonly auditLogger: AuditLogger;
  private readonly patManager: PatManager;
  private readonly queueManager: QueueManager;

  constructor(baseDir: string) {
    this.config = {
      baseDir,
      repositoriesDir: join(baseDir, "repositories"),
      threadsDir: join(baseDir, "threads"),
      sessionsDir: join(baseDir, "sessions"),
      auditDir: join(baseDir, "audit"),
      worktreesDir: join(baseDir, "worktrees"),
      patsDir: join(baseDir, "pats"),
      queuedMessagesDir: join(baseDir, "queued_messages"),
      adminDir: join(baseDir, "admin"),
      workersDir: join(baseDir, "workers"),
    };

    // Initialize manager instances
    this.threadManager = new ThreadManager(baseDir);
    this.sessionManager = new SessionManager(baseDir);
    this.auditLogger = new AuditLogger(baseDir);
    this.patManager = new PatManager(baseDir);
    this.queueManager = new QueueManager(baseDir);
  }

  async initialize(): Promise<void> {
    // Initialize base directories
    await ensureDir(this.config.repositoriesDir);
    await ensureDir(this.config.adminDir);
    await ensureDir(this.config.workersDir);

    // Initialize all managers
    const threadInitResult = await this.threadManager.initialize();
    if (threadInitResult.isErr()) {
      throw new Error(
        `ThreadManagerの初期化に失敗しました: ${
          "error" in threadInitResult.error
            ? threadInitResult.error.error
            : JSON.stringify(threadInitResult.error)
        }`,
      );
    }
    const sessionInitResult = await this.sessionManager.initialize();
    if (sessionInitResult.isErr()) {
      throw new Error(
        `SessionManagerの初期化に失敗しました: ${
          "error" in sessionInitResult.error
            ? sessionInitResult.error.error
            : JSON.stringify(sessionInitResult.error)
        }`,
      );
    }
    const auditInitResult = await this.auditLogger.initialize();
    if (auditInitResult.isErr()) {
      throw new Error(
        `AuditLoggerの初期化に失敗しました: ${
          "error" in auditInitResult.error
            ? auditInitResult.error.error
            : JSON.stringify(auditInitResult.error)
        }`,
      );
    }
    const patInitResult = await this.patManager.initialize();
    if (patInitResult.isErr()) {
      throw new Error(
        `PatManagerの初期化に失敗しました: ${
          "error" in patInitResult.error
            ? patInitResult.error.error
            : JSON.stringify(patInitResult.error)
        }`,
      );
    }
    await this.queueManager.initialize();
  }

  getRepositoriesDir(): string {
    return this.config.repositoriesDir;
  }

  getBaseDir(): string {
    return this.config.baseDir;
  }

  getRepositoryPath(org: string, repo: string): string {
    return join(this.config.repositoriesDir, org, repo);
  }

  getWorktreePath(threadId: string): string {
    return this.threadManager.getWorktreePath(threadId);
  }

  // Private path methods removed - now handled by individual managers

  async saveThreadInfo(threadInfo: ThreadInfo): Promise<void> {
    const result = await this.threadManager.saveThreadInfo(threadInfo);
    if (result.isErr()) {
      throw new Error(
        `スレッド情報の保存に失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
  }

  async loadThreadInfo(threadId: string): Promise<ThreadInfo | null> {
    const result = await this.threadManager.loadThreadInfo(threadId);
    if (result.isErr()) {
      throw new Error(
        `スレッド情報の読み込みに失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
    return result.value;
  }

  async updateThreadLastActive(threadId: string): Promise<void> {
    const result = await this.threadManager.updateThreadLastActive(threadId);
    if (result.isErr()) {
      throw new Error(
        `最終アクティブ時刻の更新に失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
  }

  async appendAuditLog(auditEntry: AuditEntry): Promise<void> {
    const result = await this.auditLogger.appendAuditLog(auditEntry);
    if (result.isErr()) {
      // 監査ログの失敗は運用に影響を与えないため、エラーログのみ出力
      console.error("監査ログの記録に失敗しました:", result.error);
    }
  }

  async saveRawSessionJsonl(
    repositoryFullName: string,
    sessionId: string,
    rawJsonlContent: string,
  ): Promise<void> {
    await this.sessionManager.saveRawSessionJsonl(
      repositoryFullName,
      sessionId,
      rawJsonlContent,
    );
  }

  async getAllThreadInfos(): Promise<ThreadInfo[]> {
    const result = await this.threadManager.getAllThreadInfos();
    if (result.isErr()) {
      throw new Error(
        `スレッド情報の一覧取得に失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
    return result.value;
  }

  async ensureWorktree(
    threadId: string,
    repositoryPath: string,
  ): Promise<string> {
    // workerNameを取得
    const workerState = await this.loadWorkerState(threadId);
    const workerName = workerState?.workerName || threadId;

    const result = await this.threadManager.ensureWorktree(
      threadId,
      repositoryPath,
      workerName,
    );
    if (result.isErr()) {
      throw new Error(
        `worktreeの作成に失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
    return result.value;
  }

  async removeWorktree(threadId: string): Promise<void> {
    const result = await this.threadManager.removeWorktree(threadId);
    if (result.isErr()) {
      throw new Error(
        `worktreeの削除に失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
  }

  async cleanupWorktree(threadId: string): Promise<void> {
    const result = await this.threadManager.cleanupWorktree(threadId);
    if (result.isErr()) {
      throw new Error(
        `worktreeのクリーンアップに失敗しました: ${
          "error" in result.error
            ? result.error.error
            : JSON.stringify(result.error)
        }`,
      );
    }
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  async getLocalRepositories(): Promise<string[]> {
    try {
      const repositories: string[] = [];

      for await (const orgEntry of Deno.readDir(this.config.repositoriesDir)) {
        if (orgEntry.isDirectory) {
          const orgPath = join(this.config.repositoriesDir, orgEntry.name);

          try {
            for await (const repoEntry of Deno.readDir(orgPath)) {
              if (repoEntry.isDirectory) {
                repositories.push(`${orgEntry.name}/${repoEntry.name}`);
              }
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
              console.warn(
                `リポジトリディレクトリの読み取りに失敗しました (${orgPath}): ${error}`,
              );
            }
          }
        }
      }

      return repositories.sort();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  }

  // PAT file path method removed - now handled by PatManager

  async saveRepositoryPat(patInfo: RepositoryPatInfo): Promise<void> {
    await this.patManager.saveRepositoryPat(patInfo);

    // 監査ログに記録
    try {
      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        threadId: "system",
        action: "save_repository_pat",
        details: {
          repository: patInfo.repositoryFullName,
          description: patInfo.description,
        },
      });
    } catch (error) {
      console.error("監査ログの記録に失敗しました:", error);
      // 監査ログの失敗は主要操作に影響を与えないようにする
    }
  }

  async loadRepositoryPat(
    repositoryFullName: string,
  ): Promise<RepositoryPatInfo | null> {
    const result = await this.patManager.loadRepositoryPat(repositoryFullName);
    if (result.isErr()) {
      const error = result.error;
      if (error.type === "PAT_NOT_FOUND") {
        throw new Error(
          `PAT not found for repository: ${error.repositoryFullName}`,
        );
      }
      throw new Error(`Failed to load PAT: ${JSON.stringify(error)}`);
    }
    return result.value;
  }

  async deleteRepositoryPat(repositoryFullName: string): Promise<void> {
    const result = await this.patManager.deleteRepositoryPat(
      repositoryFullName,
    );
    if (result.isErr()) {
      const error = result.error;
      if ("error" in error) {
        throw new Error(`Failed to delete PAT: ${error.error}`);
      }
      throw new Error(`Failed to delete PAT: ${JSON.stringify(error)}`);
    }

    // 監査ログに記録
    try {
      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        threadId: "system",
        action: "delete_repository_pat",
        details: {
          repository: repositoryFullName,
        },
      });
    } catch (error) {
      console.error("監査ログの記録に失敗しました:", error);
      // 監査ログの失敗は主要操作に影響を与えないようにする
    }
  }

  async listRepositoryPats(): Promise<RepositoryPatInfo[]> {
    const result = await this.patManager.listRepositoryPats();
    if (result.isErr()) {
      const error = result.error;
      if ("error" in error) {
        throw new Error(`Failed to list PATs: ${error.error}`);
      }
      throw new Error(`Failed to list PATs: ${JSON.stringify(error)}`);
    }
    return result.value;
  }

  // Queue file path method removed - now handled by QueueManager

  async saveMessageQueue(threadQueue: ThreadQueue): Promise<void> {
    const result = await this.queueManager.saveMessageQueue(threadQueue);
    if (result.isErr()) {
      throw new Error(
        `Failed to save message queue: ${JSON.stringify(result.error)}`,
      );
    }
  }

  async loadMessageQueue(threadId: string): Promise<ThreadQueue | null> {
    const result = await this.queueManager.loadMessageQueue(threadId);
    if (result.isErr()) {
      throw new Error(
        `Failed to load message queue: ${JSON.stringify(result.error)}`,
      );
    }
    return result.value;
  }

  async addMessageToQueue(
    threadId: string,
    message: QueuedMessage,
  ): Promise<void> {
    const result = await this.queueManager.addMessageToQueue(threadId, message);
    if (result.isErr()) {
      throw new Error(
        `Failed to add message to queue: ${JSON.stringify(result.error)}`,
      );
    }

    // 監査ログに記録
    try {
      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        threadId,
        action: "message_queued",
        details: {
          messageId: message.messageId,
          authorId: message.authorId,
        },
      });
    } catch (error) {
      console.error("監査ログの記録に失敗しました:", error);
      // 監査ログの失敗は主要操作に影響を与えないようにする
    }
  }

  async getAndClearMessageQueue(threadId: string): Promise<QueuedMessage[]> {
    const result = await this.queueManager.getAndClearMessageQueue(threadId);
    if (result.isErr()) {
      throw new Error(
        `Failed to get and clear message queue: ${
          JSON.stringify(result.error)
        }`,
      );
    }

    const messages = result.value;

    // 監査ログに記録
    if (messages.length > 0) {
      try {
        await this.appendAuditLog({
          timestamp: new Date().toISOString(),
          threadId,
          action: "message_queue_cleared",
          details: {
            messageCount: messages.length,
          },
        });
      } catch (error) {
        console.error("監査ログの記録に失敗しました:", error);
        // 監査ログの失敗は主要操作に影響を与えないようにする
      }
    }

    return messages;
  }

  async deleteMessageQueue(threadId: string): Promise<void> {
    await this.queueManager.deleteMessageQueue(threadId);
  }

  // Admin State Management
  private getAdminStateFilePath(): string {
    return join(this.config.adminDir, "active_threads.json");
  }

  async saveAdminState(adminState: AdminState): Promise<void> {
    const filePath = this.getAdminStateFilePath();
    adminState.lastUpdated = new Date().toISOString();
    await Deno.writeTextFile(filePath, JSON.stringify(adminState, null, 2));
  }

  async loadAdminState(): Promise<AdminState | null> {
    try {
      const filePath = this.getAdminStateFilePath();
      const content = await Deno.readTextFile(filePath);
      const parsed = JSON.parse(content);
      const result = validateAdminStateSafe(parsed);

      if (!result.success) {
        console.error(`Admin state validation failed: ${result.error.message}`);
        // バックワードコンパチビリティのため、最小限の修復を試みる
        if (parsed && typeof parsed === "object") {
          const repaired: AdminState = {
            activeThreadIds: Array.isArray(parsed.activeThreadIds)
              ? parsed.activeThreadIds.filter((id: unknown) =>
                typeof id === "string"
              )
              : [],
            lastUpdated: typeof parsed.lastUpdated === "string"
              ? parsed.lastUpdated
              : new Date().toISOString(),
          };
          return repaired;
        }
        return null;
      }

      return result.data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async addActiveThread(threadId: string): Promise<void> {
    let adminState = await this.loadAdminState();
    if (!adminState) {
      adminState = {
        activeThreadIds: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    if (!adminState.activeThreadIds.includes(threadId)) {
      adminState.activeThreadIds.push(threadId);
      await this.saveAdminState(adminState);
    }
  }

  async removeActiveThread(threadId: string): Promise<void> {
    const adminState = await this.loadAdminState();
    if (adminState) {
      adminState.activeThreadIds = adminState.activeThreadIds.filter(
        (id) => id !== threadId,
      );
      await this.saveAdminState(adminState);
    }
  }

  // Worker State Management
  private getWorkerStateFilePath(threadId: string): string {
    return join(this.config.workersDir, `${threadId}.json`);
  }

  async saveWorkerState(workerState: WorkerState): Promise<void> {
    const filePath = this.getWorkerStateFilePath(workerState.threadId);
    workerState.lastActiveAt = new Date().toISOString();
    await Deno.writeTextFile(filePath, JSON.stringify(workerState, null, 2));
  }

  async loadWorkerState(threadId: string): Promise<WorkerState | null> {
    try {
      const filePath = this.getWorkerStateFilePath(threadId);
      const content = await Deno.readTextFile(filePath);
      const parsed = JSON.parse(content);
      const result = validateWorkerStateSafe(parsed);

      if (!result.success) {
        console.error(
          `Worker state validation failed for thread ${threadId}: ${result.error.message}`,
        );
        // バックワードコンパチビリティのため、最小限の修復を試みる
        if (parsed && typeof parsed === "object") {
          const now = new Date().toISOString();
          const repaired: WorkerState = {
            workerName: parsed.workerName || `worker-${threadId}`,
            threadId: parsed.threadId || threadId,
            threadName: parsed.threadName,
            repository: parsed.repository,
            repositoryLocalPath: parsed.repositoryLocalPath,
            worktreePath: parsed.worktreePath,
            devcontainerConfig: {
              useDevcontainer: parsed.devcontainerConfig?.useDevcontainer ??
                false,
              useFallbackDevcontainer:
                parsed.devcontainerConfig?.useFallbackDevcontainer ?? false,
              hasDevcontainerFile:
                parsed.devcontainerConfig?.hasDevcontainerFile ?? false,
              hasAnthropicsFeature:
                parsed.devcontainerConfig?.hasAnthropicsFeature ?? false,
              containerId: parsed.devcontainerConfig?.containerId,
              isStarted: parsed.devcontainerConfig?.isStarted ?? false,
            },
            sessionId: parsed.sessionId,
            status: parsed.status || "active",
            rateLimitTimestamp: parsed.rateLimitTimestamp,
            autoResumeAfterRateLimit: parsed.autoResumeAfterRateLimit,
            queuedMessages: parsed.queuedMessages,
            createdAt: parsed.createdAt || now,
            lastActiveAt: parsed.lastActiveAt || now,
          };
          return repaired;
        }
        return null;
      }

      return result.data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async deleteWorkerState(threadId: string): Promise<void> {
    const filePath = this.getWorkerStateFilePath(threadId);
    try {
      await Deno.remove(filePath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  async getAllWorkerStates(): Promise<WorkerState[]> {
    try {
      const workerStates: WorkerState[] = [];

      for await (const entry of Deno.readDir(this.config.workersDir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const threadId = entry.name.replace(".json", "");
          const workerState = await this.loadWorkerState(threadId);
          if (workerState) {
            workerStates.push(workerState);
          }
        }
      }

      return workerStates.sort((a, b) =>
        b.lastActiveAt.localeCompare(a.lastActiveAt)
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }
  }
}
