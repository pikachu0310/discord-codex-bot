import { ActivityType, type Client, PresenceUpdateStatus } from "discord.js";
import type { TokenUsageTrackerOptions } from "../token-usage-tracker.ts";
import { TokenUsageTracker } from "../token-usage-tracker.ts";

export interface StatusSummary {
  windows: Array<{
    label: string;
    usedTokens: number;
    limitTokens: number;
    usedPercentage: number;
    remainingPercentage: number;
  }>;
  nextResetUTC: string;
  nextResetJST: string;
}

export class RateLimitManager {
  private discordClient?: Client;
  private readonly tracker: TokenUsageTracker;

  constructor(
    private readonly verbose = false,
    options?: TokenUsageTrackerOptions,
  ) {
    this.tracker = new TokenUsageTracker(options);
  }

  setDiscordClient(client: Client): void {
    this.discordClient = client;
  }

  trackTokenUsage(
    inputTokens: number,
    outputTokens: number,
    dedupeKey?: string,
  ): void {
    const added = this.tracker.addTokenUsage(
      inputTokens,
      outputTokens,
      dedupeKey,
    );
    if (this.verbose && added) {
      console.log("[RateLimitManager] usage tracked", {
        inputTokens,
        outputTokens,
        dedupeKey,
        remainingPercentage: this.tracker.getRemainingPercentage(),
      });
    }
  }

  createRateLimitMessage(): string {
    return "Codexのレート制限に達しました。時間を置いて再実行してください。";
  }

  getStatusSummary(): StatusSummary {
    const info = this.tracker.getUsageInfo();
    const windows = this.tracker.getWindowStatuses();
    const jst = new Date(info.nextResetTime).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    return {
      windows: windows.map((item) => ({
        label: item.label,
        usedTokens: item.usedTokens,
        limitTokens: item.limitTokens,
        usedPercentage: item.usedPercentage,
        remainingPercentage: item.remainingPercentage,
      })),
      nextResetUTC: info.nextResetTimeUTC,
      nextResetJST: jst,
    };
  }

  async updateDiscordStatusWithTokenUsage(): Promise<void> {
    if (!this.discordClient) return;

    const info = this.tracker.getUsageInfo();
    await this.discordClient.user?.setPresence({
      activities: [{
        type: ActivityType.Playing,
        name:
          `残量 ${info.remainingPercentage}% | 24h ${info.currentUsage}/${info.maxTokens}`,
      }],
      status: PresenceUpdateStatus.Online,
    });
  }
}
