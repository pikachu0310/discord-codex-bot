import { err, ok, Result } from "neverthrow";

export interface CodexUpdateResult {
  code: number;
  output: string;
  version?: string;
}

export type CodexUpdateError =
  | { type: "COMMAND_FAILED"; code: number; output: string }
  | { type: "COMMAND_TIMEOUT"; output: string }
  | { type: "UPDATE_UNAVAILABLE"; error: string };

const DEFAULT_UPDATE_TIMEOUT_MS = 180_000;

export async function updateCodexCli(
  timeoutMs = DEFAULT_UPDATE_TIMEOUT_MS,
): Promise<Result<CodexUpdateResult, CodexUpdateError>> {
  try {
    const command = new Deno.Command("codex", {
      args: ["update"],
      stdout: "piped",
      stderr: "piped",
    });
    const process = command.spawn();
    const stdoutPromise = new Response(process.stdout).arrayBuffer();
    const stderrPromise = new Response(process.stderr).arrayBuffer();

    let timedOut = false;
    const timeout = delay(timeoutMs).then(() => {
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
    const [stdout, stderr] = await Promise.all([
      stdoutPromise,
      stderrPromise,
    ]);
    const output = `${decodeOutput(stdout)}${decodeOutput(stderr)}`.trim();

    if (timedOut) {
      return err({ type: "COMMAND_TIMEOUT", output });
    }
    if (status.code !== 0) {
      return err({ type: "COMMAND_FAILED", code: status.code, output });
    }
    return ok({
      code: status.code,
      output,
      version: await getCodexVersion(),
    });
  } catch (error) {
    return err({
      type: "UPDATE_UNAVAILABLE",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatCodexUpdateResult(result: CodexUpdateResult): string {
  const title = result.version
    ? `🎉 Update ran successfully! (${result.version})`
    : "🎉 Update ran successfully!";
  const output = formatCodexUpdateOutput(result.output);
  const outputBlock = output ? `\`\`\`\n${output}\n\`\`\`` : undefined;
  return [
    title,
    outputBlock,
    "BOT は Codex を実行ごとに起動するため、再起動などは必要ないよ。",
  ].filter(Boolean).join("\n\n");
}

export function formatCodexUpdateError(error: CodexUpdateError): string {
  switch (error.type) {
    case "COMMAND_TIMEOUT":
      return [
        "Codex update がタイムアウトしました。",
        error.output ? truncate(error.output) : undefined,
      ].filter(Boolean).join("\n\n");
    case "COMMAND_FAILED":
      return [
        `Codex update に失敗しました (終了コード: ${error.code})。`,
        error.output ? truncate(error.output) : undefined,
      ].filter(Boolean).join("\n\n");
    case "UPDATE_UNAVAILABLE":
      return `Codex update を起動できませんでした: ${error.error}`;
  }
}

function decodeOutput(output: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(output);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCodexVersion(): Promise<string | undefined> {
  try {
    const command = new Deno.Command("codex", {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    if (code !== 0) return undefined;
    const versionOutput = decodeOutput(stdout).trim() ||
      decodeOutput(stderr).trim();
    const version = versionOutput.split(/\r?\n/)[0]?.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit = 1800): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(-limit)}\n...前半を省略しました`;
}

function formatCodexUpdateOutput(output: string): string {
  return output
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.includes("Update ran successfully!"))
    .join("\n")
    .trim();
}
