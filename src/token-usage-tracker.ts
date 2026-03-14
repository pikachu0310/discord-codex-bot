/**
 * Codexのトークン使用量を追跡し、100k基準での使用率と次回リセット時刻を管理するクラス
 */

export interface TokenUsageInfo {
  currentUsage: number;
  maxTokens: number;
  usagePercentage: number;
  nextResetTime: Date;
  nextResetTimeUTC: string;
}

export interface TokenUsageTrackerOptions {
  tokenBase?: number;
  fiveHourLimit?: number;
  weeklyLimit?: number;
  now?: () => number;
}

type TokenUsageEntry = {
  timestamp: number;
  tokens: number;
};

export class TokenUsageTracker {
  private static readonly TOKEN_BASE = 100000; // 100k基準
  private static readonly RESET_INTERVAL_HOURS = 24; // 24時間でリセット
  private static readonly FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
  private static readonly ONE_WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  private currentUsage = 0;
  private lastResetTime = new Date();
  private readonly tokenBase: number;
  private readonly fiveHourLimit?: number;
  private readonly weeklyLimit?: number;
  private readonly now: () => number;
  private usageHistory: TokenUsageEntry[] = [];

  constructor(options?: TokenUsageTrackerOptions) {
    this.tokenBase = options?.tokenBase ?? TokenUsageTracker.TOKEN_BASE;
    this.fiveHourLimit = options?.fiveHourLimit;
    this.weeklyLimit = options?.weeklyLimit;
    this.now = options?.now ?? (() => Date.now());
    this.initializeResetTime();
  }

  /**
   * リセット時刻を初期化（毎日午前0時UTC）
   */
  private initializeResetTime(): void {
    const now = new Date(this.now());

    // 今日の午前0時UTC
    const todayMidnightUTC = new Date(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );

    this.lastResetTime = todayMidnightUTC;
  }

  /**
   * トークン使用量を追加
   */
  addTokenUsage(inputTokens: number, outputTokens: number): void {
    this.checkAndResetIfNeeded();
    const tokens = inputTokens + outputTokens;
    this.currentUsage += tokens;
    this.usageHistory.push({
      timestamp: this.now(),
      tokens,
    });
    this.cleanupUsageHistory();
  }

  /**
   * 必要に応じてトークンカウントをリセット
   */
  private checkAndResetIfNeeded(): void {
    const nowMs = this.now();
    const timeSinceReset = nowMs - this.lastResetTime.getTime();
    const resetInterval = TokenUsageTracker.RESET_INTERVAL_HOURS * 60 * 60 *
      1000;

    if (timeSinceReset >= resetInterval) {
      this.currentUsage = 0;
      this.lastResetTime = new Date(nowMs);
      this.usageHistory = [];
    }
  }

  /**
   * 次回リセット時刻を取得
   */
  private getNextResetTime(): Date {
    const resetInterval = TokenUsageTracker.RESET_INTERVAL_HOURS * 60 * 60 *
      1000;
    return new Date(this.lastResetTime.getTime() + resetInterval);
  }

  /**
   * 現在のトークン使用量情報を取得
   */
  getUsageInfo(): TokenUsageInfo {
    this.checkAndResetIfNeeded();
    this.cleanupUsageHistory();

    const nextResetTime = this.getNextResetTime();
    const nextResetTimeUTC = nextResetTime.toISOString().slice(0, 16).replace(
      "T",
      " ",
    );

    return {
      currentUsage: this.currentUsage,
      maxTokens: this.tokenBase,
      usagePercentage: Math.round(
        (this.currentUsage / this.tokenBase) * 100,
      ),
      nextResetTime,
      nextResetTimeUTC,
    };
  }

  /**
   * ステータス表示用の文字列を生成
   */
  getStatusString(): string {
    const info = this.getUsageInfo();
    const parts = [
      `${info.currentUsage}/${info.maxTokens} (${info.usagePercentage}%)`,
    ];

    const windowStatuses = this.getWindowStatusParts();
    if (windowStatuses.length > 0) {
      parts.push(windowStatuses.join(" "));
    }

    parts.push(`次回リセット: ${info.nextResetTimeUTC}`);
    return parts.join(" | ");
  }

  /**
   * 現在の使用率を取得（0-100の数値）
   */
  getUsagePercentage(): number {
    return this.getUsageInfo().usagePercentage;
  }

  /**
   * 現在の使用量を取得
   */
  getCurrentUsage(): number {
    this.checkAndResetIfNeeded();
    return this.currentUsage;
  }

  /**
   * 手動でリセットを実行
   */
  reset(): void {
    this.currentUsage = 0;
    this.lastResetTime = new Date(this.now());
    this.usageHistory = [];
  }

  private cleanupUsageHistory(): void {
    const cutoff = this.now() - TokenUsageTracker.ONE_WEEK_WINDOW_MS;
    while (
      this.usageHistory.length > 0 &&
      this.usageHistory[0].timestamp < cutoff
    ) {
      this.usageHistory.shift();
    }
  }

  private getWindowStatusParts(): string[] {
    const parts: string[] = [];
    const fiveHour = this.formatWindowStatus(
      "5h",
      TokenUsageTracker.FIVE_HOUR_WINDOW_MS,
      this.fiveHourLimit,
    );
    if (fiveHour) {
      parts.push(fiveHour);
    }

    const weekly = this.formatWindowStatus(
      "1w",
      TokenUsageTracker.ONE_WEEK_WINDOW_MS,
      this.weeklyLimit,
    );
    if (weekly) {
      parts.push(weekly);
    }

    return parts;
  }

  private formatWindowStatus(
    label: string,
    windowMs: number,
    limit?: number,
  ): string | null {
    if (!limit || limit <= 0) {
      return null;
    }
    const usage = this.getWindowUsage(windowMs);
    const percentage = Math.min(100, Math.round((usage / limit) * 100));
    return `${label}:${percentage}%`;
  }

  private getWindowUsage(windowMs: number): number {
    this.cleanupUsageHistory();
    const threshold = this.now() - windowMs;
    let total = 0;
    for (const entry of this.usageHistory) {
      if (entry.timestamp >= threshold) {
        total += entry.tokens;
      }
    }
    return total;
  }
}
