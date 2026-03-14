import { join } from "std/path/mod.ts";
import { ensureDir } from "std/fs/mod.ts";
import type { ThreadInfo } from "./workspace.ts";
import { createWorktreeCopy, isWorktreeCopyExists } from "../git-utils.ts";
import { err, ok, Result } from "neverthrow";
import { validateThreadInfoSafe } from "./schemas/thread-schema.ts";
import type { WorkspaceError } from "./types.ts";

export class ThreadManager {
  private readonly threadsDir: string;
  private readonly worktreesDir: string;

  constructor(baseDir: string) {
    this.threadsDir = join(baseDir, "threads");
    this.worktreesDir = join(baseDir, "worktrees");
  }

  async initialize(): Promise<Result<void, WorkspaceError>> {
    try {
      await ensureDir(this.threadsDir);
      await ensureDir(this.worktreesDir);
      return ok(undefined);
    } catch (error) {
      return err({
        type: "THREAD_INITIALIZATION_FAILED",
        error: `ThreadManagerの初期化に失敗しました: ${error}`,
      });
    }
  }

  private getThreadFilePath(threadId: string): string {
    return join(this.threadsDir, `${threadId}.json`);
  }

  getWorktreePath(threadId: string): string {
    return join(this.worktreesDir, threadId);
  }

  async saveThreadInfo(
    threadInfo: ThreadInfo,
  ): Promise<Result<void, WorkspaceError>> {
    try {
      const filePath = this.getThreadFilePath(threadInfo.threadId);
      await Deno.writeTextFile(filePath, JSON.stringify(threadInfo, null, 2));
      return ok(undefined);
    } catch (error) {
      return err({
        type: "THREAD_SAVE_FAILED",
        threadId: threadInfo.threadId,
        error: `スレッド情報の保存に失敗しました: ${error}`,
      });
    }
  }

  async loadThreadInfo(
    threadId: string,
  ): Promise<Result<ThreadInfo | null, WorkspaceError>> {
    try {
      const filePath = this.getThreadFilePath(threadId);
      const content = await Deno.readTextFile(filePath);

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        return err({
          type: "THREAD_LOAD_FAILED",
          threadId,
          error: `スレッド情報のJSONパースに失敗しました: ${parseError}`,
        });
      }

      const result = validateThreadInfoSafe(parsed);
      if (!result.success) {
        return err({
          type: "THREAD_LOAD_FAILED",
          threadId,
          error: `無効なスレッド情報データ: ${result.error}`,
        });
      }
      return ok(result.data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok(null);
      }
      return err({
        type: "THREAD_LOAD_FAILED",
        threadId,
        error: `スレッド情報の読み込みに失敗しました: ${error}`,
      });
    }
  }

  async updateThreadLastActive(
    threadId: string,
  ): Promise<Result<void, WorkspaceError>> {
    const loadResult = await this.loadThreadInfo(threadId);
    if (loadResult.isErr()) {
      return err(loadResult.error);
    }

    const threadInfo = loadResult.value;
    if (threadInfo) {
      threadInfo.lastActiveAt = new Date().toISOString();
      const saveResult = await this.saveThreadInfo(threadInfo);
      if (saveResult.isErr()) {
        return err({
          type: "THREAD_UPDATE_FAILED",
          threadId,
          error: `最終アクティブ時刻の更新に失敗しました: ${
            "error" in saveResult.error
              ? saveResult.error.error
              : JSON.stringify(saveResult.error)
          }`,
        });
      }
    }
    return ok(undefined);
  }

  async getAllThreadInfos(): Promise<Result<ThreadInfo[], WorkspaceError>> {
    try {
      const threadInfos: ThreadInfo[] = [];

      for await (const entry of Deno.readDir(this.threadsDir)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          const threadId = entry.name.replace(".json", "");
          const loadResult = await this.loadThreadInfo(threadId);
          if (loadResult.isErr()) {
            // 個別の読み込みエラーはスキップしてログのみ出力
            console.error(
              `スレッド情報の読み込みに失敗しました (${threadId}):`,
              loadResult.error,
            );
            continue;
          }
          if (loadResult.value) {
            threadInfos.push(loadResult.value);
          }
        }
      }

      return ok(
        threadInfos.sort((a, b) =>
          b.lastActiveAt.localeCompare(a.lastActiveAt)
        ),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok([]);
      }
      return err({
        type: "THREAD_LIST_FAILED",
        error: `スレッド情報の一覧取得に失敗しました: ${error}`,
      });
    }
  }

  async ensureWorktree(
    threadId: string,
    repositoryPath: string,
    workerName?: string,
  ): Promise<Result<string, WorkspaceError>> {
    const worktreePath = this.getWorktreePath(threadId);
    const exists = await isWorktreeCopyExists(worktreePath);
    if (exists) {
      return ok(worktreePath);
    }

    // workerNameが指定されていない場合はthreadIdを使用
    const effectiveWorkerName = workerName || threadId;

    const createResult = await createWorktreeCopy(
      repositoryPath,
      effectiveWorkerName,
      worktreePath,
    );
    if (createResult.isErr()) {
      return err({
        type: "WORKTREE_CREATE_FAILED",
        threadId,
        error: `worktreeの作成に失敗しました: ${
          createResult.error.type === "WORKTREE_CREATE_FAILED"
            ? createResult.error.error
            : "Unknown error"
        }`,
      });
    }
    return ok(worktreePath);
  }

  async removeWorktree(
    threadId: string,
  ): Promise<Result<void, WorkspaceError>> {
    const worktreePath = this.getWorktreePath(threadId);

    try {
      const stat = await Deno.stat(worktreePath);
      if (!stat.isDirectory) {
        return ok(undefined);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok(undefined);
      }
      return err({
        type: "WORKTREE_REMOVE_FAILED",
        threadId,
        error: `worktreeの状態確認に失敗しました: ${error}`,
      });
    }

    try {
      await Deno.remove(worktreePath, { recursive: true });
      return ok(undefined);
    } catch (removeError) {
      console.warn(
        `ディレクトリの強制削除に失敗しました (${threadId}): ${removeError}`,
      );
      return err({
        type: "WORKTREE_REMOVE_FAILED",
        threadId,
        error: `worktreeの削除に失敗しました: ${removeError}`,
      });
    }
  }

  async cleanupWorktree(
    threadId: string,
  ): Promise<Result<void, WorkspaceError>> {
    const worktreePath = this.getWorktreePath(threadId);

    try {
      await Deno.remove(worktreePath, { recursive: true });
      return ok(undefined);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return ok(undefined);
      }
      console.warn(
        `worktreeコピーディレクトリの削除に失敗しました: ${error}`,
      );
      return err({
        type: "WORKTREE_REMOVE_FAILED",
        threadId,
        error: `worktreeのクリーンアップに失敗しました: ${error}`,
      });
    }
  }
}
