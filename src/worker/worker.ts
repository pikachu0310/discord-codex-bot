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
  DefaultCodexCommandExecutor,
} from "./codex-executor.ts";
import {
  CodexStreamProcessor,
  extractRateLimitTimestamp,
  type ParsedUsage,
} from "./codex-stream-processor.ts";
import { estimateCostUsd } from "./model-pricing.ts";
import { MessageFormatter } from "./message-formatter.ts";
import { SessionLogger } from "./session-logger.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import type { IWorker, WorkerError } from "./types.ts";

const DIAGNOSTIC_SECTION_LIMIT = 1800;
const DIAGNOSTIC_TEXT_LIMIT = 5000;
const USD_TO_JPY_RATE = 160;
const ZERO_TOKEN_TOTALS = {
  inputTokens: 0,
  processingTokens: 0,
  outputTokens: 0,
};

interface ResolvedCost {
  usd: number;
  source: "api" | "estimated";
  model?: string;
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

function resolveUsageCost(usage: ParsedUsage): ResolvedCost | null {
  if (usage.costUsd !== undefined) {
    return { usd: usage.costUsd, source: "api", model: usage.model };
  }
  const estimated = estimateCostUsd(usage);
  if (!estimated) return null;
  return {
    usd: estimated.usd,
    source: "estimated",
    model: estimated.model,
  };
}

function formatUsdToJpyLine(label: string, usd: number): string {
  const costJpy = Math.round(usd * USD_TO_JPY_RATE);
  return `${label}： ¥${costJpy.toLocaleString("ja-JP")} JPY ($${
    usd.toFixed(6)
  }USD)`;
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
    let outputLastMessagePath: string | null = null;
    let rateLimitTimestamp: number | undefined;
    let latestUsage: ParsedUsage | undefined;

    const onData = (chunk: Uint8Array) => {
      const text = new TextDecoder().decode(chunk, { stream: true });
      allOutput += text;
      pendingBuffer += text;
      const lines = pendingBuffer.split("\n");
      pendingBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const parsed = this.streamProcessor.parseLine(line);

        if (parsed.rateLimitTimestamp !== undefined) {
          rateLimitTimestamp = parsed.rateLimitTimestamp;
        }
        if (parsed.usage) {
          latestUsage = parsed.usage;
        }

        if (parsed.sessionId) {
          newSessionId = parsed.sessionId;
        }

        if (parsed.finalText) {
          finalResult = parsed.finalText;
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
      outputLastMessagePath = await this.workspaceManager.createTempFile({
        prefix: "discord-codex-last-message-",
        suffix: ".txt",
      });

      const args = this.buildExecutionArgs(
        message,
        attachments,
        outputLastMessagePath,
      );

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
        if (parsed.rateLimitTimestamp !== undefined) {
          rateLimitTimestamp = parsed.rateLimitTimestamp;
        }
        if (parsed.usage) {
          latestUsage = parsed.usage;
        }
      }

      if (execResult.isErr()) {
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
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: await this.formatCodexFailureDetail({
            reason: execResult.error.type === "COMMAND_EXECUTION_FAILED"
              ? execResult.error.stderr
              : execResult.error.error,
            rawOutput: allOutput,
            outputLastMessagePath,
            sessionLogPath: logPath,
          }),
        });
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
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: await this.formatCodexFailureDetail({
            exitCode: code,
            stderr: stderrText,
            rawOutput: allOutput,
            outputLastMessagePath,
            sessionLogPath: logPath,
          }),
        });
      }

      if (newSessionId && newSessionId !== this.state.sessionId) {
        this.state.sessionId = newSessionId;
      }

      if (!finalResult.trim()) {
        finalResult = await this.readOutputLastMessage(outputLastMessagePath);
      }

      if (latestUsage) {
        const currentCost = resolveUsageCost(latestUsage);
        const totals = this.state.threadTokenTotals ?? { ...ZERO_TOKEN_TOTALS };
        totals.inputTokens += latestUsage.inputTokens;
        totals.processingTokens += latestUsage.processingTokens;
        totals.outputTokens += latestUsage.outputTokens;
        this.state.threadTokenTotals = totals;
        if (currentCost) {
          this.state.threadCostUsd = (this.state.threadCostUsd ?? 0) +
            currentCost.usd;
        }
      }

      await this.saveRawCodexOutput(allOutput, this.state.sessionId);
      await this.save();

      const usageSummary = this.formatUsageSummary(
        latestUsage,
        this.state.threadTokenTotals,
        this.state.threadCostUsd,
      );
      const responseText = finalResult.trim() || MESSAGES.NO_FINAL_RESPONSE;
      return ok(
        this.formatter.formatResponse(
          usageSummary ? `${responseText}\n\n${usageSummary}` : responseText,
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
      return err({
        type: "CODEX_EXECUTION_FAILED",
        error: await this.formatCodexFailureDetail({
          reason: error instanceof Error ? error.message : String(error),
          rawOutput: allOutput,
          outputLastMessagePath,
          sessionLogPath: logPath,
        }),
      });
    } finally {
      this.isExecuting = false;
      this.abortController = null;
      this.codexProcess = null;
      if (outputLastMessagePath) {
        await Deno.remove(outputLastMessagePath).catch(() => {});
      }
    }
  }

  private buildExecutionArgs(
    prompt: string,
    attachments: readonly SavedAttachment[] = [],
    outputLastMessagePath?: string | null,
  ): string[] {
    const promptWithAttachments = formatPromptWithAttachments(
      prompt,
      attachments,
    );
    const imagePaths = getCodexImagePaths(attachments);

    if (!this.isPlanMode()) {
      return this.configuration.buildCodexArgs(
        promptWithAttachments,
        this.state.sessionId,
        imagePaths,
        outputLastMessagePath,
      );
    }

    const planPrompt = [
      "You are in plan mode.",
      "Return an implementation plan before coding.",
      "If coding is needed, include clear ordered steps.",
      "",
      promptWithAttachments,
    ].join("\n");
    return this.configuration.buildCodexArgs(
      planPrompt,
      this.state.sessionId,
      imagePaths,
      outputLastMessagePath,
    );
  }

  private async readOutputLastMessage(path: string): Promise<string> {
    try {
      return await Deno.readTextFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return "";
      }
      throw error;
    }
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

  private async formatCodexFailureDetail(options: {
    exitCode?: number;
    reason?: string;
    stderr?: string;
    rawOutput: string;
    outputLastMessagePath?: string | null;
    sessionLogPath?: string | null;
  }): Promise<string> {
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

    const lastMessage = options.outputLastMessagePath
      ? await this.readOutputLastMessage(options.outputLastMessagePath)
      : "";
    if (lastMessage.trim()) {
      lines.push("", "Codex最終メッセージ:", truncateDiagnostic(lastMessage));
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

  private formatUsageSummary(
    usage?: ParsedUsage,
    threadTotals?: {
      inputTokens: number;
      processingTokens: number;
      outputTokens: number;
    },
    threadCostUsd?: number,
  ): string {
    if (!usage) return "";

    const lines = [
      "```text",
      `トークン: 入力 ${usage.inputTokens} / 処理 ${usage.processingTokens} / 出力 ${usage.outputTokens}`,
    ];
    if (usage.cachedInputTokens > 0) {
      lines.push(`入力キャッシュ: ${usage.cachedInputTokens}`);
    }
    if (usage.totalTokens !== undefined) {
      lines.push(`合計: ${usage.totalTokens}`);
    }
    if (usage.model) {
      lines.push(`モデル: ${usage.model}`);
    }

    const cost = resolveUsageCost(usage);

    if (cost) {
      lines.push(formatUsdToJpyLine("料金", cost.usd));
      lines.push(
        cost.source === "api"
          ? "※ OpenAI応答の cost_usd を表示"
          : `※ cost_usd 欠落のためモデル単価から算出（${cost.model}）`,
      );
      lines.push(`※ 1 USD = ${USD_TO_JPY_RATE} JPY の固定レートで換算`);
    } else {
      lines.push(
        "料金： 取得不可（cost_usd が無く、モデル単価表でも計算できません）",
      );
    }
    if (threadTotals) {
      const total = threadTotals.inputTokens + threadTotals.processingTokens +
        threadTotals.outputTokens;
      lines.push(`スレッド累計トークン: 合計 ${total}`);
      if (threadCostUsd !== undefined) {
        lines.push(formatUsdToJpyLine("スレッド累計料金", threadCostUsd));
      }
    }
    lines.push("```");
    return lines.join("\n");
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
