import { Worker } from "../worker/worker.ts";
import type { IWorker } from "../worker/types.ts";
import { generateWorkerName } from "../worker-name-generator.ts";
import type { ThreadInfo, WorkerState } from "../workspace/workspace.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import { parseRepository } from "../git-utils.ts";
import { err, ok, Result } from "neverthrow";
import { exec } from "../utils/exec.ts";
import type { RateLimitManager } from "./rate-limit-manager.ts";

// エラー型定義
export type WorkerManagerError =
  | { type: "WORKER_CREATE_FAILED"; threadId: string; reason: string }
  | { type: "THREAD_RESTORE_FAILED"; threadId: string; error: string }
  | {
    type: "REPOSITORY_RESTORE_FAILED";
    threadId: string;
    repositoryFullName: string;
    error: string;
  };

export class WorkerManager {
  private workers: Map<string, IWorker> = new Map();
  private workspaceManager: WorkspaceManager;
  private verbose: boolean;
  private appendSystemPrompt?: string;
  private translatorUrl?: string;
  private rateLimitManager?: RateLimitManager;

  constructor(
    workspaceManager: WorkspaceManager,
    verbose = false,
    appendSystemPrompt?: string,
    translatorUrl?: string,
    rateLimitManager?: RateLimitManager,
  ) {
    this.workspaceManager = workspaceManager;
    this.verbose = verbose;
    this.appendSystemPrompt = appendSystemPrompt;
    this.translatorUrl = translatorUrl;
    this.rateLimitManager = rateLimitManager;
  }

  /**
   * Workerを作成する
   */
  async createWorker(
    threadId: string,
  ): Promise<Result<IWorker, WorkerManagerError>> {
    this.logVerbose("Worker作成要求", {
      threadId,
      currentWorkerCount: this.workers.size,
      hasExistingWorker: this.workers.has(threadId),
    });

    // 既にWorkerが存在する場合はそれを返す
    const existingWorker = this.workers.get(threadId);
    if (existingWorker) {
      this.logVerbose("既存Worker返却", {
        threadId,
        workerName: existingWorker.getName(),
        hasRepository: !!existingWorker.getRepository(),
      });
      return ok(existingWorker);
    }

    // 新しいWorkerを作成
    const workerName = generateWorkerName();
    this.logVerbose("新規Worker作成開始", {
      threadId,
      workerName,
      verboseMode: this.verbose,
    });

    const workerState: WorkerState = {
      workerName,
      threadId,
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    const worker = new Worker(
      workerState,
      this.workspaceManager,
      undefined,
      this.verbose,
      this.appendSystemPrompt,
      this.translatorUrl,
      this.rateLimitManager,
    );
    this.workers.set(threadId, worker);

    this.logVerbose("Worker作成完了、管理Mapに追加", {
      threadId,
      workerName,
      totalWorkerCount: this.workers.size,
    });

    // Worker状態を保存
    const saveResult = await worker.save();
    if (saveResult.isErr()) {
      return err({
        type: "WORKER_CREATE_FAILED",
        threadId,
        reason: saveResult.error.type,
      });
    }
    this.logVerbose("Worker状態保存完了", { threadId });

    // ThreadInfoも作成・保存
    const threadInfo: ThreadInfo = {
      threadId,
      repositoryFullName: null,
      repositoryLocalPath: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    };
    await this.workspaceManager.saveThreadInfo(threadInfo);
    this.logVerbose("ThreadInfo保存完了", { threadId });

    return ok(worker);
  }

  /**
   * Workerを取得する
   */
  getWorker(threadId: string): IWorker | null {
    return this.workers.get(threadId) || null;
  }

  /**
   * Workerを削除する
   */
  removeWorker(threadId: string): IWorker | null {
    const worker = this.workers.get(threadId);
    if (worker) {
      this.workers.delete(threadId);
      this.logVerbose("Worker管理Mapから削除", { threadId });
    }
    return worker || null;
  }

  /**
   * 管理中のWorker数を取得
   */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * 単一のスレッドを復旧する
   */
  async restoreThread(
    threadInfo: ThreadInfo,
  ): Promise<Result<void, WorkerManagerError>> {
    const { threadId } = threadInfo;

    this.logVerbose("スレッド復旧開始", {
      threadId,
      repositoryFullName: threadInfo.repositoryFullName,
    });

    // worktreeとディレクトリの存在確認
    if (threadInfo.worktreePath) {
      try {
        const stat = await Deno.stat(threadInfo.worktreePath);
        if (!stat.isDirectory) {
          this.logVerbose(
            "worktreeパスが通常ファイル、スレッド終了として処理",
            {
              threadId,
              worktreePath: threadInfo.worktreePath,
            },
          );
          await this.archiveThread(threadId);
          return ok(undefined);
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          this.logVerbose("worktreeが存在しない、スレッド終了として処理", {
            threadId,
            worktreePath: threadInfo.worktreePath,
          });
          await this.archiveThread(threadId);
          return ok(undefined);
        }
        return err({
          type: "THREAD_RESTORE_FAILED",
          threadId,
          error: (error as Error).message,
        });
      }

      // git worktreeの有効性を確認
      if (threadInfo.repositoryLocalPath) {
        const worktreeListResult = await exec(
          `cd "${threadInfo.repositoryLocalPath}" && git worktree list --porcelain`,
        );

        if (worktreeListResult.isOk()) {
          const output = worktreeListResult.value.output;
          const worktreeExists = output.includes(threadInfo.worktreePath);
          if (!worktreeExists) {
            this.logVerbose(
              "worktreeがgitに登録されていない、スレッド終了として処理",
              {
                threadId,
                worktreePath: threadInfo.worktreePath,
              },
            );
            await this.archiveThread(threadId);
            return ok(undefined);
          }
        } else {
          this.logVerbose("git worktree list失敗、復旧を継続", {
            threadId,
            error: worktreeListResult.error.message,
          });
        }
      }
    }

    // WorkerStateを読み込む
    const workerState = await this.workspaceManager.loadWorkerState(threadId);

    if (workerState) {
      // 既存のWorkerStateから復元
      this.logVerbose("WorkerStateから復元", {
        threadId,
        workerName: workerState.workerName,
        hasRepository: !!workerState.repository,
      });

      const worker = await Worker.fromState(
        workerState,
        this.workspaceManager,
        this.verbose,
        this.appendSystemPrompt,
        this.translatorUrl,
        this.rateLimitManager,
      );

      // Workerを管理Mapに追加
      this.workers.set(threadId, worker);

      // 最終アクティブ時刻を更新
      await this.workspaceManager.updateThreadLastActive(threadId);

      this.logVerbose("スレッド復旧完了（WorkerStateから）", {
        threadId,
        workerName: workerState.workerName,
        hasRepository: !!worker.getRepository(),
      });
    } else {
      // WorkerStateがない場合は従来の方法で復元
      this.logVerbose("WorkerStateが見つからない、ThreadInfoから復元", {
        threadId,
      });

      const workerName = generateWorkerName();
      const newWorkerState: WorkerState = {
        workerName,
        threadId,
        repository: threadInfo.repositoryFullName
          ? {
            fullName: threadInfo.repositoryFullName,
            org: threadInfo.repositoryFullName.split("/")[0],
            repo: threadInfo.repositoryFullName.split("/")[1],
          }
          : undefined,
        repositoryLocalPath: threadInfo.repositoryLocalPath || undefined,
        worktreePath: threadInfo.worktreePath,
        devcontainerConfig: {
          useDevcontainer: false,
          useFallbackDevcontainer: false,
          hasDevcontainerFile: false,
          hasAnthropicsFeature: false,
          isStarted: false,
        },
        status: "active",
        createdAt: threadInfo.createdAt,
        lastActiveAt: new Date().toISOString(),
      };

      const worker = new Worker(
        newWorkerState,
        this.workspaceManager,
        undefined,
        this.verbose,
        this.appendSystemPrompt,
        this.translatorUrl,
        this.rateLimitManager,
      );

      // リポジトリ情報を復旧
      if (
        threadInfo.repositoryFullName && threadInfo.repositoryLocalPath &&
        threadInfo.worktreePath
      ) {
        try {
          // リポジトリ情報を再構築
          const repositoryResult = parseRepository(
            threadInfo.repositoryFullName,
          );

          if (repositoryResult.isOk()) {
            const setRepoResult = await worker.setRepository(
              repositoryResult.value,
              threadInfo.repositoryLocalPath,
            );
            if (setRepoResult.isErr()) {
              this.logVerbose("リポジトリ情報復旧失敗", {
                threadId,
                repositoryFullName: threadInfo.repositoryFullName,
                error: setRepoResult.error.type,
              });
              // リポジトリ設定に失敗した場合、Worker作成を中断
              this.workers.delete(threadId);
              return err({
                type: "REPOSITORY_RESTORE_FAILED",
                threadId,
                repositoryFullName: threadInfo.repositoryFullName,
                error: setRepoResult.error.type,
              });
            } else {
              this.logVerbose("リポジトリ情報復旧完了", {
                threadId,
                repositoryFullName: threadInfo.repositoryFullName,
                worktreePath: threadInfo.worktreePath,
              });
            }
          } else {
            this.logVerbose("リポジトリ名のパース失敗", {
              threadId,
              repositoryFullName: threadInfo.repositoryFullName,
              error: repositoryResult.error.type,
            });
            console.warn(
              `スレッド ${threadId} のリポジトリ名のパースに失敗しました:`,
              repositoryResult.error,
            );
          }
        } catch (error) {
          this.logVerbose("リポジトリ情報復旧失敗", {
            threadId,
            repositoryFullName: threadInfo.repositoryFullName,
            error: (error as Error).message,
          });
          console.warn(
            `スレッド ${threadId} のリポジトリ情報復旧に失敗しました:`,
            error,
          );
        }
      }

      // Workerを管理Mapに追加
      this.workers.set(threadId, worker);

      // 最終アクティブ時刻を更新
      await this.workspaceManager.updateThreadLastActive(threadId);

      this.logVerbose("スレッド復旧完了（ThreadInfoから）", {
        threadId,
        workerName,
        hasRepository: !!worker.getRepository(),
      });
    }

    return ok(undefined);
  }

  /**
   * スレッドをアーカイブ状態にする
   */
  private async archiveThread(threadId: string): Promise<void> {
    const workerState = await this.workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      workerState.status = "archived";
      workerState.lastActiveAt = new Date().toISOString();
      await this.workspaceManager.saveWorkerState(workerState);

      this.logVerbose("スレッドをアーカイブ状態に変更", {
        threadId,
        repositoryFullName: workerState.repository?.fullName,
      });
    }

    // ThreadInfoもアーカイブ状態に更新
    const threadInfo = await this.workspaceManager.loadThreadInfo(threadId);
    if (threadInfo) {
      threadInfo.status = "archived";
      threadInfo.lastActiveAt = new Date().toISOString();
      await this.workspaceManager.saveThreadInfo(threadInfo);
    }
  }

  /**
   * verboseログを出力する
   */
  private logVerbose(
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.verbose) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [WorkerManager] ${message}`;
      console.log(logMessage);

      if (metadata && Object.keys(metadata).length > 0) {
        console.log(`[${timestamp}] [WorkerManager] メタデータ:`, metadata);
      }
    }
  }
}
