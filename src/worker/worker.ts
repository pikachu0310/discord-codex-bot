import { err, ok, Result } from "neverthrow";
import {
  formatPromptWithAttachments,
  getCodexImagePaths,
  type SavedAttachment,
} from "../attachments.ts";
import { GitRepository } from "../git-utils.ts";
import { MESSAGES, PROCESS } from "../constants.ts";
import { splitIntoDiscordChunks } from "../utils/discord-message.ts";
import { WorkerState, WorkspaceManager } from "../workspace/workspace.ts";
import {
  type CodexCommandExecutor,
  type CodexExecutionOptions,
  DefaultCodexCommandExecutor,
} from "./codex-executor.ts";
import {
  CodexStreamProcessor,
  extractRateLimitTimestamp,
} from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";
import { SessionLogger } from "./session-logger.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import type {
  IWorker,
  PendingQuestion,
  ProgressCallback,
  QuestionAnswer,
  WorkerError,
} from "./types.ts";

const DIAGNOSTIC_SECTION_LIMIT = 1800;
const DIAGNOSTIC_TEXT_LIMIT = 5000;

interface CodexFailureDetailOptions {
  exitCode?: number;
  reason?: string;
  stderr?: string;
  rawOutput: string;
  sessionLogPath?: string | null;
}

function redactSensitiveText(text: string): string {
  return text
    .replace(
      /((?:PASS(?:WORD)?|TOKEN|SECRET|COOKIE|AUTHORIZATION|API[_-]?KEY|DISCORD_TOKEN)\s*=\s*)[^\n\r]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(auth\[password\]\s*=\s*)[^\s"'&\\]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(password|passwd|token|secret|api[_-]?key)(["'\]\s:=>-]+)[^"',\s&\\]+/gi,
      "$1$2[REDACTED]",
    );
}

function truncateDiagnostic(text: string, limit = DIAGNOSTIC_SECTION_LIMIT) {
  const trimmed = redactSensitiveText(text).trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(-limit)}\n...前半を省略しました`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class Worker implements IWorker {
  private readonly configuration: WorkerConfiguration;
  private readonly sessionLogger: SessionLogger;
  private readonly streamProcessor: CodexStreamProcessor;
  private readonly formatter = new MessageFormatter();

  private codexExecutor: CodexCommandExecutor;
  private codexProcess: Deno.ChildProcess | null = null;
  private abortController: AbortController | null = null;
  private isExecuting = false;
  private activeExecution: Promise<Result<string, WorkerError>> | null = null;
  private executionReady: Promise<void> = Promise.resolve();

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
    attachments: readonly SavedAttachment[] = [],
    onProgress: ProgressCallback = async () => {},
    onReaction?: (emoji: string) => Promise<void>,
    questionAnswer?: QuestionAnswer,
  ): Promise<Result<string, WorkerError>> {
    const active = this.activeExecution;
    if (active) {
      await this.executionReady;
      try {
        const answering = !!this.getPendingQuestion();
        const accepted = await this.codexExecutor.sendInput(
          this.buildExecutionOptions(
            message,
            attachments,
            false,
            questionAnswer,
          ),
        );
        if (accepted) {
          await onReaction?.(answering ? "✅" : "📨").catch(() => {});
          return ok(
            answering
              ? "✅ 回答を受け付けました。作業を続けます。"
              : "📨 実行中のCodexにメッセージを届けました。",
          );
        }
      } catch (error) {
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: `追加入力を送信できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      // The active turn completed while the input was being prepared.
      await active;
      return await this.processMessage(
        message,
        attachments,
        onProgress,
        onReaction,
        questionAnswer,
      );
    }

    let ready!: () => void;
    this.executionReady = new Promise((resolve) => ready = resolve);
    const execution = this.executeMessage(
      message,
      attachments,
      onProgress,
      onReaction,
      ready,
      questionAnswer,
    );
    this.activeExecution = execution;
    try {
      return await execution;
    } finally {
      ready();
      this.activeExecution = null;
    }
  }

  private async executeMessage(
    message: string,
    attachments: readonly SavedAttachment[],
    onProgress: ProgressCallback,
    onReaction: ((emoji: string) => Promise<void>) | undefined,
    ready: () => void,
    questionAnswer?: QuestionAnswer,
  ): Promise<Result<string, WorkerError>> {
    if (!this.state.repository || !this.state.worktreePath) {
      return err({ type: "REPOSITORY_NOT_SET" });
    }

    this.isExecuting = true;
    this.abortController = new AbortController();
    this.codexProcess = null;

    let newSessionId: string | null = null;
    let allOutput = "";
    let finalResult = "";
    let pendingBuffer = "";
    let progressTail = Promise.resolve();
    let rateLimitTimestamp: number | undefined;
    let sessionSave: Promise<Result<void, WorkerError>> = Promise.resolve(
      ok(undefined),
    );
    const decoder = new TextDecoder();

    const onData = (chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true });
      allOutput += text;
      pendingBuffer += text;
      const lines = pendingBuffer.split("\n");
      pendingBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = this.streamProcessor.parseLine(line);

        if (parsed.rateLimitTimestamp !== undefined) {
          rateLimitTimestamp = parsed.rateLimitTimestamp;
        }

        if (parsed.sessionId) {
          newSessionId = parsed.sessionId;
          this.state.sessionId = parsed.sessionId;
          sessionSave = this.save();
        }

        if (parsed.finalText) {
          finalResult = parsed.finalText;
        }

        if (parsed.text && parsed.questions?.length) {
          progressTail = progressTail.then(() =>
            this.reportProgress(onProgress, parsed.text!, parsed.questions)
          );
        } else if (parsed.text) {
          const formatted = this.formatter.formatResponse(parsed.text);
          for (const chunkText of splitIntoDiscordChunks(formatted)) {
            if (!chunkText.trim()) continue;
            progressTail = progressTail.then(() =>
              this.reportProgress(onProgress, chunkText)
            );
          }
        }
      }
    };

    try {
      if (onReaction) await onReaction("⚙️").catch(() => {});
      await this.reportProgress(onProgress, "🤖 Codexが処理を開始しました...");
      if (this.abortController.signal.aborted) {
        return ok("⛔ Codex実行を中断しました。");
      }
      const execution = this.codexExecutor.executeStreaming(
        this.buildExecutionOptions(message, attachments, true, questionAnswer),
        onData,
        this.abortController.signal,
        (process) => {
          this.codexProcess = process;
        },
      );

      ready();
      const execResult = await execution;

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
        if (parsed.rateLimitTimestamp !== undefined) {
          rateLimitTimestamp = parsed.rateLimitTimestamp;
        }
      }

      if (execResult.isErr()) {
        rateLimitTimestamp ??= extractRateLimitTimestamp(
          allOutput + "\n" +
            (execResult.error.type === "STREAM_PROCESSING_ERROR"
              ? execResult.error.error
              : execResult.error.stderr),
        );
        if (rateLimitTimestamp !== undefined) {
          return err({
            type: "RATE_LIMIT",
            timestamp: rateLimitTimestamp,
            retryAt: rateLimitTimestamp,
            message: "Codexのレート制限に達しました。",
          });
        }
        const logPath = await this.saveRawCodexOutput(
          allOutput,
          newSessionId ?? this.state.sessionId,
        );
        return err(
          await this.createCodexExecutionFailedError({
            reason: execResult.error.type === "COMMAND_EXECUTION_FAILED"
              ? execResult.error.stderr
              : execResult.error.error,
            rawOutput: allOutput,
            sessionLogPath: logPath,
          }),
        );
      }

      const { code, stderr } = execResult.value;
      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr);
        const ts = rateLimitTimestamp ??
          extractRateLimitTimestamp([stderrText, allOutput].join("\n"));
        if (ts !== undefined) {
          return err({
            type: "RATE_LIMIT",
            timestamp: ts,
            retryAt: ts,
            message: "Codexのレート制限に達しました。",
          });
        }
        const logPath = await this.saveRawCodexOutput(
          allOutput,
          newSessionId ?? this.state.sessionId,
        );
        return err(
          await this.createCodexExecutionFailedError({
            exitCode: code,
            stderr: stderrText,
            rawOutput: allOutput,
            sessionLogPath: logPath,
          }),
        );
      }

      if (newSessionId && newSessionId !== this.state.sessionId) {
        this.state.sessionId = newSessionId;
      }

      await this.saveRawCodexOutput(allOutput, this.state.sessionId);
      await this.save();

      return ok(
        this.formatter.formatResponse(
          finalResult.trim() || MESSAGES.NO_FINAL_RESPONSE,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return ok("⛔ Codex実行を中断しました。");
      }
      const logPath = await this.saveRawCodexOutput(
        allOutput,
        newSessionId ?? this.state.sessionId,
      );
      return err(
        await this.createCodexExecutionFailedError({
          reason: error instanceof Error ? error.message : String(error),
          rawOutput: allOutput,
          sessionLogPath: logPath,
        }),
      );
    } finally {
      this.isExecuting = false;
      this.abortController = null;
      this.codexProcess = null;
      ready();
      await sessionSave;
      await progressTail;
    }
  }

  private async reportProgress(
    onProgress: ProgressCallback,
    content: string,
    questions?: readonly PendingQuestion[],
  ): Promise<void> {
    try {
      await onProgress(content, questions);
    } catch (error) {
      console.error("[Worker] progress callback failed", error);
    }
  }

  private buildExecutionOptions(
    prompt: string,
    attachments: readonly SavedAttachment[] = [],
    includeModeInstructions = true,
    questionAnswer?: QuestionAnswer,
  ): CodexExecutionOptions {
    const promptWithAttachments = formatPromptWithAttachments(
      prompt,
      attachments,
    );
    return {
      ...this.configuration.buildExecutionOptions(
        includeModeInstructions && this.isPlanMode()
          ? [
            "You are in plan mode.",
            "Return an implementation plan before coding.",
            "If coding is needed, include clear ordered steps.",
            "",
            promptWithAttachments,
          ].join("\n")
          : promptWithAttachments,
        this.state.worktreePath!,
        this.state.sessionId,
        getCodexImagePaths(attachments),
      ),
      ...(questionAnswer ? { questionAnswer } : {}),
    };
  }

  private async saveRawCodexOutput(
    output: string,
    sessionId?: string | null,
  ): Promise<string | null> {
    const result = await this.sessionLogger.saveRawJsonlOutput(
      this.state.repository?.fullName,
      sessionId ?? undefined,
      redactSensitiveText(output),
    );
    if (result.isErr()) {
      console.error(
        "[SessionLogger] failed to save Codex output",
        result.error,
      );
      return null;
    }
    return result.value;
  }

  private async createCodexExecutionFailedError(
    options: CodexFailureDetailOptions,
  ): Promise<WorkerError> {
    try {
      return {
        type: "CODEX_EXECUTION_FAILED",
        error: await this.formatCodexFailureDetail(options),
      };
    } catch (error) {
      console.error("[Worker] failed to format Codex failure detail", error);
      return {
        type: "CODEX_EXECUTION_FAILED",
        error: [
          options.exitCode === undefined
            ? "Codex実行失敗"
            : `Codex実行失敗 (終了コード: ${options.exitCode})`,
          "",
          "詳細の整形中にエラーが発生しました:",
          truncateDiagnostic(formatUnknownError(error)),
        ].join("\n"),
      };
    }
  }

  private async formatCodexFailureDetail(
    options: CodexFailureDetailOptions,
  ): Promise<string> {
    const lines = [
      options.exitCode === undefined
        ? "Codex実行失敗"
        : `Codex実行失敗 (終了コード: ${options.exitCode})`,
    ];

    if (options.reason?.trim()) {
      lines.push("", "理由:", truncateDiagnostic(options.reason));
    }

    if (options.stderr?.trim()) {
      lines.push("", "stderr:", truncateDiagnostic(options.stderr));
    }

    const diagnostic = this.extractOutputDiagnostics(options.rawOutput);
    if (diagnostic) {
      lines.push("", "Codex出力の手がかり:", diagnostic);
    }

    if (options.sessionLogPath) {
      lines.push("", `保存ログ: ${options.sessionLogPath}`);
    }

    const detail = lines.join("\n").trim();
    return detail.length <= DIAGNOSTIC_TEXT_LIMIT
      ? detail
      : `${
        detail.slice(0, DIAGNOSTIC_TEXT_LIMIT)
      }\n...詳細が長すぎるため省略しました`;
  }

  private extractOutputDiagnostics(rawOutput: string): string {
    const snippets: string[] = [];
    for (const line of rawOutput.split("\n")) {
      if (!line.trim()) continue;
      const parsed = this.streamProcessor.parseLine(line);
      const errorText = parsed.json
        ? this.extractJsonErrorText(parsed.json)
        : "";
      const text = [errorText, parsed.finalText, parsed.text]
        .filter((item) => item && item.trim())
        .join("\n");
      if (text.trim()) snippets.push(text.trim());
    }

    const unique = [...new Set(snippets)].slice(-6);
    if (unique.length === 0) return "";
    return truncateDiagnostic(unique.join("\n---\n"));
  }

  private extractJsonErrorText(json: Record<string, unknown>): string {
    const error = json.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const obj = error as Record<string, unknown>;
      return [obj.message, obj.code, obj.type]
        .filter((item) => typeof item === "string" && item)
        .join("\n");
    }

    const type = typeof json.type === "string" ? json.type : "";
    const message = json.message;
    if (type.toLowerCase().includes("error") && typeof message === "string") {
      return message;
    }
    return "";
  }

  isRunning(): boolean {
    return this.activeExecution !== null;
  }

  getPendingQuestion(): string | null {
    return this.codexExecutor.getPendingQuestion?.() ?? null;
  }

  getPendingQuestions(): readonly PendingQuestion[] {
    return this.codexExecutor.getPendingQuestions?.() ?? [];
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
    if (!this.isExecuting || !this.abortController) {
      return false;
    }

    this.abortController.abort();
    const process = this.codexProcess;
    const timer = setTimeout(() => {
      try {
        process?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, PROCESS.TERMINATION_TIMEOUT_MS);

    try {
      // No child exists while startup progress is being delivered. Waiting
      // there can deadlock a callback that itself requested cancellation.
      if (process) await this.activeExecution;
    } finally {
      clearTimeout(timer);
    }

    if (onProgress) {
      await onProgress("⛔ Codex実行を中断しました。");
    }
    return true;
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
