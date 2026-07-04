import { err, ok, Result } from "neverthrow";
import { CODEX } from "../constants.ts";

const DEFAULT_TIMEOUT_MS = 15000;
const SHUTDOWN_TIMEOUT_MS = 1000;

export interface CodexForkThreadParams {
  threadId: string;
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
}

export interface CodexForkThreadResult {
  threadId: string;
  sessionId: string | null;
  forkedFromId: string | null;
  cwd: string | null;
}

export type CodexAppServerError =
  | { type: "APP_SERVER_START_FAILED"; error: string }
  | { type: "APP_SERVER_PROTOCOL_ERROR"; error: string }
  | { type: "APP_SERVER_ERROR"; message: string; code?: number }
  | { type: "APP_SERVER_TIMEOUT"; operation: string };

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface CodexAppServerProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<Deno.CommandStatus>;
  kill(signo?: Deno.Signal): void;
}

export type CodexAppServerProcessFactory = () => CodexAppServerProcess;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

async function withTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<Result<T, CodexAppServerError>> {
  let timer: number | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    return ok(await Promise.race([promise, timeout]));
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return err({ type: "APP_SERVER_TIMEOUT", operation });
    }
    return err({
      type: "APP_SERVER_PROTOCOL_ERROR",
      error: errorMessage(error),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readStreamText(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

class JsonLineReader {
  private buffer = "";

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
  }

  async readMessage(): Promise<JsonRpcResponse | null> {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        return JSON.parse(line) as JsonRpcResponse;
      }

      const { done, value } = await this.reader.read();
      if (done) {
        const line = this.buffer.trim();
        this.buffer = "";
        return line ? JSON.parse(line) as JsonRpcResponse : null;
      }
      this.buffer += new TextDecoder().decode(value, { stream: true });
    }
  }
}

export class CodexAppServerClient {
  constructor(
    private readonly createProcess: CodexAppServerProcessFactory = () =>
      new Deno.Command(CODEX.COMMAND, {
        args: ["app-server", "--stdio"],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn(),
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async forkThread(
    params: CodexForkThreadParams,
  ): Promise<Result<CodexForkThreadResult, CodexAppServerError>> {
    let process: CodexAppServerProcess;
    try {
      process = this.createProcess();
    } catch (error) {
      return err({
        type: "APP_SERVER_START_FAILED",
        error: errorMessage(error),
      });
    }

    const writer = process.stdin.getWriter();
    const lineReader = new JsonLineReader(process.stdout.getReader());
    const stderrText = readStreamText(process.stderr).catch(errorMessage);

    try {
      await this.send(writer, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "discord_codex_bot",
            title: "Discord Codex Bot",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      });

      await this.send(writer, {
        method: "initialized",
        params: {},
      });

      const forkParams: Record<string, unknown> = {
        threadId: params.threadId,
        excludeTurns: true,
      };
      if (params.cwd) forkParams.cwd = params.cwd;
      if (params.runtimeWorkspaceRoots) {
        forkParams.runtimeWorkspaceRoots = params.runtimeWorkspaceRoots;
      }

      const forkResult = await this.sendAndWait(
        writer,
        lineReader,
        {
          method: "thread/fork",
          id: 1,
          params: forkParams,
        },
        "thread/fork",
      );
      if (forkResult.isErr()) return err(forkResult.error);

      return this.parseForkResult(forkResult.value.result);
    } finally {
      await writer.close().catch(() => {});
      try {
        process.kill("SIGTERM");
      } catch {
        // Process may already be closed.
      }
      let shutdownTimer: number | undefined;
      await Promise.race([
        process.status,
        new Promise((resolve) => {
          shutdownTimer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]).catch(() => {}).finally(() => {
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
      });

      const stderr = (await stderrText).trim();
      if (stderr) {
        console.error("[CodexAppServer] stderr:", stderr);
      }
    }
  }

  private async sendAndWait(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: JsonLineReader,
    message: Record<string, unknown>,
    operation: string,
  ): Promise<Result<JsonRpcResponse, CodexAppServerError>> {
    await this.send(writer, message);
    const responseResult = await withTimeout(
      operation,
      this.readResponse(reader, message.id),
      this.timeoutMs,
    );
    if (responseResult.isErr()) return responseResult;

    const response = responseResult.value;
    const error = asRecord(response.error);
    if (error) {
      return err({
        type: "APP_SERVER_ERROR",
        message: typeof error.message === "string"
          ? error.message
          : "Codex app-server returned an error",
        code: typeof error.code === "number" ? error.code : undefined,
      });
    }
    return ok(response);
  }

  private async send(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    message: Record<string, unknown>,
  ): Promise<void> {
    await writer.write(
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  }

  private async readResponse(
    reader: JsonLineReader,
    id: unknown,
  ): Promise<JsonRpcResponse> {
    while (true) {
      const message = await reader.readMessage();
      if (!message) {
        throw new Error(`app-server closed before response ${String(id)}`);
      }
      if (message.id === id) return message;
    }
  }

  private parseForkResult(
    result: unknown,
  ): Result<CodexForkThreadResult, CodexAppServerError> {
    const obj = asRecord(result);
    const thread = asRecord(obj?.thread);
    const threadId = thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      return err({
        type: "APP_SERVER_PROTOCOL_ERROR",
        error: "thread/fork response did not include thread.id",
      });
    }

    return ok({
      threadId,
      sessionId: typeof thread.sessionId === "string" ? thread.sessionId : null,
      forkedFromId: typeof thread.forkedFromId === "string"
        ? thread.forkedFromId
        : null,
      cwd: typeof obj?.cwd === "string" ? obj.cwd : null,
    });
  }
}
