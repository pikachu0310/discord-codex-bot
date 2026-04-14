import { err, ok, Result } from "neverthrow";
import { GitRepository } from "../git-utils.ts";
import { MESSAGES, PROCESS } from "../constants.ts";
import { splitIntoDiscordChunks } from "../utils/discord-message.ts";
import { WorkerState, WorkspaceManager } from "../workspace/workspace.ts";
import {
  type CodexCommandExecutor,
  DefaultCodexCommandExecutor,
} from "./codex-executor.ts";
import { CodexStreamProcessor } from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";
import { SessionLogger } from "./session-logger.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import type { IWorker, WorkerError } from "./types.ts";

export class Worker implements IWorker {
  private readonly configuration: WorkerConfiguration;
  private readonly sessionLogger: SessionLogger;
  private readonly streamProcessor: CodexStreamProcessor;
  private readonly formatter = new MessageFormatter();

  private codexExecutor: CodexCommandExecutor;
  private codexProcess: Deno.ChildProcess | null = null;
  private abortController: AbortController | null = null;
  private isExecuting = false;

  constructor(
    private state: WorkerState,
    private readonly workspaceManager: WorkspaceManager,
    codexExecutor?: CodexCommandExecutor,
    appendSystemPrompt?: string,
  ) {
    this.configuration = new WorkerConfiguration(appendSystemPrompt);
    this.codexExecutor = codexExecutor ??
      new DefaultCodexCommandExecutor();
    this.sessionLogger = new SessionLogger(workspaceManager);
    this.streamProcessor = new CodexStreamProcessor();
  }

  async processMessage(
    message: string,
    onProgress: (content: string) => Promise<void> = async () => {},
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<Result<string, WorkerError>> {
    if (!this.state.repository || !this.state.worktreePath) {
      return err({ type: "REPOSITORY_NOT_SET" });
    }

    if (onReaction) {
      await onReaction("⚙️").catch(() => {});
    }

    await onProgress("🤖 Codexが処理を開始しました...");

    this.isExecuting = true;
    this.abortController = new AbortController();
    this.codexProcess = null;

    let newSessionId: string | null = null;
    let allOutput = "";
    let finalResult = "";
    let pendingBuffer = "";

    const args = this.buildExecutionArgs(message);
    const onData = (chunk: Uint8Array) => {
      const text = new TextDecoder().decode(chunk, { stream: true });
      allOutput += text;
      pendingBuffer += text;
      const lines = pendingBuffer.split("\n");
      pendingBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = this.streamProcessor.parseLine(line);

        if (parsed.rateLimitTimestamp !== undefined) {
          throw {
            type: "RATE_LIMIT_THROW",
            timestamp: parsed.rateLimitTimestamp,
          };
        }

        if (parsed.sessionId) {
          newSessionId = parsed.sessionId;
        }

        if (parsed.finalText) {
          finalResult = parsed.finalText;
          continue;
        }

        if (parsed.text) {
          const formatted = this.formatter.formatResponse(parsed.text);
          for (const chunkText of splitIntoDiscordChunks(formatted)) {
            if (!chunkText.trim()) continue;
            onProgress(chunkText).catch(console.error);
          }
        }
      }
    };

    try {
      const execResult = await this.codexExecutor.executeStreaming(
        args,
        this.state.worktreePath,
        onData,
        this.abortController.signal,
        (process) => {
          this.codexProcess = process;
        },
      );

      if (pendingBuffer.trim()) {
        const parsed = this.streamProcessor.parseLine(pendingBuffer.trim());
        if (parsed.finalText) {
          finalResult = parsed.finalText;
        } else if (parsed.text && !finalResult) {
          finalResult = parsed.text;
        }
        if (parsed.sessionId) {
          newSessionId = parsed.sessionId;
        }
      }

      if (execResult.isErr()) {
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: execResult.error.type === "COMMAND_EXECUTION_FAILED"
            ? execResult.error.stderr
            : execResult.error.error,
        });
      }

      const { code, stderr } = execResult.value;
      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        const ts =
          this.streamProcessor.parseLine(stderrText).rateLimitTimestamp;
        if (ts !== undefined) {
          return err({
            type: "RATE_LIMIT",
            timestamp: ts,
            retryAt: ts,
            message: "Codexのレート制限に達しました。",
          });
        }
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: `Codex実行失敗 (終了コード: ${code})\n${stderrText}`,
        });
      }

      if (newSessionId && newSessionId !== this.state.sessionId) {
        this.state.sessionId = newSessionId;
      }

      await this.sessionLogger.saveRawJsonlOutput(
        this.state.repository.fullName,
        this.state.sessionId ?? undefined,
        allOutput,
      );
      await this.save();

      return ok(
        this.formatter.formatResponse(
          finalResult.trim() || MESSAGES.NO_FINAL_RESPONSE,
        ),
      );
    } catch (error) {
      if (
        typeof error === "object" && error !== null &&
        "type" in error &&
        (error as { type: string }).type === "RATE_LIMIT_THROW"
      ) {
        const timestamp = (error as { timestamp?: number }).timestamp;
        return err({
          type: "RATE_LIMIT",
          timestamp,
          retryAt: timestamp,
          message: "Codexのレート制限に達しました。",
        });
      }
      if (error instanceof Error && error.name === "AbortError") {
        return ok("⛔ Codex実行を中断しました。");
      }
      return err({
        type: "CODEX_EXECUTION_FAILED",
        error: (error as Error).message,
      });
    } finally {
      this.isExecuting = false;
      this.abortController = null;
      this.codexProcess = null;
    }
  }

  private buildExecutionArgs(prompt: string): string[] {
    if (!this.isPlanMode()) {
      return this.configuration.buildCodexArgs(prompt, this.state.sessionId);
    }

    const planPrompt = [
      "You are in plan mode.",
      "Return an implementation plan before coding.",
      "If coding is needed, include clear ordered steps.",
      "",
      prompt,
    ].join("\n");
    return this.configuration.buildCodexArgs(planPrompt, this.state.sessionId);
  }

  getName(): string {
    return this.state.workerName;
  }

  getRepository(): GitRepository | null {
    if (!this.state.repository) return null;
    return {
      ...this.state.repository,
      localPath: this.state.repositoryLocalPath ??
        this.state.repository.fullName,
    };
  }

  async setRepository(
    repository: GitRepository,
    localPath: string,
  ): Promise<Result<void, WorkerError>> {
    this.state.repository = {
      fullName: repository.fullName,
      org: repository.org,
      repo: repository.repo,
    };
    this.state.repositoryLocalPath = localPath;

    try {
      this.state.worktreePath = await this.workspaceManager.ensureWorktree(
        this.state.threadId,
        localPath,
      );
    } catch (error) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "ensureWorktree",
        error: (error as Error).message,
      });
    }

    this.state.sessionId = null;
    return await this.save();
  }

  async save(): Promise<Result<void, WorkerError>> {
    try {
      await this.workspaceManager.saveWorkerState(this.state);
      return ok(undefined);
    } catch (error) {
      return err({
        type: "WORKSPACE_ERROR",
        operation: "saveWorkerState",
        error: (error as Error).message,
      });
    }
  }

  async stopExecution(
    onProgress?: (content: string) => Promise<void>,
  ): Promise<boolean> {
    if (!this.isExecuting || !this.codexProcess) {
      return false;
    }

    try {
      this.abortController?.abort();
      this.codexProcess.kill("SIGTERM");

      const process = this.codexProcess;
      const timer = setTimeout(() => {
        try {
          process.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, PROCESS.TERMINATION_TIMEOUT_MS);

      await process.status.catch(() => {});
      clearTimeout(timer);

      if (onProgress) {
        await onProgress("⛔ Codex実行を中断しました。");
      }
      return true;
    } finally {
      this.isExecuting = false;
      this.codexProcess = null;
      this.abortController = null;
    }
  }

  isPlanMode(): boolean {
    return this.state.isPlanMode ?? false;
  }

  setPlanMode(planMode: boolean): void {
    this.state.isPlanMode = planMode;
  }

  static async fromState(
    workerState: WorkerState,
    workspaceManager: WorkspaceManager,
    appendSystemPrompt?: string,
  ): Promise<Worker> {
    return new Worker(
      workerState,
      workspaceManager,
      undefined,
      appendSystemPrompt,
    );
  }
}
