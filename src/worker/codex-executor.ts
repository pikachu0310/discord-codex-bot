import { err, ok, Result } from "neverthrow";
import { TextLineStream } from "std/streams/text_line_stream.ts";
import { CODEX, PROCESS } from "../constants.ts";
import type { CodexExecutorError } from "./types.ts";

export interface CodexExecutionOptions {
  prompt: string;
  cwd: string;
  sessionId?: string | null;
  imagePaths?: readonly string[];
  developerInstructions?: string;
}

type ExecutionResult = Result<
  { code: number; stderr: Uint8Array },
  CodexExecutorError
>;

export interface CodexCommandExecutor {
  executeStreaming(
    options: CodexExecutionOptions,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
  ): Promise<ExecutionResult>;
  // false means the turn ended before this input could be accepted.
  sendInput(options: CodexExecutionOptions): Promise<boolean>;
}

type Packet = Record<string, unknown>;
type RequestId = string | number;
interface Question {
  id: string;
  header: string;
  question: string;
  options?: { label: string; description: string }[] | null;
}
interface InputRequest {
  id: RequestId;
  questions: Question[];
  answers: Record<string, { answers: string[] }>;
  index: number;
}

function failure(error: unknown): ExecutionResult {
  return err({
    type: "STREAM_PROCESSING_ERROR",
    error: error instanceof Error ? error.message : String(error),
  });
}

/** JSONL RPC over one app-server process for the lifetime of a turn. */
class AppServerConnection {
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (value: Packet) => void;
    reject: (error: Error) => void;
    timer: number;
  }>();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly readerTask: Promise<void>;
  private readonly stderrTask: Promise<string>;
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(
    readonly process: Deno.ChildProcess,
    private readonly onPacket: (packet: Packet) => void,
    private readonly onClose: (error: Error) => void,
  ) {
    this.writer = process.stdin.getWriter();
    this.stderrTask = new Response(process.stderr).text();
    this.readerTask = this.read();
  }

  async write(packet: Packet): Promise<void> {
    if (this.closed) throw new Error("Codex接続は終了しています。");
    await this.writer.write(this.encoder.encode(JSON.stringify(packet) + "\n"));
  }

  async request(method: string, params: Packet): Promise<Packet> {
    const id = ++this.nextId;
    const response = new Promise<Packet>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    void this.write({ id, method, params }).catch((error) => {
      const request = this.pending.get(id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(error);
      }
    });
    return await response;
  }

  private async read(): Promise<void> {
    let closeError = new Error("Codex App Serverとの接続が終了しました。");
    try {
      const lines = this.process.stdout.pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      for await (const line of lines) {
        if (!line.trim()) continue;
        const packet = JSON.parse(line) as Packet;
        if (packet.method === undefined && typeof packet.id === "number") {
          const request = this.pending.get(packet.id);
          if (!request) continue;
          this.pending.delete(packet.id);
          clearTimeout(request.timer);
          if (packet.error) {
            const error = packet.error as Packet;
            request.reject(new Error(String(error.message ?? packet.error)));
          } else {
            request.resolve((packet.result ?? {}) as Packet);
          }
        } else {
          this.onPacket(packet);
        }
      }
    } catch (error) {
      closeError = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.closed = true;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(closeError);
      }
      this.pending.clear();
      this.onClose(closeError);
    }
  }

  async dispose(): Promise<string> {
    try {
      this.process.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await this.process.status.catch(() => {});
    await this.readerTask;
    await this.writer.close().catch(() => {});
    this.writer.releaseLock();
    return await this.stderrTask;
  }
}

export class DefaultCodexCommandExecutor implements CodexCommandExecutor {
  private active?: {
    connection: AppServerConnection;
    threadId: string;
    turnId: string;
    requests: InputRequest[];
    emit: (packet: Packet) => void;
  };
  private ready: Promise<void> = Promise.resolve();
  private inputTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly spawnProcess = (cwd: string) =>
      new Deno.Command(CODEX.COMMAND, {
        args: ["app-server"],
        cwd,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn(),
  ) {}

  async executeStreaming(
    options: CodexExecutionOptions,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
  ): Promise<ExecutionResult> {
    let markReady!: () => void;
    this.ready = new Promise((resolve) => markReady = resolve);
    let connection: AppServerConnection | undefined;
    let finish!: (result: ExecutionResult) => void;
    let ended = false;
    const completed = new Promise<ExecutionResult>((resolve) => {
      finish = (result) => {
        ended = true;
        resolve(result);
      };
    });
    const emit = (packet: Packet) =>
      onData(new TextEncoder().encode(JSON.stringify(packet) + "\n"));
    let abortTimer: number | undefined;
    const stopped = () => ok({ code: 0, stderr: new Uint8Array() });
    const abort = () => {
      const active = this.active;
      if (active?.turnId) {
        void active.connection.request("turn/interrupt", {
          threadId: active.threadId,
          turnId: active.turnId,
        }).catch(() => finish(stopped()));
        abortTimer = setTimeout(
          () => finish(stopped()),
          PROCESS.TERMINATION_TIMEOUT_MS,
        );
      } else {
        finish(stopped());
        try {
          connection?.process.kill("SIGTERM");
        } catch { /* Already exited. */ }
      }
    };
    try {
      if (abortSignal?.aborted) return failure("実行が中断されました");
      connection = new AppServerConnection(
        this.spawnProcess(options.cwd),
        (packet) => {
          emit(packet);
          this.handlePacket(packet, finish);
        },
        (error) => finish(failure(error)),
      );
      onProcessStart?.(connection.process);
      abortSignal?.addEventListener("abort", abort, { once: true });
      await connection.request("initialize", {
        clientInfo: { name: "discord_codex_bot", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      await connection.write({ method: "initialized", params: {} });
      const thread = await connection.request(
        options.sessionId ? "thread/resume" : "thread/start",
        {
          ...(options.sessionId ? { threadId: options.sessionId } : {}),
          cwd: options.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          config: { web_search: "live" },
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
        },
      );
      const threadId = (thread.thread as Packet).id as string;
      emit({ type: "thread.started", thread_id: threadId });
      this.active = { connection, threadId, turnId: "", requests: [], emit };
      const result = await connection.request("turn/start", {
        threadId,
        input: this.buildInput(options),
      });
      // turn/started can arrive before the response.
      if (!ended) {
        this.active.turnId = (result.turn as Packet).id as string;
      }
      markReady();
      return await completed;
    } catch (error) {
      return abortSignal?.aborted ? stopped() : failure(error);
    } finally {
      clearTimeout(abortTimer);
      abortSignal?.removeEventListener("abort", abort);
      this.active = undefined;
      markReady();
      if (connection) {
        const stderr = await connection.dispose();
        if (stderr.trim()) emit({ type: "error", message: stderr });
      }
      if (abortSignal?.aborted) {
        emit({ type: "result", result: "⛔ Codex実行を中断しました。" });
      }
    }
  }

  sendInput(options: CodexExecutionOptions): Promise<boolean> {
    // Serialize answers so rapid messages cannot answer the same question twice.
    const task = this.inputTail.then(() => this.deliverInput(options));
    this.inputTail = task.catch(() => {});
    return task;
  }

  private async deliverInput(options: CodexExecutionOptions): Promise<boolean> {
    await this.ready;
    const active = this.active;
    if (!active?.turnId) return false;
    const request = active.requests[0];
    if (request) {
      const question = request.questions[request.index];
      const choice = /^\d+$/.test(options.prompt.trim())
        ? question.options?.[Number(options.prompt.trim()) - 1]?.label
        : undefined;
      const answer = choice ?? options.prompt;
      const answers = {
        ...request.answers,
        [question.id]: { answers: [answer] },
      };
      if (request.index + 1 < request.questions.length) {
        request.answers = answers;
        request.index++;
        this.showQuestion(request);
      } else {
        await active.connection.write({ id: request.id, result: { answers } });
        // serverRequest/resolved may already have removed it while writing.
        if (active.requests[0] === request) {
          active.requests.shift();
          if (active.requests[0]) this.showQuestion(active.requests[0]);
        }
      }
      // Attachments on an answer are also delivered to the model as input.
      if (!options.imagePaths?.length) return true;
    }
    try {
      await active.connection.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: this.buildInput(options),
      });
      return true;
    } catch (error) {
      // A completion notification may race the steer request. The Worker will
      // wait for cleanup and start a new turn with the original input.
      if (
        this.active !== active || !active.turnId ||
        (error instanceof Error &&
          /no active turn|expected.*turn.*(?:match|mismatch)/i.test(
            error.message,
          ))
      ) return false;
      throw error;
    }
  }

  private buildInput(options: CodexExecutionOptions): Packet[] {
    return [
      { type: "text", text: options.prompt, text_elements: [] },
      ...(options.imagePaths ?? []).map((path) => ({
        type: "localImage",
        path,
      })),
    ];
  }

  private showQuestion(request: InputRequest): void {
    const question = request.questions[request.index];
    this.active?.emit({
      type: "progress",
      item: {
        text: [
          `❓ ${question.header}: ${question.question}`,
          ...(question.options ?? []).map((option, index) =>
            `${index + 1}. ${option.label} — ${option.description}`
          ),
          "このスレッドに番号または自由文で回答してください。" +
          (request.questions.length > 1
            ? `（${request.index + 1}/${request.questions.length}問目）`
            : ""),
        ].join("\n"),
      },
    });
  }

  private handlePacket(
    packet: Packet,
    finish: (result: ExecutionResult) => void,
  ) {
    const active = this.active;
    if (!active) return;
    const params = (packet.params ?? {}) as Packet;
    if (params.threadId && params.threadId !== active.threadId) return;
    if (packet.method === "turn/started") {
      active.turnId = (params.turn as Packet).id as string;
    } else if (packet.method === "turn/completed") {
      active.turnId = "";
      active.requests = [];
      const turn = params.turn as Packet;
      if (turn.status === "failed") {
        finish(failure((turn.error as Packet)?.message ?? "Codex turn failed"));
      } else {
        finish(ok({ code: 0, stderr: new Uint8Array() }));
      }
    } else if (packet.method === "serverRequest/resolved") {
      const wasFirst = active.requests[0]?.id === params.requestId;
      active.requests = active.requests.filter((r) =>
        r.id !== params.requestId
      );
      if (wasFirst && active.requests[0]) this.showQuestion(active.requests[0]);
    } else if (packet.method === "item/completed") {
      const item = params.item as Packet;
      if (item.type === "agentMessage") {
        active.emit({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: [
              item.text,
              ...((item.questions ?? []) as {
                title: string;
                options?: string[];
              }[]).map((question) =>
                [
                  question.title,
                  ...(question.options ?? []).map((option, index) =>
                    `${index + 1}. ${option}`
                  ),
                ].join("\n")
              ),
            ].filter(Boolean).join("\n"),
          },
        });
      } else if (item.type === "commandExecution") {
        active.emit({
          type: "item.completed",
          item: {
            type: "command_execution",
            stdout: item.aggregatedOutput,
          },
        });
      } else if (item.type === "plan" || item.type === "contextCompaction") {
        active.emit({
          type: "item.completed",
          item: item.type === "contextCompaction"
            ? { ...item, type: "context.compaction.completed" }
            : item,
        });
      }
    } else if (packet.id !== undefined && packet.method) {
      if (packet.method === "item/tool/requestUserInput") {
        const request: InputRequest = {
          id: packet.id as RequestId,
          questions: params.questions as Question[],
          answers: {},
          index: 0,
        };
        if (request.questions.length === 0) {
          void active.connection.write({
            id: request.id,
            result: { answers: {} },
          })
            .catch((error) => finish(failure(error)));
        } else {
          active.requests.push(request);
          if (active.requests.length === 1) this.showQuestion(request);
        }
      } else {
        // Never leave an unsupported server request hanging indefinitely.
        void active.connection.write({
          id: packet.id,
          error: {
            code: -32601,
            message: `Unsupported server request: ${packet.method}`,
          },
        }).catch((error) => finish(failure(error)));
      }
    }
  }
}
