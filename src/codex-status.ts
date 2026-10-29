import { err, ok, Result } from "neverthrow";
import { AppServerConnection } from "./worker/codex-executor.ts";

export interface CodexUsageLimit {
  percentLeft: number;
  resets: string;
}

export interface CodexUsageStatus {
  fiveHour?: CodexUsageLimit;
  weekly: CodexUsageLimit;
  capturedAt: string;
}

export type CodexStatusError =
  | { type: "COMMAND_FAILED"; code: number; output: string }
  | { type: "COMMAND_TIMEOUT"; output: string }
  | { type: "PARSE_FAILED"; output: string }
  | { type: "UPDATE_REQUIRED"; output: string }
  | { type: "STATUS_UNAVAILABLE"; error: string };

interface CodexStatusProviderOptions {
  command?: string;
  timeoutMs?: number;
  timeZone?: string;
}
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`,
  "g",
);
const CSI_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const TERMINAL_MODE_PATTERN = new RegExp(`${ESCAPE}[=>][0-?]*`, "g");
const MONTHS = new Map([
  ["jan", 0],
  ["feb", 1],
  ["mar", 2],
  ["apr", 3],
  ["may", 4],
  ["jun", 5],
  ["jul", 6],
  ["aug", 7],
  ["sep", 8],
  ["oct", 9],
  ["nov", 10],
  ["dec", 11],
]);

export class CodexStatusProvider {
  constructor(private readonly options: CodexStatusProviderOptions = {}) {}

  async getStatus(
    cwd: string,
  ): Promise<Result<CodexUsageStatus, CodexStatusError>> {
    let connection: AppServerConnection | undefined;
    try {
      const process = new Deno.Command(this.options.command ?? "codex", {
        args: ["app-server"],
        cwd,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      connection = new AppServerConnection(
        process,
        () => {},
        () => {},
        this.options.timeoutMs ?? 9000,
      );
      await connection.request("initialize", {
        clientInfo: { name: "discord_codex_status", version: "1.0.0" },
      });
      await connection.write({ method: "initialized", params: {} });
      return parseCodexRateLimits(
        await connection.request("account/rateLimits/read", {}),
        normalizeTimeZone(this.options.timeZone) ?? "UTC",
      );
    } catch (error) {
      return err({
        type: "STATUS_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await connection?.dispose();
    }
  }
}

export function parseCodexRateLimits(
  response: Record<string, unknown>,
  timeZone = "UTC",
): Result<CodexUsageStatus, CodexStatusError> {
  type Window = {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
  };
  type Bucket = { primary?: Window | null; secondary?: Window | null };
  const buckets = response.rateLimitsByLimitId as
    | Record<string, Bucket>
    | undefined;
  const bucket = buckets?.codex ?? response.rateLimits as Bucket | undefined;
  const windows = [bucket?.primary, bucket?.secondary];
  const limit = (minutes: number): CodexUsageLimit | undefined => {
    const window = windows.find((w) => w?.windowDurationMins === minutes);
    if (
      !window || !Number.isFinite(window.usedPercent) ||
      !Number.isFinite(window.resetsAt)
    ) return;
    return {
      percentLeft: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      resets: formatDateTimeInZone(new Date(window.resetsAt * 1000), timeZone),
    };
  };
  const weekly = limit(10080);
  if (!weekly) {
    return err({
      type: "STATUS_UNAVAILABLE",
      error: "週の利用枠を取得できませんでした。",
    });
  }
  return ok({
    fiveHour: limit(300),
    weekly,
    capturedAt: new Date().toISOString(),
  });
}

export function parseCodexStatus(
  output: string,
): Result<CodexUsageStatus, CodexStatusError> {
  const cleaned = stripTerminalControlSequences(output).replace(/\s+/g, " ");
  const fiveHour = parseLimit(cleaned, "5h limit");
  const weekly = parseLimit(cleaned, "Weekly limit");

  if (!weekly) {
    return err({ type: "PARSE_FAILED", output });
  }

  return ok({
    fiveHour: fiveHour ?? undefined,
    weekly,
    capturedAt: new Date().toISOString(),
  });
}

export function normalizeTimeZone(timeZone?: string): string | undefined {
  const trimmed = timeZone?.trim();
  if (!trimmed) return undefined;
  const upper = trimmed.toUpperCase();
  if (upper === "JST" || upper === "JTC") return "Asia/Tokyo";
  if (upper === "UTC" || upper === "Z") return "UTC";
  return trimmed;
}

export function convertCodexStatusTimeZone(
  status: CodexUsageStatus,
  timeZone: string,
): CodexUsageStatus {
  return {
    ...status,
    fiveHour: status.fiveHour
      ? {
        ...status.fiveHour,
        resets: convertResetTime(
          status.fiveHour.resets,
          status.capturedAt,
          timeZone,
        ),
      }
      : undefined,
    weekly: {
      ...status.weekly,
      resets: convertResetTime(
        status.weekly.resets,
        status.capturedAt,
        timeZone,
      ),
    },
  };
}

function convertResetTime(
  resets: string,
  capturedAt: string,
  timeZone: string,
): string {
  const parsed = parseResetTimeAsUtc(resets, capturedAt);
  if (!parsed) return resets;
  try {
    return parsed.hasDate
      ? formatDateTimeInZone(parsed.date, timeZone)
      : formatTimeInZone(parsed.date, timeZone);
  } catch {
    return resets;
  }
}

function parseResetTimeAsUtc(
  resets: string,
  capturedAt: string,
): { date: Date; hasDate: boolean } | null {
  const match = resets.match(
    /^(\d{1,2}):(\d{2})(?: on (\d{1,2}) ([A-Za-z]+))?$/,
  );
  if (!match) return null;

  const captured = new Date(capturedAt);
  if (Number.isNaN(captured.getTime())) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  if (match[3] && match[4]) {
    const month = MONTHS.get(match[4].slice(0, 3).toLowerCase());
    if (month === undefined) return null;
    let date = new Date(Date.UTC(
      captured.getUTCFullYear(),
      month,
      Number(match[3]),
      hour,
      minute,
    ));
    if (date.getTime() < captured.getTime()) {
      date = new Date(Date.UTC(
        captured.getUTCFullYear() + 1,
        month,
        Number(match[3]),
        hour,
        minute,
      ));
    }
    return { date, hasDate: true };
  }

  let date = new Date(Date.UTC(
    captured.getUTCFullYear(),
    captured.getUTCMonth(),
    captured.getUTCDate(),
    hour,
    minute,
  ));
  if (date.getTime() < captured.getTime()) {
    date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  return { date, hasDate: false };
}

function formatTimeInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatDateTimeInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("hour")}:${value("minute")} on ${value("day")} ${
    value("month")
  }`;
}

function parseLimit(text: string, label: string): CodexUsageLimit | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `${escapedLabel}:\\s*(?:\\[[^\\]]+\\]\\s*)?(\\d+)% left[\\s│]*\\(resets ([^)]+)\\)`,
    "i",
  ).exec(text);
  if (!match) return null;

  return {
    percentLeft: Number(match[1]),
    resets: match[2].trim(),
  };
}

export function stripTerminalControlSequences(text: string): string {
  return text
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(CSI_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_MODE_PATTERN, "")
    .split("")
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint === 10 || codePoint === 13 ||
        codePoint === 9 || codePoint >= 32;
    })
    .join("");
}

export function isCodexUpdatePrompt(output: string): boolean {
  const cleaned = stripTerminalControlSequences(output).replace(/\s+/g, " ");
  return cleaned.includes("Update available!") &&
    cleaned.includes("codex") &&
    (cleaned.includes("Update now") ||
      cleaned.includes("npm install -g @openai/codex") ||
      cleaned.includes("codex update"));
}

export function formatCodexStatus(status: CodexUsageStatus): string {
  const limits = status.fiveHour
    ? [
      `5h limit: ${status.fiveHour.percentLeft}% left (resets ${status.fiveHour.resets})`,
    ]
    : [];
  limits.push(
    `Weekly limit: ${status.weekly.percentLeft}% left (resets ${status.weekly.resets})`,
  );
  return limits.join("\n");
}

export function formatCodexStatusPresence(status: CodexUsageStatus): string {
  const limits = status.fiveHour
    ? [`5h ${status.fiveHour.percentLeft}% (${status.fiveHour.resets})`]
    : [];
  limits.push(`W ${status.weekly.percentLeft}% (${status.weekly.resets})`);
  return limits.join(" / ");
}

export function formatCodexStatusDelta(
  before: CodexUsageStatus,
  after: CodexUsageStatus,
): string {
  const limits = before.fiveHour && after.fiveHour
    ? [
      `5h limit ${before.fiveHour.percentLeft}% → ${after.fiveHour.percentLeft}% (resets ${after.fiveHour.resets})`,
    ]
    : [];
  limits.push(
    `Weekly limit ${before.weekly.percentLeft}% → ${after.weekly.percentLeft}% (resets ${after.weekly.resets})`,
  );
  return limits.join("\n");
}
