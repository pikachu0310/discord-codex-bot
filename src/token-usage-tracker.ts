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

export class TokenUsageTracker {
  private static readonly TOKEN_BASE = 100000; // 100k基準
  private static readonly RESET_INTERVAL_HOURS = 24; // 24時間でリセット
  private currentUsage = 0;
  private lastResetTime = new Date();

  constructor() {
    this.initializeResetTime();
  }

  /**
   * リセット時刻を初期化（毎日午前0時UTC）
   */
  private initializeResetTime(): void {
    const now = new Date();
    
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
    this.currentUsage += inputTokens + outputTokens;
  }

  /**
   * 必要に応じてトークンカウントをリセット
   */
  private checkAndResetIfNeeded(): void {
    const now = new Date();
    const timeSinceReset = now.getTime() - this.lastResetTime.getTime();
    const resetInterval = TokenUsageTracker.RESET_INTERVAL_HOURS * 60 * 60 *
      1000;

    if (timeSinceReset >= resetInterval) {
      this.currentUsage = 0;
      this.lastResetTime = now;
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

    const nextResetTime = this.getNextResetTime();
    const nextResetTimeUTC = nextResetTime.toISOString().slice(0, 16).replace('T', ' ');

    return {
      currentUsage: this.currentUsage,
      maxTokens: TokenUsageTracker.TOKEN_BASE,
      usagePercentage: Math.round(
        (this.currentUsage / TokenUsageTracker.TOKEN_BASE) * 100,
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
    return `${info.currentUsage}/${info.maxTokens} (${info.usagePercentage}%) ${info.nextResetTimeUTC}`;
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
    this.lastResetTime = new Date();
  }
}
