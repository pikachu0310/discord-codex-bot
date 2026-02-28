import type {
  AuditEntry,
  QueuedMessage,
  WorkerState,
} from "../workspace/workspace.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import { RATE_LIMIT } from "../constants.ts";
import type { Client } from "discord.js";
import { ActivityType, PresenceUpdateStatus } from "discord.js";
import { TokenUsageTracker } from "../token-usage-tracker.ts";
import type { TokenUsageTrackerOptions } from "../token-usage-tracker.ts";
import {
  CodexRateLimitStatusProvider,
  type RateLimitStatusSource,
} from "../codex-rate-limit-status.ts";

export class RateLimitManager {
  private autoResumeTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private workspaceManager: WorkspaceManager;
  private verbose: boolean;
  private discordClient?: Client;
  private onAutoResumeMessage?: (
    threadId: string,
    message: string,
  ) => Promise<void>;
  private tokenUsageTracker: TokenUsageTracker;
  private rateLimitStatusSource: RateLimitStatusSource;

  constructor(
    workspaceManager: WorkspaceManager,
    verbose = false,
    tokenUsageOptions?: TokenUsageTrackerOptions,
  ) {
    this.workspaceManager = workspaceManager;
    this.verbose = verbose;
    this.tokenUsageTracker = new TokenUsageTracker(tokenUsageOptions);
    this.rateLimitStatusSource = new CodexRateLimitStatusProvider();
  }

  /**
   * DiscordクライアントをRateLimitManagerに設定する
   */
  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  /**
   * 自動再開コールバックを設定する
   */
  setAutoResumeCallback(
    callback: (threadId: string, message: string) => Promise<void>,
  ): void {
    this.onAutoResumeMessage = callback;
  }

  /**
   * Discordステータス表示用のレートリミット取得元を差し替える
   */
  setRateLimitStatusSource(source: RateLimitStatusSource): void {
    this.rateLimitStatusSource = source;
  }

  /**
   * レートリミット情報をWorker状態に保存する
   */
  async saveRateLimitInfo(
    threadId: string,
    timestamp: number,
  ): Promise<void> {
    try {
      const workerState = await this.workspaceManager.loadWorkerState(threadId);
      if (workerState) {
        workerState.rateLimitTimestamp = timestamp;
        workerState.lastActiveAt = new Date().toISOString();
        workerState.autoResumeAfterRateLimit = true; // 自動的に自動再開を有効にする
        await this.workspaceManager.saveWorkerState(workerState);

        // タイマーを設定
        this.scheduleAutoResume(threadId, timestamp);

        // Discordステータスを更新
        await this.updateDiscordStatusForRateLimit(timestamp);

        await this.logAuditEntry(threadId, "rate_limit_detected", {
          timestamp,
          resumeTime: new Date(
            timestamp * 1000 + RATE_LIMIT.AUTO_RESUME_DELAY_MS,
          ).toISOString(),
          autoResumeEnabled: true,
        });
      }
    } catch (error) {
      console.error("レートリミット情報の保存に失敗しました:", error);
    }
  }

  /**
   * レートリミットメッセージを作成する（ボタンなし）
   */
  createRateLimitMessage(_threadId: string, timestamp: number): string {
    const resumeTime = new Date(
      timestamp * 1000 + RATE_LIMIT.AUTO_RESUME_DELAY_MS,
    );
    const resumeTimeStr = resumeTime.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    return `Codex Codeのレートリミットに達しました。利用制限により一時的に使用できない状態です。

制限解除予定時刻：${resumeTimeStr}頃

この時間までに送信されたメッセージは、制限解除後に自動的に処理されます。`;
  }

  /**
   * レートリミット自動継続ボタンのハンドラー
   */
  async handleRateLimitAutoButton(
    threadId: string,
    autoResume: boolean,
  ): Promise<string> {
    try {
      const workerState = await this.workspaceManager.loadWorkerState(threadId);
      if (!workerState || !workerState.rateLimitTimestamp) {
        return "レートリミット情報が見つかりません。";
      }

      if (autoResume) {
        // 自動継続を設定
        workerState.autoResumeAfterRateLimit = true;
        await this.workspaceManager.saveWorkerState(workerState);

        await this.logAuditEntry(threadId, "rate_limit_auto_resume_enabled", {
          timestamp: workerState.rateLimitTimestamp,
        });

        const resumeTime = new Date(
          workerState.rateLimitTimestamp * 1000 +
            RATE_LIMIT.AUTO_RESUME_DELAY_MS,
        );
        const resumeTimeStr = resumeTime.toLocaleString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });

        // タイマーを設定
        this.scheduleAutoResume(threadId, workerState.rateLimitTimestamp);

        return `自動継続が設定されました。${resumeTimeStr}頃にキューに溜まったメッセージを自動的に処理します。`;
      }
      // 手動再開を選択
      workerState.autoResumeAfterRateLimit = false;
      await this.workspaceManager.saveWorkerState(workerState);

      await this.logAuditEntry(
        threadId,
        "rate_limit_manual_resume_selected",
        {
          timestamp: workerState.rateLimitTimestamp,
        },
      );

      return "手動での再開が選択されました。制限解除後に手動でメッセージを送信してください。";
    } catch (error) {
      console.error("レートリミットボタン処理でエラーが発生しました:", error);
      return "処理中にエラーが発生しました。";
    }
  }

  /**
   * レートリミット後の自動再開をスケジュールする
   */
  scheduleAutoResume(
    threadId: string,
    rateLimitTimestamp: number,
  ): void {
    // 既存のタイマーがあればクリア
    const existingTimer = this.autoResumeTimers.get(threadId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 5分後に再開するタイマーを設定
    const resumeTime = rateLimitTimestamp * 1000 +
      RATE_LIMIT.AUTO_RESUME_DELAY_MS;
    const currentTime = Date.now();
    const delay = Math.max(0, resumeTime - currentTime);

    this.logVerbose("自動再開タイマー設定", {
      threadId,
      rateLimitTimestamp,
      resumeTime: new Date(resumeTime).toISOString(),
      delayMs: delay,
    });

    const timerId = setTimeout(async () => {
      try {
        this.logVerbose("自動再開実行開始", { threadId });
        await this.executeAutoResume(threadId);
      } catch (error) {
        console.error(
          `自動再開の実行に失敗しました (threadId: ${threadId}):`,
          error,
        );
      } finally {
        this.autoResumeTimers.delete(threadId);
      }
    }, delay);

    this.autoResumeTimers.set(threadId, timerId);
  }

  /**
   * 自動再開を実行する
   */
  async executeAutoResume(threadId: string): Promise<void> {
    try {
      const workerState = await this.workspaceManager.loadWorkerState(threadId);
      if (!workerState || !workerState.autoResumeAfterRateLimit) {
        this.logVerbose(
          "自動再開がキャンセルされているか、Worker情報が見つかりません",
          { threadId },
        );
        return;
      }

      await this.logAuditEntry(threadId, "auto_resume_executed", {
        rateLimitTimestamp: workerState.rateLimitTimestamp,
        resumeTime: new Date().toISOString(),
      });

      // レートリミット情報をリセット
      workerState.rateLimitTimestamp = undefined;
      workerState.autoResumeAfterRateLimit = undefined;
      await this.workspaceManager.saveWorkerState(workerState);

      // Discordステータスを通常に戻す
      await this.updateDiscordStatusToNormal();

      // キューに溜まったメッセージを処理
      const queuedMessages = workerState.queuedMessages || [];
      if (queuedMessages.length > 0) {
        // キューをクリア
        workerState.queuedMessages = [];
        await this.workspaceManager.saveWorkerState(workerState);
      }

      if (queuedMessages.length > 0) {
        this.logVerbose("キューからメッセージを処理", {
          threadId,
          messageCount: queuedMessages.length,
        });

        // 最初のメッセージを処理
        if (this.onAutoResumeMessage) {
          const firstMessage = queuedMessages[0];
          await this.onAutoResumeMessage(threadId, firstMessage.content);

          // 監査ログに記録
          await this.logAuditEntry(threadId, "queued_message_processed", {
            messageId: firstMessage.messageId,
            authorId: firstMessage.authorId,
            queuePosition: 1,
            totalQueued: queuedMessages.length,
          });
        }
      } else {
        // キューが空の場合は何もしない
        this.logVerbose("キューが空のため処理をスキップ", { threadId });
      }
    } catch (error) {
      this.logVerbose("自動再開の実行でエラー", {
        threadId,
        error: (error as Error).message,
      });
      console.error(
        `自動再開の実行でエラーが発生しました (threadId: ${threadId}):`,
        error,
      );
    }
  }

  /**
   * スレッド終了時に自動再開タイマーをクリアする
   */
  clearAutoResumeTimer(threadId: string): void {
    const timerId = this.autoResumeTimers.get(threadId);
    if (timerId) {
      clearTimeout(timerId);
      this.autoResumeTimers.delete(threadId);
      this.logVerbose("自動再開タイマーをクリア", { threadId });
    }
  }

  /**
   * レートリミット自動継続タイマーを復旧する
   */
  async restoreRateLimitTimers(): Promise<void> {
    this.logVerbose("レートリミットタイマー復旧開始");

    try {
      const allWorkerStates = await this.workspaceManager.getAllWorkerStates();
      const rateLimitWorkers = allWorkerStates.filter(
        (worker) =>
          worker.status === "active" &&
          worker.autoResumeAfterRateLimit === true &&
          worker.rateLimitTimestamp,
      );

      this.logVerbose("レートリミット復旧対象Worker発見", {
        totalWorkers: allWorkerStates.length,
        rateLimitWorkers: rateLimitWorkers.length,
      });

      for (const workerState of rateLimitWorkers) {
        try {
          await this.restoreRateLimitTimer(workerState);
        } catch (error) {
          this.logVerbose("レートリミットタイマー復旧失敗", {
            threadId: workerState.threadId,
            error: (error as Error).message,
          });
          console.error(
            `レートリミットタイマーの復旧に失敗しました (threadId: ${workerState.threadId}):`,
            error,
          );
        }
      }

      this.logVerbose("レートリミットタイマー復旧完了", {
        restoredTimerCount: rateLimitWorkers.length,
      });
    } catch (error) {
      this.logVerbose("レートリミットタイマー復旧でエラー", {
        error: (error as Error).message,
      });
      console.error(
        "レートリミットタイマーの復旧でエラーが発生しました:",
        error,
      );
    }
  }

  /**
   * 単一スレッドのレートリミットタイマーを復旧する
   */
  private async restoreRateLimitTimer(workerState: WorkerState): Promise<void> {
    if (!workerState.rateLimitTimestamp) {
      return;
    }

    const currentTime = Date.now();
    const resumeTime = workerState.rateLimitTimestamp * 1000 +
      RATE_LIMIT.AUTO_RESUME_DELAY_MS;

    // 既に時間が過ぎている場合は即座に実行
    if (currentTime >= resumeTime) {
      this.logVerbose("レートリミット時間が既に過ぎているため即座に実行", {
        threadId: workerState.threadId,
        rateLimitTimestamp: workerState.rateLimitTimestamp,
        currentTime: new Date(currentTime).toISOString(),
        resumeTime: new Date(resumeTime).toISOString(),
      });

      // 即座に自動再開を実行
      await this.executeAutoResume(workerState.threadId);

      await this.logAuditEntry(
        workerState.threadId,
        "rate_limit_timer_restored_immediate",
        {
          rateLimitTimestamp: workerState.rateLimitTimestamp,
          currentTime: new Date(currentTime).toISOString(),
        },
      );
    } else {
      // まだ時間が残っている場合はタイマーを再設定
      this.logVerbose("レートリミットタイマーを再設定", {
        threadId: workerState.threadId,
        rateLimitTimestamp: workerState.rateLimitTimestamp,
        resumeTime: new Date(resumeTime).toISOString(),
        delayMs: resumeTime - currentTime,
      });

      this.scheduleAutoResume(
        workerState.threadId,
        workerState.rateLimitTimestamp,
      );

      await this.logAuditEntry(
        workerState.threadId,
        "rate_limit_timer_restored",
        {
          rateLimitTimestamp: workerState.rateLimitTimestamp,
          resumeTime: new Date(resumeTime).toISOString(),
          delayMs: resumeTime - currentTime,
        },
      );
    }
  }

  /**
   * メッセージをキューに追加する
   */
  async queueMessage(
    threadId: string,
    messageId: string,
    content: string,
    authorId: string,
  ): Promise<void> {
    const workerState = await this.workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      const queuedMessage: QueuedMessage = {
        messageId,
        content,
        timestamp: Date.now(),
        authorId,
      };

      if (!workerState.queuedMessages) {
        workerState.queuedMessages = [];
      }
      workerState.queuedMessages.push(queuedMessage);
      await this.workspaceManager.saveWorkerState(workerState);

      this.logVerbose("メッセージをキューに追加", {
        threadId,
        messageId,
        queueLength: workerState.queuedMessages.length,
      });
    }
  }

  /**
   * レートリミット中かどうかを確認する
   */
  async isRateLimited(threadId: string): Promise<boolean> {
    const workerState = await this.workspaceManager.loadWorkerState(threadId);
    return !!(workerState?.rateLimitTimestamp);
  }

  /**
   * 監査ログエントリを記録する
   */
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
   * レートリミット時にDiscordステータスを更新する
   */
  private async updateDiscordStatusForRateLimit(
    _timestamp: number,
  ): Promise<void> {
    if (!this.discordClient) {
      return;
    }

    try {
      const rateLimitStatus = await this.rateLimitStatusSource.getStatusText();

      await this.discordClient.user?.setPresence({
        activities: [{
          name: rateLimitStatus,
          type: ActivityType.Watching,
        }],
        status: PresenceUpdateStatus.DoNotDisturb,
      });

      this.logVerbose("Discord ステータスを制限中に更新", {
        rateLimitStatus,
      });
    } catch (error) {
      console.error("Discord ステータス更新に失敗しました:", error);
    }
  }

  /**
   * Discordステータスを通常に戻す
   */
  private async updateDiscordStatusToNormal(): Promise<void> {
    if (!this.discordClient) {
      return;
    }

    try {
      const rateLimitStatus = await this.rateLimitStatusSource.getStatusText();
      await this.discordClient.user?.setPresence({
        activities: [{
          name: rateLimitStatus,
          type: ActivityType.Playing,
        }],
        status: PresenceUpdateStatus.Online,
      });

      this.logVerbose("Discord ステータスを通常に復旧（Codexレート制限表示）", {
        rateLimitStatus,
      });
    } catch (error) {
      console.error("Discord ステータス復旧に失敗しました:", error);
    }
  }

  /**
   * トークン使用量を追跡する
   */
  trackTokenUsage(inputTokens: number, outputTokens: number): void {
    this.tokenUsageTracker.addTokenUsage(inputTokens, outputTokens);
    this.logVerbose("トークン使用量を追跡", {
      inputTokens,
      outputTokens,
      currentUsage: this.tokenUsageTracker.getCurrentUsage(),
      usagePercentage: this.tokenUsageTracker.getUsagePercentage(),
    });
  }

  /**
   * 現在のトークン使用量情報を取得
   */
  getTokenUsageInfo() {
    return this.tokenUsageTracker.getUsageInfo();
  }

  /**
   * Discordステータスを定期的に更新する
   */
  async updateDiscordStatusWithTokenUsage(): Promise<void> {
    if (!this.discordClient) {
      return;
    }

    try {
      const rateLimitStatus = await this.rateLimitStatusSource.getStatusText();
      await this.discordClient.user?.setPresence({
        activities: [{
          name: rateLimitStatus,
          type: ActivityType.Playing,
        }],
        status: PresenceUpdateStatus.Online,
      });

      this.logVerbose("Discord ステータスを更新（Codexレート制限表示）", {
        rateLimitStatus,
      });
    } catch (error) {
      console.error("Discord ステータス更新に失敗しました:", error);
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
      const logMessage = `[${timestamp}] [RateLimitManager] ${message}`;
      console.log(logMessage);

      if (metadata && Object.keys(metadata).length > 0) {
        console.log(`[${timestamp}] [RateLimitManager] メタデータ:`, metadata);
      }
    }
  }
}
