import { err, ok, Result } from "neverthrow";

export interface CodexUsageLimit {
  percentLeft: number;
  resets: string;
}

export interface CodexUsageStatus {
  fiveHour: CodexUsageLimit;
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
  startupDelayMs?: number;
  statusRenderDelayMs?: number;
  timeoutMs?: number;
  timeZone?: string;
}

const DEFAULT_STARTUP_DELAY_MS = 2000;
const DEFAULT_STATUS_RENDER_DELAY_MS = 3000;
const DEFAULT_TIMEOUT_MS = 9000;
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
  private readonly command: string;
  private readonly startupDelayMs: number;
  private readonly statusRenderDelayMs: number;
  private readonly timeoutMs: number;
  private readonly timeZone?: string;

  constructor(options: CodexStatusProviderOptions = {}) {
    this.command = options.command ??
      "stty rows 30 cols 100; codex --no-alt-screen";
    this.startupDelayMs = options.startupDelayMs ??
      DEFAULT_STARTUP_DELAY_MS;
    this.statusRenderDelayMs = options.statusRenderDelayMs ??
      DEFAULT_STATUS_RENDER_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeZone = normalizeTimeZone(options.timeZone);
  }

  async getStatus(
    cwd: string,
  ): Promise<Result<CodexUsageStatus, CodexStatusError>> {
    try {
      const outputResult = await this.captureStatusOutput(cwd);
      if (outputResult.isErr()) {
        if ("output" in outputResult.error) {
          const parsed = this.parseStatusOutput(outputResult.error.output);
          if (parsed.isOk()) {
            return parsed;
          }
        }
        return err(outputResult.error);
      }
      return this.parseStatusOutput(outputResult.value);
    } catch (error) {
      return err({
        type: "STATUS_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseStatusOutput(
    output: string,
  ): Result<CodexUsageStatus, CodexStatusError> {
    const parsed = parseCodexStatus(output);
    if (parsed.isErr() && isCodexUpdatePrompt(output)) {
      return err({ type: "UPDATE_REQUIRED", output });
    }
    if (parsed.isErr() || !this.timeZone) {
      return parsed;
    }
    return ok(convertCodexStatusTimeZone(parsed.value, this.timeZone));
  }

  private async captureStatusOutput(
    cwd: string,
  ): Promise<Result<string, CodexStatusError>> {
    const command = new Deno.Command("script", {
      args: ["-qfec", this.command, "/dev/null"],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: {
        TERM: "xterm-256color",
        COLUMNS: "100",
        LINES: "30",
      },
    });
    const process = command.spawn();

    const stdoutPromise = new Response(process.stdout).arrayBuffer();
    const stderrPromise = new Response(process.stderr).arrayBuffer();
    const stdinPromise = this.driveStatusTui(process.stdin);

    let timedOut = false;
    const timeout = delay(this.timeoutMs).then(() => {
      timedOut = true;
      try {
        process.kill("SIGKILL");
      } catch {
        // The process may have already exited.
      }
    });

    const status = await Promise.race([
      process.status,
      timeout.then(() => process.status.catch(() => ({ code: 124 }))),
    ]);

    await stdinPromise.catch(() => {});
    const [stdout, stderr] = await Promise.all([
      stdoutPromise,
      stderrPromise,
    ]);
    const output = decodeOutput(stdout) + decodeOutput(stderr);

    if (timedOut) {
      return err({ type: "COMMAND_TIMEOUT", output });
    }
    if (status.code !== 0) {
      return err({ type: "COMMAND_FAILED", code: status.code, output });
    }
    return ok(output);
  }

  private async driveStatusTui(
    stdin: WritableStream<Uint8Array>,
  ): Promise<void> {
    const writer = stdin.getWriter();
    const encoder = new TextEncoder();
    try {
      await delay(this.startupDelayMs);
      await writer.write(encoder.encode("/status\n\r"));
      await delay(this.statusRenderDelayMs);
      await writer.write(encoder.encode("\x03"));
    } finally {
      await writer.close().catch(() => {});
      writer.releaseLock();
    }
  }
}

function decodeOutput(output: ArrayBuffer): string {
  return new TextDecoder().decode(output);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCodexStatus(
  output: string,
): Result<CodexUsageStatus, CodexStatusError> {
  const cleaned = stripTerminalControlSequences(output).replace(/\s+/g, " ");
  const fiveHour = parseLimit(cleaned, "5h limit");
  const weekly = parseLimit(cleaned, "Weekly limit");

  if (!fiveHour || !weekly) {
    return err({ type: "PARSE_FAILED", output });
  }

  return ok({
    fiveHour,
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
    fiveHour: {
      ...status.fiveHour,
      resets: convertResetTime(
        status.fiveHour.resets,
        status.capturedAt,
        timeZone,
      ),
    },
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
  return [
    `5h limit: ${status.fiveHour.percentLeft}% left (resets ${status.fiveHour.resets})`,
    `Weekly limit: ${status.weekly.percentLeft}% left (resets ${status.weekly.resets})`,
  ].join("\n");
}

export function formatCodexStatusPresence(status: CodexUsageStatus): string {
  return [
    `5h ${status.fiveHour.percentLeft}% (${status.fiveHour.resets})`,
    `W ${status.weekly.percentLeft}% (${status.weekly.resets})`,
  ].join(" / ");
}

export function formatCodexStatusDelta(
  before: CodexUsageStatus,
  after: CodexUsageStatus,
): string {
  return [
    `5h limit ${before.fiveHour.percentLeft}% → ${after.fiveHour.percentLeft}% (resets ${after.fiveHour.resets})`,
    `Weekly limit ${before.weekly.percentLeft}% → ${after.weekly.percentLeft}% (resets ${after.weekly.resets})`,
  ].join("\n");
}
