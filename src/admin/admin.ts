import type { IWorker } from "../worker/types.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import type {
  AdminState,
  AuditEntry,
  ThreadInfo,
} from "../workspace/workspace.ts";
import type { AdminError, DiscordMessage, IAdmin } from "./types.ts";
import { WorkerManager } from "./worker-manager.ts";
import { RateLimitManager } from "./rate-limit-manager.ts";
import { DevcontainerManager } from "./devcontainer-manager.ts";
import { MessageRouter } from "./message-router.ts";
import { err, ok, Result } from "neverthrow";
import type { Client } from "discord.js";

export class Admin implements IAdmin {
  private state: AdminState;
  private workspaceManager: WorkspaceManager;
  private workerManager: WorkerManager;
  private rateLimitManager: RateLimitManager;
  private devcontainerManager: DevcontainerManager;
  private messageRouter: MessageRouter;
  private verbose: boolean;
  private onThreadClose?: (threadId: string) => Promise<void>;

  constructor(
    state: AdminState,
    workspaceManager: WorkspaceManager,
    verbose = false,
    appendSystemPrompt?: string,
    translatorUrl?: string,
  ) {
    this.state = state;
    this.workspaceManager = workspaceManager;
    this.verbose = verbose;

    // 各マネージャーを初期化
    this.rateLimitManager = new RateLimitManager(workspaceManager, verbose);
    this.workerManager = new WorkerManager(
      workspaceManager,
      verbose,
      appendSystemPrompt,
      translatorUrl,
      this.rateLimitManager,
    );
    this.devcontainerManager = new DevcontainerManager(
      workspaceManager,
      verbose,
    );
    this.messageRouter = new MessageRouter(
      this.workerManager,
      this.rateLimitManager,
      workspaceManager,
      verbose,
    );

    if (this.verbose) {
      this.logVerbose("Admin初期化完了", {
        verboseMode: this.verbose,
        workspaceBaseDir: workspaceManager.getBaseDir(),
        hasAppendSystemPrompt: !!appendSystemPrompt,
        hasTranslatorUrl: !!translatorUrl,
      });
    }
  }

  /**
   * 既存のアクティブなスレッドを復旧する
   */
  async restoreActiveThreads(): Promise<Result<void, AdminError>> {
    this.logVerbose("アクティブスレッド復旧開始");

    if (!this.checkActiveThreads()) {
      return ok(undefined);
    }

    this.logVerbose("復旧対象スレッド発見", {
      activeThreadCount: this.state.activeThreadIds.length,
      threadIds: this.state.activeThreadIds,
    });

    const errors: string[] = [];
    for (const threadId of [...this.state.activeThreadIds]) {
      const result = await this.restoreSingleThreadSafe(threadId);
      if (result.isErr()) {
        errors.push(`${threadId}: ${result.error}`);
      }
    }

    // レートリミット自動継続タイマーを復旧
    await this.rateLimitManager.restoreRateLimitTimers();

    this.logVerbose("アクティブスレッド復旧完了", {
      restoredCount: this.workerManager.getWorkerCount(),
      hadErrors: errors.length > 0,
      errorCount: errors.length,
    });

    if (errors.length > 0) {
      this.logVerbose("アクティブスレッド復旧で一部エラー", {
        errors,
      });
      console.error(
        "アクティブスレッドの復旧で一部エラーが発生しました:",
        errors,
      );
    }

    return ok(undefined);
  }

  /**
   * アクティブスレッドの存在を確認する
   */
  private checkActiveThreads(): boolean {
    if (this.state.activeThreadIds.length === 0) {
      this.logVerbose("アクティブスレッドリストが空");
      return false;
    }
    return true;
  }

  /**
   * スレッド情報を読み込んで検証する
   */
  private async loadAndValidateThreadInfo(
    threadId: string,
  ): Promise<ThreadInfo | null> {
    const threadInfo = await this.workspaceManager.loadThreadInfo(threadId);

    if (!threadInfo) {
      this.logVerbose("スレッド情報が見つからない", { threadId });
      await this.removeActiveThreadSafely(threadId);
      return null;
    }

    if (threadInfo.status === "archived") {
      this.logVerbose("アーカイブ済みスレッドをスキップ", { threadId });
      await this.removeActiveThreadSafely(threadId);
      return null;
    }

    return threadInfo;
  }

  /**
   * アクティブリストからスレッドを安全に削除する
   */
  private async removeActiveThreadSafely(threadId: string): Promise<void> {
    try {
      await this.removeActiveThread(threadId);
    } catch (error) {
      this.logVerbose("アクティブリストからの削除に失敗", {
        threadId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * 単一スレッドを復旧する
   */
  private async restoreSingleThread(threadId: string): Promise<void> {
    try {
      const threadInfo = await this.loadAndValidateThreadInfo(threadId);
      if (!threadInfo) {
        return;
      }

      const restoreResult = await this.workerManager.restoreThread(threadInfo);
      if (restoreResult.isErr()) {
        const errorMessage =
          restoreResult.error.type === "THREAD_RESTORE_FAILED"
            ? restoreResult.error.error
            : restoreResult.error.type === "REPOSITORY_RESTORE_FAILED"
            ? restoreResult.error.error
            : restoreResult.error.reason;
        throw new Error(errorMessage);
      }
      await this.recordThreadRestoration(threadId);
    } catch (error) {
      await this.handleThreadRestoreError(threadId, error);
    }
  }

  /**
   * 単一スレッドを安全に復旧する
   */
  private async restoreSingleThreadSafe(
    threadId: string,
  ): Promise<Result<void, string>> {
    try {
      await this.restoreSingleThread(threadId);
      return ok(undefined);
    } catch (error) {
      return err((error as Error).message);
    }
  }

  /**
   * スレッド復旧の監査ログを記録する
   */
  private async recordThreadRestoration(threadId: string): Promise<void> {
    const workerState = await this.workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      await this.logAuditEntry(threadId, "thread_restored", {
        workerName: workerState.workerName,
        repositoryFullName: workerState.repository?.fullName,
        fromWorkerState: true,
      });
    }
  }

  /**
   * スレッド復旧エラーをハンドリングする
   */
  private async handleThreadRestoreError(
    threadId: string,
    error: unknown,
  ): Promise<void> {
    this.logVerbose("スレッド復旧失敗", {
      threadId,
      error: (error as Error).message,
    });
    console.error(
      `スレッド ${threadId} の復旧に失敗しました:`,
      error,
    );
  }

  async createWorker(threadId: string): Promise<Result<IWorker, AdminError>> {
    const workerResult = await this.workerManager.createWorker(threadId);

    if (workerResult.isErr()) {
      return err({
        type: "WORKER_CREATE_FAILED",
        threadId,
        reason: workerResult.error.type === "WORKER_CREATE_FAILED"
          ? workerResult.error.reason
          : `Worker creation failed: ${workerResult.error.type}`,
      });
    }

    const worker = workerResult.value;

    // アクティブスレッドリストに追加
    await this.addActiveThread(threadId);
    this.logVerbose("アクティブスレッドリストに追加完了", { threadId });

    // 監査ログに記録
    await this.logAuditEntry(threadId, "worker_created", {
      workerName: worker.getName(),
    });
    this.logVerbose("監査ログ記録完了", {
      threadId,
      action: "worker_created",
    });

    return ok(worker);
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
    onProgress?: (content: string) => Promise<void>,
    onReaction?: (emoji: string) => Promise<void>,
    messageId?: string,
    authorId?: string,
  ): Promise<Result<string | DiscordMessage, AdminError>> {
    const result = await this.messageRouter.routeMessage(
      threadId,
      message,
      onProgress,
      onReaction,
      messageId,
      authorId,
    );

    if (result.isErr()) {
      const error = result.error;
      switch (error.type) {
        case "WORKER_NOT_FOUND":
          return err({ type: "WORKER_NOT_FOUND", threadId: error.threadId });
        case "RATE_LIMIT_ERROR":
          return err({
            type: "RATE_LIMIT",
            retryAt: 300000, // 5分
            timestamp: error.timestamp,
          });
        case "MESSAGE_PROCESSING_ERROR":
          return err({
            type: "PERMISSION_ERROR",
            message: error.error,
          });
        default:
          // Never型になるはずなので、全てのケースがカバーされている
          return error satisfies never;
      }
    }

    return ok(result.value);
  }

  async handleButtonInteraction(
    threadId: string,
    customId: string,
  ): Promise<Result<string, AdminError>> {
    // devcontainer関連のボタン処理
    if (customId.startsWith(`devcontainer_yes_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager
        .handleDevcontainerYesButton(
          threadId,
          workerResult.value,
        );
      return ok(result);
    }

    if (customId.startsWith(`devcontainer_no_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager
        .handleDevcontainerNoButton(
          threadId,
          workerResult.value,
        );
      return ok(result);
    }

    // レートリミット自動継続ボタン処理
    if (customId.startsWith(`rate_limit_auto_yes_${threadId}`)) {
      const result = await this.rateLimitManager.handleRateLimitAutoButton(
        threadId,
        true,
      );
      return ok(result);
    }

    if (customId.startsWith(`rate_limit_auto_no_${threadId}`)) {
      const result = await this.rateLimitManager.handleRateLimitAutoButton(
        threadId,
        false,
      );
      return ok(result);
    }

    // ローカル環境選択ボタン処理
    if (customId.startsWith(`local_env_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager.handleLocalEnvButton(
        threadId,
        workerResult.value,
      );
      return ok(result);
    }

    // fallback devcontainer選択ボタン処理
    if (customId.startsWith(`fallback_devcontainer_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager
        .handleFallbackDevcontainerButton(
          threadId,
          workerResult.value,
        );
      return ok(result);
    }

    // 権限チェックありボタン処理
    if (customId.startsWith(`permissions_no_skip_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager
        .handlePermissionsNoSkipButton(
          threadId,
          workerResult.value,
        );
      return ok(result);
    }

    // 権限チェックスキップボタン処理
    if (customId.startsWith(`permissions_skip_${threadId}`)) {
      const workerResult = this.getWorker(threadId);
      if (workerResult.isErr()) {
        return err(workerResult.error);
      }
      const result = await this.devcontainerManager
        .handlePermissionsSkipButton(
          threadId,
          workerResult.value,
        );
      return ok(result);
    }

    return ok("未知のボタンが押されました。");
  }

  /**
   * devcontainerの起動を処理する
   */
  async startDevcontainerForWorker(
    threadId: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return {
        success: false,
        message: "Workerが見つかりません。",
      };
    }

    return this.devcontainerManager.startDevcontainerWithWorker(
      threadId,
      worker,
      onProgress,
    );
  }

  /**
   * fallback devcontainerの起動を処理する
   */
  async startFallbackDevcontainerForWorker(
    threadId: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<{
    success: boolean;
    message: string;
  }> {
    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      return {
        success: false,
        message: "Workerが見つかりません。",
      };
    }

    const repository = worker.getRepository();
    if (!repository) {
      return {
        success: false,
        message: "リポジトリが設定されていません。",
      };
    }

    const repositoryPath = this.workspaceManager.getRepositoryPath(
      repository.org,
      repository.repo,
    );

    return this.devcontainerManager.startDevcontainerForWorker(
      threadId,
      repositoryPath,
      onProgress,
    );
  }

  /**
   * リポジトリにdevcontainer.jsonが存在するかチェックし、存在する場合は起動確認を行う
   */
  async checkAndSetupDevcontainer(
    threadId: string,
    repositoryPath: string,
  ) {
    const result = await this.devcontainerManager.checkAndSetupDevcontainer(
      threadId,
      repositoryPath,
    );

    // devcontainer.jsonが見つからない場合、自動的にWorkerを権限チェックスキップで設定
    if (!result.hasDevcontainer) {
      const worker = this.workerManager.getWorker(threadId);
      if (worker) {
        worker.setUseDevcontainer(false);
        worker.setDangerouslySkipPermissions(true);
        this.logVerbose(
          "devcontainer.json未発見のためWorkerを権限チェックスキップに自動設定",
          {
            threadId,
            workerName: worker.getName(),
          },
        );
      }
    }

    return result;
  }

  /**
   * 自動再開コールバックを設定する
   */
  setAutoResumeCallback(
    callback: (threadId: string, message: string) => Promise<void>,
  ): void {
    this.rateLimitManager.setAutoResumeCallback(callback);
  }

  /**
   * DiscordクライアントをRateLimitManagerに設定する
   */
  setDiscordClient(client: Client): void {
    this.rateLimitManager.setDiscordClient(client);
  }

  /**
   * Discordステータスをトークン使用量情報付きで更新する
   */
  async updateDiscordStatusWithTokenUsage(): Promise<void> {
    await this.rateLimitManager.updateDiscordStatusWithTokenUsage();
  }

  /**
   * スレッドクローズコールバックを設定する
   */
  setThreadCloseCallback(
    callback: (threadId: string) => Promise<void>,
  ): void {
    this.onThreadClose = callback;
  }

  createInitialMessage(_threadId: string): DiscordMessage {
    return {
      content:
        "Codex Code Bot スレッドが開始されました。\n\n/start コマンドでリポジトリを指定してください。\n\n**リポジトリ設定後の流れ:**\n1. devcontainer.jsonの存在確認\n2. devcontainer利用の可否選択\n3. Codex実行環境の準備",
      components: [],
    };
  }

  createRateLimitMessage(threadId: string, timestamp: number): string {
    return this.rateLimitManager.createRateLimitMessage(threadId, timestamp);
  }

  async terminateThread(threadId: string): Promise<Result<void, AdminError>> {
    this.logVerbose("スレッド終了処理開始", {
      threadId,
      currentWorkerCount: this.workerManager.getWorkerCount(),
    });

    const worker = this.workerManager.removeWorker(threadId);

    if (worker) {
      this.logVerbose("Worker発見、終了処理実行", {
        threadId,
        workerName: worker.getName(),
        hasRepository: !!worker.getRepository(),
        repositoryFullName: worker.getRepository()?.fullName,
      });

      // devcontainerの削除を先に実行
      this.logVerbose("devcontainer削除", { threadId });
      await this.devcontainerManager.removeDevcontainer(threadId);

      this.logVerbose("worktree削除開始", { threadId });
      await this.workspaceManager.removeWorktree(threadId);

      this.logVerbose("自動再開タイマークリア", { threadId });
      this.rateLimitManager.clearAutoResumeTimer(threadId);

      // WorkerStateをアーカイブ状態に更新
      const workerState = await this.workspaceManager.loadWorkerState(
        threadId,
      );
      if (workerState) {
        this.logVerbose("WorkerStateをアーカイブ状態に更新", { threadId });
        workerState.status = "archived";
        workerState.lastActiveAt = new Date().toISOString();
        await this.workspaceManager.saveWorkerState(workerState);
      }

      // ThreadInfoもアーカイブ状態に更新
      const threadInfo = await this.workspaceManager.loadThreadInfo(threadId);
      if (threadInfo) {
        this.logVerbose("ThreadInfoをアーカイブ状態に更新", { threadId });
        threadInfo.status = "archived";
        threadInfo.lastActiveAt = new Date().toISOString();
        await this.workspaceManager.saveThreadInfo(threadInfo);
      }

      // アクティブスレッドリストから削除
      await this.removeActiveThread(threadId);
      this.logVerbose("アクティブスレッドリストから削除完了", { threadId });

      await this.logAuditEntry(threadId, "thread_terminated", {
        workerName: worker.getName(),
        repository: worker.getRepository()?.fullName,
      });

      this.logVerbose("スレッド終了処理完了", {
        threadId,
        remainingWorkerCount: this.workerManager.getWorkerCount(),
      });
    } else {
      this.logVerbose("Worker見つからず、終了処理スキップ", { threadId });
    }

    // Discordスレッドをクローズ
    if (this.onThreadClose) {
      this.logVerbose("Discordスレッドクローズコールバック実行", {
        threadId,
      });
      try {
        await this.onThreadClose(threadId);
        this.logVerbose("Discordスレッドクローズ成功", { threadId });
      } catch (error) {
        console.error(
          `Discordスレッドのクローズに失敗しました (${threadId}):`,
          error,
        );
      }
    }

    return ok(undefined);
  }

  /**
   * 実行中のCodex Codeを中断する
   */
  async stopExecution(threadId: string): Promise<Result<void, AdminError>> {
    this.logVerbose("Codex Code実行中断処理開始", { threadId });

    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      this.logVerbose("Worker見つからず", { threadId });
      return err({
        type: "WORKER_NOT_FOUND",
        threadId,
      });
    }

    try {
      // Workerの中断処理を呼び出す
      const success = await worker.stopExecution();

      if (success) {
        this.logVerbose("Codex Code実行中断成功", { threadId });

        // 監査ログに中断イベントを記録
        await this.logAuditEntry(threadId, "worker_stopped", {
          workerName: worker.getName(),
          timestamp: new Date().toISOString(),
        });

        return ok(undefined);
      } else {
        this.logVerbose("Codex Code実行中断失敗 - 実行中のプロセスなし", {
          threadId,
        });
        // プロセスが実行中でない場合も成功として扱う
        return ok(undefined);
      }
    } catch (error) {
      this.logVerbose("Codex Code実行中断中にエラー発生", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });

      // エラーが発生しても、中断操作自体は成功として扱う
      // （既に停止している可能性があるため）
      return ok(undefined);
    }
  }

  /**
   * アクティブスレッドリストに追加
   */
  private async addActiveThread(threadId: string): Promise<void> {
    if (!this.state.activeThreadIds.includes(threadId)) {
      this.state.activeThreadIds.push(threadId);
      await this.saveSafe();
    }
  }

  /**
   * アクティブスレッドリストから削除
   */
  private async removeActiveThread(threadId: string): Promise<void> {
    this.state.activeThreadIds = this.state.activeThreadIds.filter(
      (id) => id !== threadId,
    );
    await this.saveSafe();
  }

  /**
   * Admin状態を保存
   */
  async save(): Promise<void> {
    await this.saveSafe();
  }

  /**
   * Admin状態を安全に保存する（内部使用）
   */
  private async saveSafe(): Promise<Result<void, string>> {
    try {
      await this.workspaceManager.saveAdminState(this.state);
      this.logVerbose("Admin状態を永続化", {
        activeThreadCount: this.state.activeThreadIds.length,
      });
      return ok(undefined);
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error("Admin状態の保存に失敗しました:", error);
      return err(errorMessage);
    }
  }

  /**
   * スレッドのdevcontainer設定を保存する（後方互換性のため）
   */
  async saveDevcontainerConfig(
    threadId: string,
    config: {
      useDevcontainer: boolean;
      hasDevcontainerFile: boolean;
      hasAnthropicsFeature: boolean;
      containerId?: string;
      isStarted: boolean;
      useFallback?: boolean;
    },
  ): Promise<void> {
    await this.devcontainerManager.saveDevcontainerConfig(threadId, config);
  }

  /**
   * スレッドのdevcontainer設定を取得する（後方互換性のため）
   */
  async getDevcontainerConfig(threadId: string): Promise<
    {
      useDevcontainer: boolean;
      hasDevcontainerFile: boolean;
      hasAnthropicsFeature: boolean;
      containerId?: string;
      isStarted: boolean;
    } | null
  > {
    return this.devcontainerManager.getDevcontainerConfig(threadId);
  }

  /**
   * Admin状態を復元する（静的メソッド）
   */
  static fromState(
    adminState: AdminState | null,
    workspaceManager: WorkspaceManager,
    verbose?: boolean,
    appendSystemPrompt?: string,
    translatorUrl?: string,
  ): Admin {
    const state = adminState || {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };

    return new Admin(
      state,
      workspaceManager,
      verbose,
      appendSystemPrompt,
      translatorUrl,
    );
  }

  private async logAuditEntry(
    threadId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      threadId,
      action,
      details,
    };

    try {
      await this.workspaceManager.appendAuditLog(auditEntry);
    } catch (error) {
      console.error("監査ログの記録に失敗しました:", error);
    }
  }

  /**
   * Planモードの設定
   */
  async setPlanMode(
    threadId: string,
    planMode: boolean,
  ): Promise<Result<void, AdminError>> {
    this.logVerbose("Planモード設定開始", { threadId, planMode });

    const worker = this.workerManager.getWorker(threadId);
    if (!worker) {
      this.logVerbose("Worker見つからず", { threadId });
      return err({
        type: "WORKER_NOT_FOUND",
        threadId,
      });
    }

    try {
      // Workerの状態を更新
      worker.setPlanMode(planMode);

      // Workerの状態を保存
      const saveResult = await worker.save();
      if (saveResult.isErr()) {
        this.logVerbose("Worker状態保存エラー", {
          threadId,
          error: saveResult.error,
        });
        return err({
          type: "WORKSPACE_ERROR",
          operation: "save_worker_state",
          error: `Worker状態の保存に失敗: ${saveResult.error.type}`,
        });
      }

      this.logVerbose("Planモード設定完了", { threadId, planMode });
      return ok(undefined);
    } catch (error) {
      this.logVerbose("Planモード設定エラー", {
        threadId,
        planMode,
        error: (error as Error).message,
      });
      return err({
        type: "WORKSPACE_ERROR",
        operation: "set_plan_mode",
        error: (error as Error).message,
      });
    }
  }

  /**
   * スレッドをクローズする
   */
  async closeThread(
    threadId: string,
  ): Promise<Result<void, AdminError>> {
    this.logVerbose("スレッドクローズ開始", { threadId });

    // terminateThread メソッドを呼び出して完全にクリーンアップ
    const terminateResult = await this.terminateThread(threadId);

    if (terminateResult.isErr()) {
      this.logVerbose("スレッド終了処理エラー", {
        threadId,
        error: terminateResult.error,
      });
      return err(terminateResult.error);
    }

    this.logVerbose("スレッドクローズ完了", { threadId });
    return ok(undefined);
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
      const logMessage = `[${timestamp}] [Admin] ${message}`;
      console.log(logMessage);

      if (metadata && Object.keys(metadata).length > 0) {
        console.log(`[${timestamp}] [Admin] メタデータ:`, metadata);
      }
    }
  }
}
