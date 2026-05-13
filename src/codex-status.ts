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
  | { type: "STATUS_UNAVAILABLE"; error: string };

interface CodexStatusProviderOptions {
  command?: string;
  startupDelayMs?: number;
  statusRenderDelayMs?: number;
  timeoutMs?: number;
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

export class CodexStatusProvider {
  private readonly command: string;
  private readonly startupDelayMs: number;
  private readonly statusRenderDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: CodexStatusProviderOptions = {}) {
    this.command = options.command ??
      "stty rows 30 cols 100; codex --no-alt-screen";
    this.startupDelayMs = options.startupDelayMs ??
      DEFAULT_STARTUP_DELAY_MS;
    this.statusRenderDelayMs = options.statusRenderDelayMs ??
      DEFAULT_STATUS_RENDER_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getStatus(
    cwd: string,
  ): Promise<Result<CodexUsageStatus, CodexStatusError>> {
    try {
      const outputResult = await this.captureStatusOutput(cwd);
      if (outputResult.isErr()) {
        if ("output" in outputResult.error) {
          const parsed = parseCodexStatus(outputResult.error.output);
          if (parsed.isOk()) {
            return parsed;
          }
        }
        return err(outputResult.error);
      }
      return parseCodexStatus(outputResult.value);
    } catch (error) {
      return err({
        type: "STATUS_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
