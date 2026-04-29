import { ensureDir } from "std/fs/mod.ts";
import { join } from "std/path/mod.ts";
import {
  type AttachmentDownloadInput,
  isCodexImageAttachment,
  sanitizeAttachmentFileName,
  type SavedAttachment,
} from "../attachments.ts";
import { createWorktreeCopy, isWorktreeCopyExists } from "../git-utils.ts";

export interface ThreadInfo {
  threadId: string;
  repositoryFullName: string | null;
  repositoryLocalPath: string | null;
  worktreePath: string | null;
  firstUserMessageReceivedAt?: string | null;
  autoRenamedByFirstMessage?: boolean;
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

export interface AdminState {
  activeThreadIds: string[];
  lastUpdated: string;
}

export interface WorkerState {
  workerName: string;
  threadId: string;
  repository?: {
    fullName: string;
    org: string;
    repo: string;
  };
  repositoryLocalPath?: string;
  worktreePath?: string | null;
  sessionId?: string | null;
  status: "active" | "inactive" | "archived";
  createdAt: string;
  lastActiveAt: string;
  isPlanMode?: boolean;
}

interface WorkspaceConfig {
  baseDir: string;
  repositoriesDir: string;
  worktreesDir: string;
  threadsDir: string;
  workersDir: string;
  adminDir: string;
  sessionsDir: string;
  auditDir: string;
  attachmentsDir: string;
}

export class WorkspaceManager {
  private readonly config: WorkspaceConfig;

  constructor(baseDir: string) {
    this.config = {
      baseDir,
      repositoriesDir: join(baseDir, "repositories"),
      worktreesDir: join(baseDir, "worktrees"),
      threadsDir: join(baseDir, "threads"),
      workersDir: join(baseDir, "workers"),
      adminDir: join(baseDir, "admin"),
      sessionsDir: join(baseDir, "sessions"),
      auditDir: join(baseDir, "audit"),
      attachmentsDir: join(baseDir, "attachments"),
    };
  }

  async initialize(): Promise<void> {
    await ensureDir(this.config.repositoriesDir);
    await ensureDir(this.config.worktreesDir);
    await ensureDir(this.config.threadsDir);
    await ensureDir(this.config.workersDir);
    await ensureDir(this.config.adminDir);
    await ensureDir(this.config.sessionsDir);
    await ensureDir(this.config.auditDir);
    await ensureDir(this.config.attachmentsDir);
  }

  getBaseDir(): string {
    return this.config.baseDir;
  }

  getRepositoriesDir(): string {
    return this.config.repositoriesDir;
  }

  getRepositoryPath(org: string, repo: string): string {
    return join(this.config.repositoriesDir, org, repo);
  }

  getWorktreePath(threadId: string): string {
    return join(this.config.worktreesDir, threadId);
  }

  getAttachmentsDir(): string {
    return this.config.attachmentsDir;
  }

  getMessageAttachmentsDir(threadId: string, messageId: string): string {
    return join(this.config.attachmentsDir, threadId, messageId);
  }

  async saveMessageAttachments(
    threadId: string,
    messageId: string,
    attachments: readonly AttachmentDownloadInput[],
  ): Promise<SavedAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const dir = this.getMessageAttachmentsDir(threadId, messageId);
    await ensureDir(dir);

    const savedAttachments: SavedAttachment[] = [];
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      const originalName = attachment.name ?? `attachment-${index + 1}`;
      const safeName = sanitizeAttachmentFileName(originalName);
      const safeId = sanitizeAttachmentFileName(attachment.id);
      const savedName = `${
        String(index + 1).padStart(3, "0")
      }_${safeId}_${safeName}`;
      const path = join(dir, savedName);

      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(
          `Attachment download failed: ${attachment.url} (${response.status})`,
        );
      }
      if (!response.body) {
        throw new Error(`Attachment response has no body: ${attachment.url}`);
      }

      await Deno.writeFile(path, response.body);

      savedAttachments.push({
        id: attachment.id,
        originalName,
        savedName,
        path,
        contentType: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
        isImage: isCodexImageAttachment(originalName, attachment.contentType),
      });
    }

    await Deno.writeTextFile(
      join(dir, "attachments.json"),
      JSON.stringify(savedAttachments, null, 2),
    );

    return savedAttachments;
  }

  async ensureWorktree(
    threadId: string,
    repositoryPath: string,
  ): Promise<string> {
    const worktreePath = this.getWorktreePath(threadId);
    if (await isWorktreeCopyExists(worktreePath)) {
      return worktreePath;
    }
    const workerState = await this.loadWorkerState(threadId);
    const workerName = workerState?.workerName ?? threadId;
    const result = await createWorktreeCopy(
      repositoryPath,
      workerName,
      worktreePath,
    );
    if (result.isErr()) {
      const errorMessage = result.error.type === "WORKTREE_CREATE_FAILED"
        ? result.error.error
        : result.error.type;
      throw new Error(errorMessage);
    }
    return worktreePath;
  }

  async removeWorktree(threadId: string): Promise<void> {
    try {
      await Deno.remove(this.getWorktreePath(threadId), { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  async saveThreadInfo(threadInfo: ThreadInfo): Promise<void> {
    await Deno.writeTextFile(
      join(this.config.threadsDir, `${threadInfo.threadId}.json`),
      JSON.stringify(threadInfo, null, 2),
    );
  }

  async loadThreadInfo(threadId: string): Promise<ThreadInfo | null> {
    try {
      const raw = await Deno.readTextFile(
        join(this.config.threadsDir, `${threadId}.json`),
      );
      const parsed = JSON.parse(raw) as ThreadInfo;
      if (parsed.firstUserMessageReceivedAt === undefined) {
        parsed.firstUserMessageReceivedAt = null;
      }
      if (parsed.autoRenamedByFirstMessage === undefined) {
        parsed.autoRenamedByFirstMessage = false;
      }
      return parsed;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async updateThreadLastActive(threadId: string): Promise<void> {
    const current = await this.loadThreadInfo(threadId);
    if (!current) return;
    current.lastActiveAt = new Date().toISOString();
    await this.saveThreadInfo(current);
  }

  async getAllThreadInfos(): Promise<ThreadInfo[]> {
    const infos: ThreadInfo[] = [];
    for await (const entry of Deno.readDir(this.config.threadsDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const threadId = entry.name.replace(/\.json$/, "");
      const info = await this.loadThreadInfo(threadId);
      if (info) infos.push(info);
    }
    return infos.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async saveWorkerState(workerState: WorkerState): Promise<void> {
    workerState.lastActiveAt = new Date().toISOString();
    await Deno.writeTextFile(
      join(this.config.workersDir, `${workerState.threadId}.json`),
      JSON.stringify(workerState, null, 2),
    );
  }

  async loadWorkerState(threadId: string): Promise<WorkerState | null> {
    try {
      const raw = await Deno.readTextFile(
        join(this.config.workersDir, `${threadId}.json`),
      );
      const parsed = JSON.parse(raw) as WorkerState;
      if (!parsed.status) parsed.status = "active";
      return parsed;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async getAllWorkerStates(): Promise<WorkerState[]> {
    const states: WorkerState[] = [];
    for await (const entry of Deno.readDir(this.config.workersDir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const threadId = entry.name.replace(/\.json$/, "");
      const state = await this.loadWorkerState(threadId);
      if (state) states.push(state);
    }
    return states.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async loadAdminState(): Promise<AdminState | null> {
    try {
      const raw = await Deno.readTextFile(
        join(this.config.adminDir, "active_threads.json"),
      );
      return JSON.parse(raw) as AdminState;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async saveAdminState(adminState: AdminState): Promise<void> {
    adminState.lastUpdated = new Date().toISOString();
    await Deno.writeTextFile(
      join(this.config.adminDir, "active_threads.json"),
      JSON.stringify(adminState, null, 2),
    );
  }

  async addActiveThread(threadId: string): Promise<void> {
    const admin = await this.loadAdminState() ?? {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    if (!admin.activeThreadIds.includes(threadId)) {
      admin.activeThreadIds.push(threadId);
    }
    await this.saveAdminState(admin);
  }

  async removeActiveThread(threadId: string): Promise<void> {
    const admin = await this.loadAdminState();
    if (!admin) return;
    admin.activeThreadIds = admin.activeThreadIds.filter((id) =>
      id !== threadId
    );
    await this.saveAdminState(admin);
  }

  async appendAuditLog(auditEntry: AuditEntry): Promise<void> {
    const date = auditEntry.timestamp.slice(0, 10);
    const dir = join(this.config.auditDir, date);
    await ensureDir(dir);
    await Deno.writeTextFile(
      join(dir, "activity.jsonl"),
      `${JSON.stringify(auditEntry)}\n`,
      { append: true },
    );
  }

  async saveRawSessionJsonl(
    repositoryFullName: string,
    sessionId: string,
    rawJsonlContent: string,
  ): Promise<void> {
    const [org, repo] = repositoryFullName.split("/");
    const dir = join(this.config.sessionsDir, org, repo);
    await ensureDir(dir);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await Deno.writeTextFile(
      join(dir, `${ts}_${sessionId}.jsonl`),
      rawJsonlContent,
    );
  }

  async getLocalRepositories(): Promise<string[]> {
    const repositories: string[] = [];
    try {
      for await (const orgEntry of Deno.readDir(this.config.repositoriesDir)) {
        if (!orgEntry.isDirectory) continue;
        const orgPath = join(this.config.repositoriesDir, orgEntry.name);
        for await (const repoEntry of Deno.readDir(orgPath)) {
          if (repoEntry.isDirectory) {
            repositories.push(`${orgEntry.name}/${repoEntry.name}`);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return repositories.sort();
  }
}
