export interface TokenUsageInfo {
  currentUsage: number;
  maxTokens: number;
  usagePercentage: number;
  remainingPercentage: number;
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
  dedupeKey?: string;
};

export interface WindowUsageStatus {
  label: "24h" | "5h" | "1w";
  usedTokens: number;
  limitTokens: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export class TokenUsageTracker {
  private static readonly RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
    this.tokenBase = options?.tokenBase ?? 100000;
    this.fiveHourLimit = options?.fiveHourLimit;
    this.weeklyLimit = options?.weeklyLimit;
    this.now = options?.now ?? (() => Date.now());
    this.initializeResetTimeUTC();
  }

  private initializeResetTimeUTC(): void {
    const now = new Date(this.now());
    this.lastResetTime = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ));
  }

  addTokenUsage(
    inputTokens: number,
    outputTokens: number,
    dedupeKey?: string,
  ): boolean {
    this.checkAndResetIfNeeded();

    const totalTokens = Math.max(0, inputTokens) + Math.max(0, outputTokens);
    if (totalTokens <= 0) {
      return false;
    }

    if (dedupeKey && this.hasDedupeKey(dedupeKey)) {
      return false;
    }

    this.currentUsage += totalTokens;
    this.usageHistory.push({
      timestamp: this.now(),
      tokens: totalTokens,
      dedupeKey,
    });
    this.cleanupUsageHistory();
    return true;
  }

  private hasDedupeKey(dedupeKey: string): boolean {
    for (let i = this.usageHistory.length - 1; i >= 0; i--) {
      if (this.usageHistory[i].dedupeKey === dedupeKey) {
        return true;
      }
      // 直近1週間を超える履歴は掃除対象なので探索を打ち切る
      if (
        this.usageHistory[i].timestamp <
          this.now() - TokenUsageTracker.ONE_WEEK_WINDOW_MS
      ) {
        break;
      }
    }
    return false;
  }

  private checkAndResetIfNeeded(): void {
    const nowMs = this.now();
    if (
      nowMs - this.lastResetTime.getTime() >=
        TokenUsageTracker.RESET_INTERVAL_MS
    ) {
      this.currentUsage = 0;
      this.lastResetTime = new Date(nowMs);
      this.usageHistory = [];
    }
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

  private getNextResetTime(): Date {
    return new Date(
      this.lastResetTime.getTime() + TokenUsageTracker.RESET_INTERVAL_MS,
    );
  }

  getUsageInfo(): TokenUsageInfo {
    this.checkAndResetIfNeeded();
    this.cleanupUsageHistory();

    const usagePercentage = Math.min(
      100,
      Math.round((this.currentUsage / this.tokenBase) * 100),
    );
    const remainingPercentage = Math.max(0, 100 - usagePercentage);
    const nextResetTime = this.getNextResetTime();

    return {
      currentUsage: this.currentUsage,
      maxTokens: this.tokenBase,
      usagePercentage,
      remainingPercentage,
      nextResetTime,
      nextResetTimeUTC: nextResetTime.toISOString().slice(0, 16).replace(
        "T",
        " ",
      ),
    };
  }

  getWindowStatuses(): WindowUsageStatus[] {
    const info = this.getUsageInfo();
    const statuses: WindowUsageStatus[] = [{
      label: "24h",
      usedTokens: info.currentUsage,
      limitTokens: info.maxTokens,
      usedPercentage: info.usagePercentage,
      remainingPercentage: info.remainingPercentage,
    }];

    if (this.fiveHourLimit && this.fiveHourLimit > 0) {
      const used = this.getWindowUsage(TokenUsageTracker.FIVE_HOUR_WINDOW_MS);
      const usedPct = Math.min(
        100,
        Math.round((used / this.fiveHourLimit) * 100),
      );
      statuses.push({
        label: "5h",
        usedTokens: used,
        limitTokens: this.fiveHourLimit,
        usedPercentage: usedPct,
        remainingPercentage: Math.max(0, 100 - usedPct),
      });
    }

    if (this.weeklyLimit && this.weeklyLimit > 0) {
      const used = this.getWindowUsage(TokenUsageTracker.ONE_WEEK_WINDOW_MS);
      const usedPct = Math.min(
        100,
        Math.round((used / this.weeklyLimit) * 100),
      );
      statuses.push({
        label: "1w",
        usedTokens: used,
        limitTokens: this.weeklyLimit,
        usedPercentage: usedPct,
        remainingPercentage: Math.max(0, 100 - usedPct),
      });
    }

    return statuses;
  }

  getStatusString(): string {
    const [base, ...others] = this.getWindowStatuses();
    const compact = [
      `残量 ${base.remainingPercentage}%`,
      `24h ${base.usedTokens}/${base.limitTokens}`,
    ];
    for (const status of others) {
      compact.push(`${status.label} 残量${status.remainingPercentage}%`);
    }
    return compact.join(" | ");
  }

  getCurrentUsage(): number {
    this.checkAndResetIfNeeded();
    return this.currentUsage;
  }

  getUsagePercentage(): number {
    return this.getUsageInfo().usagePercentage;
  }

  getRemainingPercentage(): number {
    return this.getUsageInfo().remainingPercentage;
  }

  reset(): void {
    this.currentUsage = 0;
    this.lastResetTime = new Date(this.now());
    this.usageHistory = [];
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
