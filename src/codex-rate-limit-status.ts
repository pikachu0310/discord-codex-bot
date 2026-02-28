import { fromFileUrl } from "std/path/mod.ts";

export interface CodexRateLimitWindow {
  usedPercent: number;
  secondsUntilReset: number | null;
  resetTimeText: string | null;
  outdated: boolean;
}

export interface CodexRateLimitSnapshot {
  fiveHour?: CodexRateLimitWindow;
  weekly?: CodexRateLimitWindow;
}

export interface CommandExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandExecutionResult>;

export interface RateLimitStatusSource {
  getStatusText(): Promise<string>;
}

export interface CodexRateLimitStatusProviderOptions {
  checkerScriptPath?: string;
  inputFolder?: string;
  now?: () => number;
  pythonCommands?: string[];
  commandRunner?: CommandRunner;
}

type RawWindow = {
  used_percent?: unknown;
  seconds_until_reset?: unknown;
  reset_time?: unknown;
  outdated?: unknown;
};

type RawSnapshot = {
  error?: unknown;
  limit_5h?: unknown;
  limit_weekly?: unknown;
};

const DEFAULT_CHECKER_SCRIPT_PATH = fromFileUrl(
  new URL("../scripts/ratelimit_checker.py", import.meta.url),
);

export class CodexRateLimitStatusProvider implements RateLimitStatusSource {
  private readonly checkerScriptPath: string;
  private readonly inputFolder?: string;
  private readonly now: () => number;
  private readonly pythonCommands: string[];
  private readonly commandRunner: CommandRunner;

  constructor(options?: CodexRateLimitStatusProviderOptions) {
    this.checkerScriptPath = options?.checkerScriptPath ??
      DEFAULT_CHECKER_SCRIPT_PATH;
    this.inputFolder = options?.inputFolder;
    this.now = options?.now ?? (() => Date.now());
    this.pythonCommands = options?.pythonCommands ?? ["python3", "python"];
    this.commandRunner = options?.commandRunner ?? defaultCommandRunner;
  }

  async getStatusText(): Promise<string> {
    try {
      const snapshot = await this.getSnapshot();
      if (!snapshot) {
        return "RL取得不可";
      }
      return this.formatSnapshot(snapshot);
    } catch (error) {
      console.error("Codexレートリミット状態の取得に失敗しました:", error);
      return "RL取得不可";
    }
  }

  private async getSnapshot(): Promise<CodexRateLimitSnapshot | null> {
    const rawOutput = await this.runChecker();
    const parsed = JSON.parse(rawOutput) as RawSnapshot;
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return null;
    }

    const fiveHour = this.parseWindow(parsed.limit_5h);
    const weekly = this.parseWindow(parsed.limit_weekly);

    if (!fiveHour && !weekly) {
      return null;
    }

    return {
      fiveHour,
      weekly,
    };
  }

  private async runChecker(): Promise<string> {
    const args = [this.checkerScriptPath, "--json"];
    if (this.inputFolder) {
      args.push("--input-folder", this.inputFolder);
    }

    let lastError: Error | null = null;

    for (const command of this.pythonCommands) {
      try {
        const result = await this.commandRunner(command, args);
        if (result.code === 0) {
          return result.stdout;
        }

        const details = result.stderr.trim() || result.stdout.trim() ||
          `exit code ${result.code}`;
        lastError = new Error(`${command}: ${details}`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Python command not available");
  }

  private parseWindow(rawWindow: unknown): CodexRateLimitWindow | undefined {
    if (!rawWindow || typeof rawWindow !== "object") {
      return undefined;
    }

    const typedWindow = rawWindow as RawWindow;
    const usedPercent = toFiniteNumber(typedWindow.used_percent);
    if (usedPercent === null) {
      return undefined;
    }

    const secondsUntilReset = toFiniteNumber(typedWindow.seconds_until_reset);
    const resetTimeText = typeof typedWindow.reset_time === "string"
      ? typedWindow.reset_time
      : null;

    return {
      usedPercent: clampPercentage(usedPercent),
      secondsUntilReset,
      resetTimeText,
      outdated: typedWindow.outdated === true,
    };
  }

  private formatSnapshot(snapshot: CodexRateLimitSnapshot): string {
    const parts = [
      this.formatWindow("5h", snapshot.fiveHour, false),
      this.formatWindow("1w", snapshot.weekly, true),
    ];

    return parts.join(" ");
  }

  private formatWindow(
    label: string,
    window: CodexRateLimitWindow | undefined,
    includeDate: boolean,
  ): string {
    if (!window) {
      return `${label}残り--.-%(--)`;
    }

    const remainingPercent = window.outdated
      ? 100
      : clampPercentage(100 - window.usedPercent);
    const resetLabel = this.formatResetTime(window, includeDate);

    return `${label}残り${remainingPercent.toFixed(1)}%(${resetLabel})`;
  }

  private formatResetTime(
    window: CodexRateLimitWindow,
    includeDate: boolean,
  ): string {
    if (window.outdated) {
      return "済";
    }

    const resetTime = this.resolveResetTime(window);
    if (!resetTime) {
      return "--";
    }

    const month = String(resetTime.getMonth() + 1).padStart(2, "0");
    const day = String(resetTime.getDate()).padStart(2, "0");
    const hour = String(resetTime.getHours()).padStart(2, "0");
    const minute = String(resetTime.getMinutes()).padStart(2, "0");

    if (includeDate) {
      return `${month}/${day} ${hour}:${minute}`;
    }

    return `${hour}:${minute}`;
  }

  private resolveResetTime(window: CodexRateLimitWindow): Date | null {
    if (
      typeof window.secondsUntilReset === "number" &&
      Number.isFinite(window.secondsUntilReset)
    ) {
      const clampedSeconds = Math.max(0, window.secondsUntilReset);
      return new Date(this.now() + clampedSeconds * 1000);
    }

    if (window.resetTimeText) {
      return parseLocalDateTime(window.resetTimeText);
    }

    return null;
  }
}

async function defaultCommandRunner(
  command: string,
  args: string[],
): Promise<CommandExecutionResult> {
  const decoder = new TextDecoder();
  const process = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await process.output();

  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseLocalDateTime(value: string): Date | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const parsedDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}
