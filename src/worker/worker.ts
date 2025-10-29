import { GitRepository } from "../git-utils.ts";
import { WorkerState, WorkspaceManager } from "../workspace/workspace.ts";
import { PLaMoTranslator } from "../plamo-translator.ts";
import { MessageFormatter } from "./message-formatter.ts";
import {
  CodexCodeRateLimitError,
  type CodexStreamMessage,
  CodexStreamProcessor,
  JsonParseError,
  SchemaValidationError,
} from "./codex-stream-processor.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import { SessionLogger } from "./session-logger.ts";
import {
  CodexCommandExecutor,
  DefaultCodexCommandExecutor,
  DevcontainerCodexExecutor,
} from "./codex-executor.ts";
import type { IWorker, WorkerError } from "./types.ts";
import { err, ok, Result } from "neverthrow";
import { PROCESS } from "../constants.ts";
import type { RateLimitManager } from "../admin/rate-limit-manager.ts";
import { ContextCompressor } from "../services/context-compressor.ts";

export class Worker implements IWorker {
  private state: WorkerState;
  private codexExecutor: CodexCommandExecutor;
  private readonly workspaceManager: WorkspaceManager;
  private readonly configuration: WorkerConfiguration;
  private readonly sessionLogger: SessionLogger;
  private readonly contextCompressor: ContextCompressor;
  private formatter: MessageFormatter;
  private translator: PLaMoTranslator | null = null;
  private codexProcess: Deno.ChildProcess | null = null;
  private abortController: AbortController | null = null;
  private isExecuting = false;
  private executionStartTime: number | null = null;
  private lastActivityDescription: string | null = null;
  private rateLimitManager?: RateLimitManager;

  constructor(
    state: WorkerState,
    workspaceManager: WorkspaceManager,
    codexExecutor?: CodexCommandExecutor,
    verbose?: boolean,
    appendSystemPrompt?: string,
    translatorUrl?: string,
    rateLimitManager?: RateLimitManager,
  ) {
    this.state = state;
    this.workspaceManager = workspaceManager;
    this.configuration = new WorkerConfiguration(
      verbose || false,
      appendSystemPrompt,
      translatorUrl,
    );
    this.sessionLogger = new SessionLogger(workspaceManager);
    this.contextCompressor = new ContextCompressor();
    this.formatter = new MessageFormatter(state.worktreePath || undefined);
    this.codexExecutor = codexExecutor ||
      new DefaultCodexCommandExecutor(this.configuration.isVerbose());
    this.rateLimitManager = rateLimitManager;

    // 翻訳URLが設定されている場合は翻訳機能を初期化
    this.translator = PLaMoTranslator.fromEnv(translatorUrl);
    if (this.translator) {
      this.logVerbose("翻訳機能を初期化", { translatorUrl });
    }
  }

  async processMessage(
    message: string,
    onProgress: (content: string) => Promise<void> = async () => {},
    onReaction?: (emoji: string) => Promise<void>,
  ): Promise<Result<string, WorkerError>> {
    this.logVerbose("メッセージ処理開始", {
      messageLength: message.length,
      hasRepository: !!this.state.repository,
      hasWorktreePath: !!this.state.worktreePath,
      threadId: this.state.threadId,
      sessionId: this.state.sessionId,
      hasReactionCallback: !!onReaction,
    });

    // VERBOSEモードでユーザーメッセージの詳細ログ
    if (this.configuration.isVerbose()) {
      console.log(
        `[${
          new Date().toISOString()
        }] [Worker:${this.state.workerName}] ユーザーメッセージ処理詳細:`,
      );
      console.log(`  メッセージ: "${message}"`);
      console.log(`  リポジトリ: ${this.state.repository?.fullName || "なし"}`);
      console.log(`  worktreePath: ${this.state.worktreePath || "なし"}`);
      console.log(`  セッションID: ${this.state.sessionId || "なし"}`);
    }

    if (!this.state.repository || !this.state.worktreePath) {
      this.logVerbose("リポジトリまたはworktreeパスが未設定");
      return err({ type: "REPOSITORY_NOT_SET" });
    }

    // devcontainerの選択が完了していない場合は設定を促すメッセージを返す
    if (!this.isConfigurationComplete()) {
      this.logVerbose("Codex Code設定が未完了", {
        devcontainerChoiceMade: this.isConfigurationComplete(),
        useDevcontainer: this.state.devcontainerConfig.useDevcontainer,
      });

      return err({ type: "CONFIGURATION_INCOMPLETE" });
    }

    // 実行状態を設定
    this.isExecuting = true;
    this.abortController = new AbortController();
    this.executionStartTime = Date.now();
    this.lastActivityDescription = null;

    try {
      // 翻訳処理（設定されている場合のみ）
      let translatedMessage = message;
      if (this.translator) {
        this.logVerbose("メッセージの翻訳を開始");
        const translateResult = await this.translator.translate(message);

        if (translateResult.isOk()) {
          translatedMessage = translateResult.value;
          this.logVerbose("メッセージの翻訳完了", {
            originalLength: message.length,
            translatedLength: translatedMessage.length,
          });

          // VERBOSEモードで翻訳結果を表示
          if (this.configuration.isVerbose() && message !== translatedMessage) {
            console.log(
              `[${
                new Date().toISOString()
              }] [Worker:${this.state.workerName}] 翻訳結果:`,
            );
            console.log(`  元のメッセージ: "${message}"`);
            console.log(`  翻訳後: "${translatedMessage}"`);
          }
        } else {
          this.logVerbose("翻訳エラー（元のメッセージを使用）", {
            errorType: translateResult.error.type,
            error: translateResult.error,
          });
          // 翻訳に失敗した場合は元のメッセージを使用
          translatedMessage = message;
        }
      }

      // 処理開始の通知
      this.logVerbose("進捗通知開始");
      await onProgress("🤖 Codexが考えています...");

      // Codex実行開始前のリアクションを追加
      if (onReaction) {
        try {
          await onReaction("⚙️");
          this.logVerbose("Codex実行開始リアクション追加完了");
        } catch (error) {
          this.logVerbose("Codex実行開始リアクション追加エラー", {
            error: (error as Error).message,
          });
        }
      }

      this.logVerbose("Codex実行開始");
      const codexResult = await this.executeCodex(
        translatedMessage,
        onProgress,
      );
      if (codexResult.isErr()) {
        // 中断エラーの場合は特別なメッセージを返す
        if (
          codexResult.error.type === "CODEX_EXECUTION_FAILED" &&
          codexResult.error.error === "中断されました"
        ) {
          // 中断が正常に完了した場合はエラーではなく正常終了として扱う
          return ok(
            "⛔ Codex Codeの実行を中断しました\n\n💡 新しい指示を送信して作業を続けることができます",
          );
        }
        return codexResult;
      }

      const result = codexResult.value;
      this.logVerbose("Codex実行完了", { resultLength: result.length });

      const formattedResponse = this.formatter.formatResponse(result);
      this.logVerbose("レスポンス整形完了", {
        formattedLength: formattedResponse.length,
      });

      this.logVerbose("メッセージ処理完了");
      return ok(formattedResponse);
    } catch (error) {
      if (error instanceof CodexCodeRateLimitError) {
        return err({
          type: "RATE_LIMIT",
          retryAt: error.retryAt,
          timestamp: error.timestamp,
        });
      }
      this.logVerbose("メッセージ処理エラー", {
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack,
      });
      console.error(
        `Worker ${this.state.workerName} - Codex実行エラー:`,
        error,
      );
      return err({
        type: "CODEX_EXECUTION_FAILED",
        error: (error as Error).message,
      });
    } finally {
      // 実行状態をリセット
      this.isExecuting = false;
      this.codexProcess = null;
      this.abortController = null;
      this.executionStartTime = null;
      this.lastActivityDescription = null;
    }
  }

  private async executeCodex(
    prompt: string,
    onProgress: (content: string) => Promise<void>,
  ): Promise<Result<string, WorkerError>> {
    let lastResult: Result<string, WorkerError> = err({
      type: "CODEX_EXECUTION_FAILED",
      error: "Codex execution did not run",
    });

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const args = this.buildExecutionArgs(prompt);

      this.logVerbose("Codexコマンド実行", {
        args: args,
        cwd: this.state.worktreePath,
        useDevcontainer: this.state.devcontainerConfig.useDevcontainer,
        isPlanMode: this.isPlanMode(),
      });

      this.logVerbose("ストリーミング実行開始");
      lastResult = await this.executeCodexStreaming(args, onProgress);

      if (lastResult.isErr() && lastResult.error.type === "CODEX_CLI_UNSUPPORTED_OPTION") {
        if (
          lastResult.error.option === "--output-format" &&
          attempt < maxAttempts - 1
        ) {
          this.logVerbose("Codex CLIが--output-formatをサポートしていないため再試行", {
            stderr: lastResult.error.stderr,
          });
          this.configuration.disableOutputFormatFlag();
          continue;
        }

        if (
          lastResult.error.option === "--verbose" &&
          this.configuration.shouldUseCliVerboseFlag() &&
          attempt < maxAttempts - 1
        ) {
          this.logVerbose("Codex CLIが--verboseをサポートしていないため再試行", {
            stderr: lastResult.error.stderr,
          });
          this.configuration.disableVerboseFlag();
          continue;
        }
      }

      return lastResult;
    }

    return lastResult;
  }

  private buildExecutionArgs(prompt: string): string[] {
    const args = this.configuration.buildCodexArgs(
      prompt,
      this.state.sessionId,
    );

    if (!this.isPlanMode()) {
      return args;
    }

    const planModePrompt = `
You are in plan mode. When responding to user requests, you should:
1. Think about the implementation steps first
2. Present a clear, structured plan to the user
3. Use the exit_plan_mode tool when you've finished planning and are ready to start implementation
4. Only use the exit_plan_mode tool for tasks that require code implementation

For research, analysis, or informational tasks, do not use the exit_plan_mode tool.
`;

    const modifiedArgs = [...args];
    const systemPromptIndex = modifiedArgs.findIndex((arg) =>
      arg === "--append-system-prompt" ||
      arg.startsWith("--append-system-prompt=")
    );

    if (systemPromptIndex !== -1) {
      const current = modifiedArgs[systemPromptIndex];
      if (current === "--append-system-prompt" &&
        systemPromptIndex < modifiedArgs.length - 1) {
        modifiedArgs[systemPromptIndex + 1] += planModePrompt;
      } else if (current.startsWith("--append-system-prompt=")) {
        modifiedArgs[systemPromptIndex] = `${current}${planModePrompt}`;
      } else {
        modifiedArgs.push("--append-system-prompt", planModePrompt);
      }
    } else {
      modifiedArgs.push("--append-system-prompt", planModePrompt);
    }

    this.logVerbose("Planモード用システムプロンプト追加");
    return modifiedArgs;
  }

  private async executeCodexStreaming(
    args: string[],
    onProgress: (content: string) => Promise<void>,
  ): Promise<Result<string, WorkerError>> {
    this.logVerbose("ストリーミング実行詳細開始");
    const decoder = new TextDecoder();
    let buffer = "";
    let result = "";
    let newSessionId: string | null = null;
    let allOutput = "";
    let processedLines = 0;

    const streamProcessor = new CodexStreamProcessor(
      this.formatter,
    );

    const processLine = (line: string) => {
      if (!line.trim()) return;
      processedLines++;
      this.processStreamLine(
        line,
        streamProcessor,
        onProgress,
        { result, newSessionId },
        (updates) => {
          result = updates.result || result;
          newSessionId = updates.newSessionId || newSessionId;
        },
      );
    };

    const onData = (data: Uint8Array) => {
      const { updatedBuffer, updatedAllOutput } = this.handleStreamData(
        data,
        decoder,
        buffer,
        allOutput,
        processLine,
      );
      buffer = updatedBuffer;
      allOutput = updatedAllOutput;
    };

    if (!this.state.worktreePath) {
      return err({
        type: "REPOSITORY_NOT_SET",
      });
    }

    // コンテキスト圧縮を実行
    await this.checkAndCompressContext();

    const executionResult = await this.codexExecutor.executeStreaming(
      args,
      this.state.worktreePath,
      onData,
      this.abortController?.signal,
      (childProcess) => {
        this.codexProcess = childProcess;
        this.logVerbose("Codexプロセス開始", {
          processId: childProcess.pid,
        });
      },
      this.configuration.buildCodexEnv(),
    );

    if (executionResult.isErr()) {
      // 中断による終了の場合
      if (
        executionResult.error.type === "STREAM_PROCESSING_ERROR" &&
        executionResult.error.error === "実行が中断されました"
      ) {
        // セッションデータを保存してから中断メッセージを返す
        await this.saveSessionData(newSessionId, allOutput);
        return err({
          type: "CODEX_EXECUTION_FAILED",
          error: "中断されました",
        });
      }

      const errorMessage =
        executionResult.error.type === "COMMAND_EXECUTION_FAILED"
          ? `コマンド実行失敗 (コード: ${executionResult.error.code}): ${executionResult.error.stderr}`
          : executionResult.error.error;
      return err({
        type: "CODEX_EXECUTION_FAILED",
        error: errorMessage,
      });
    }

    const { code, stderr } = executionResult.value;

    this.logVerbose("ストリーミング実行完了", {
      exitCode: code,
      stderrLength: stderr.length,
      totalOutputLength: allOutput.length,
      processedLines,
      hasNewSessionId: !!newSessionId,
    });

    // 最後のバッファを処理
    if (buffer) {
      this.logVerbose("最終バッファ処理", { bufferLength: buffer.length });
      processLine(buffer);
    }

    if (code !== 0) {
      return this.handleErrorMessage(code, stderr, allOutput);
    }

    // VERBOSEモードで成功時のstderrも出力（警告等の情報がある場合）
    if (this.configuration.isVerbose() && stderr.length > 0) {
      const stderrContent = new TextDecoder().decode(stderr);
      if (stderrContent.trim()) {
        console.log(
          `[${
            new Date().toISOString()
          }] [Worker:${this.state.workerName}] Codex stderr (警告等):`,
        );
        console.log(
          `  ${
            stderrContent.split("\n").map((line) => `  ${line}`).join("\n")
          }`,
        );
      }
    }

    const finalResult = await this.finalizeStreamProcessing(
      result,
      newSessionId,
      allOutput,
    );
    return finalResult;
  }

  private processStreamLine(
    line: string,
    streamProcessor: CodexStreamProcessor,
    onProgress: ((content: string) => Promise<void>) | undefined,
    state: { result: string; newSessionId: string | null },
    updateState: (updates: {
      result?: string;
      newSessionId?: string | null;
    }) => void,
  ): void {
    // 空行はスキップ
    if (!line.trim()) {
      return;
    }

    this.logVerbose(`ストリーミング行処理: ${line}`);
    try {
      // 安全なJSON解析と型検証を使用
      const parsed = streamProcessor.parseJsonLine(line);

      // メッセージタイプごとの処理
      switch (parsed.type) {
        case "result":
          this.handleResultMessage(parsed, updateState);
          break;
        case "assistant":
          this.handleAssistantMessage(parsed, state, updateState);
          // assistantメッセージからトークン使用量を追跡
          if (parsed.message?.usage && this.rateLimitManager) {
            const usage = parsed.message.usage;
            const inputTokens = usage.input_tokens +
              (usage.cache_creation_input_tokens || 0) +
              (usage.cache_read_input_tokens || 0);
            const outputTokens = usage.output_tokens;

            this.rateLimitManager.trackTokenUsage(inputTokens, outputTokens);
            this.logVerbose("トークン使用量を追跡", {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            });
          }
          break;
      }

      // Codex Codeの実際の出力内容をDiscordに送信
      if (onProgress) {
        const outputMessage = streamProcessor.extractOutputMessage(parsed);
        if (outputMessage) {
          // 最後のアクティビティを記録
          this.lastActivityDescription = this.extractActivityDescription(
            parsed,
            outputMessage,
          );
          onProgress(this.formatter.formatResponse(outputMessage)).catch(
            console.error,
          );
        }
      }

      // セッションIDを更新
      if (parsed.session_id) {
        updateState({ newSessionId: parsed.session_id });
        this.logVerbose("新しいセッションID取得", {
          sessionId: parsed.session_id,
        });
      }
    } catch (parseError) {
      if (parseError instanceof CodexCodeRateLimitError) {
        throw parseError;
      }

      // エラーの種類に応じて詳細なログを出力
      if (parseError instanceof JsonParseError) {
        this.logVerbose("JSON解析エラー", {
          linePreview: parseError.line.substring(0, 100),
          cause: String(parseError.cause),
        });
        console.warn(`JSON解析エラー: ${parseError.message}`);
      } else if (parseError instanceof SchemaValidationError) {
        this.logVerbose("スキーマ検証エラー", {
          data: JSON.stringify(parseError.data).substring(0, 200),
          message: parseError.message,
        });
        console.warn(`スキーマ検証エラー: ${parseError.message}`);
      } else {
        this.logVerbose(`予期しないエラー: ${parseError}`, {
          line: line.substring(0, 100),
        });
        console.warn(`予期しないエラー: ${parseError}`);
      }

      // JSONとしてパースできなかった場合もレートリミットをチェック
      if (line.trim()) {
        // Codex Codeレートリミットの検出（生テキスト内）
        if (line.includes("Codex AI usage limit reached")) {
          this.logVerbose("Codex Codeレートリミット検出（生テキスト内）", {
            line: line.substring(0, 200),
          });
          const match = line.match(
            /Codex AI usage limit reached[\|\s](\d+)/,
          );
          if (match) {
            throw new CodexCodeRateLimitError(
              Number.parseInt(match[1], 10),
            );
          }
        }

        // 全文を投稿
        if (onProgress) {
          onProgress(this.formatter.formatResponse(line)).catch(console.error);
        }
      }
    }
  }

  private handleAssistantMessage(
    parsed: CodexStreamMessage,
    state: { result: string; newSessionId: string | null },
    updateState: (updates: { result?: string }) => void,
  ): void {
    if (parsed.type === "assistant" && parsed.message?.content) {
      let textResult = "";
      for (const content of parsed.message.content) {
        if (content.type === "text" && content.text) {
          textResult += content.text;
        }
      }
      if (textResult) {
        // Codex Codeレートリミットの検出（assistantメッセージ内）
        if (textResult.includes("Codex AI usage limit reached")) {
          this.logVerbose(
            "Codex Codeレートリミット検出（assistantメッセージ内）",
            {
              textResult: textResult.substring(0, 200),
            },
          );
          const match = textResult.match(
            /Codex AI usage limit reached[\|\s](\d+)/,
          );
          if (match) {
            throw new CodexCodeRateLimitError(
              Number.parseInt(match[1], 10),
            );
          }
        }

        // 既存の結果に追加する形で更新
        updateState({ result: state.result + textResult });
      }
    }
  }

  private handleResultMessage(
    parsed: CodexStreamMessage,
    updateState: (updates: { result?: string }) => void,
  ): void {
    if (parsed.type === "result" && "result" in parsed && parsed.result) {
      updateState({ result: parsed.result });
      this.logVerbose("最終結果取得", {
        resultLength: parsed.result.length,
        subtype: parsed.subtype,
        isError: parsed.is_error,
      });

      // resultメッセージからトークン使用量を追跡
      if (parsed.usage && this.rateLimitManager) {
        const usage = parsed.usage;
        const inputTokens = usage.input_tokens +
          (usage.cache_creation_input_tokens || 0) +
          (usage.cache_read_input_tokens || 0);
        const outputTokens = usage.output_tokens;

        this.rateLimitManager.trackTokenUsage(inputTokens, outputTokens);
        this.logVerbose("トークン使用量を追跡（resultメッセージ）", {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });
      }

      // Codex Codeレートリミットの検出
      if (parsed.result.includes("Codex AI usage limit reached")) {
        this.logVerbose("Codex Codeレートリミット検出（resultメッセージ内）", {
          result: parsed.result.substring(0, 200),
        });
        const match = parsed.result.match(
          /Codex AI usage limit reached[\|\s](\d+)/,
        );
        if (match) {
          throw new CodexCodeRateLimitError(
            Number.parseInt(match[1], 10),
          );
        }
      }
    }
  }

  private handleErrorMessage(
    code: number,
    stderr: Uint8Array,
    stdout: string,
  ): Result<never, WorkerError> {
    const stderrMessage = new TextDecoder().decode(stderr);

    if (stderrMessage.includes("unexpected argument '--output-format'")) {
      this.logVerbose("Codex CLIが--output-formatを認識しないエラーを検出", {
        exitCode: code,
        stderr: stderrMessage,
      });
      return err({
        type: "CODEX_CLI_UNSUPPORTED_OPTION",
        option: "--output-format",
        stderr: stderrMessage,
      });
    }

    if (stderrMessage.includes("unexpected argument '--verbose'")) {
      this.logVerbose("Codex CLIが--verboseを認識しないエラーを検出", {
        exitCode: code,
        stderr: stderrMessage,
      });
      return err({
        type: "CODEX_CLI_UNSUPPORTED_OPTION",
        option: "--verbose",
        stderr: stderrMessage,
      });
    }

    // VERBOSEモードで詳細ログ出力
    if (this.configuration.isVerbose()) {
      // stdout出力（エラー時）
      if (stdout.trim()) {
        console.log(
          `[${
            new Date().toISOString()
          }] [Worker:${this.state.workerName}] Codex stdout (エラー時):`,
        );
        console.log(
          `  ${stdout.split("\n").map((line) => `  ${line}`).join("\n")}`,
        );
      }

      // stderr出力
      if (stderr.length > 0) {
        console.log(
          `[${
            new Date().toISOString()
          }] [Worker:${this.state.workerName}] Codex stderr:`,
        );
        console.log(`  終了コード: ${code}`);
        console.log(`  エラー内容:`);
        console.log(
          `    ${
            stderrMessage.split("\n").map((line) => `    ${line}`).join("\n")
          }`,
        );
      }
    }

    // エラーメッセージの構築（stdoutも含める）
    let errorDetail = `Codex実行失敗 (終了コード: ${code})`;
    if (stderrMessage.trim()) {
      errorDetail += `\nstderr: ${stderrMessage}`;
    }
    if (stdout.trim()) {
      // stdoutの最後の10行を含める（長すぎる場合は切り詰め）
      const stdoutLines = stdout.trim().split("\n");
      const lastLines = stdoutLines.slice(-10).join("\n");
      errorDetail += `\nstdout (最後の10行): ${lastLines}`;
    }

    this.logVerbose("ストリーミング実行エラー", {
      exitCode: code,
      stderrMessage,
      stdoutLength: stdout.length,
    });
    return err({
      type: "CODEX_EXECUTION_FAILED",
      error: errorDetail,
    });
  }

  private async saveSessionData(
    newSessionId: string | null,
    allOutput: string,
  ): Promise<void> {
    // セッションIDを更新
    if (newSessionId) {
      this.state.sessionId = newSessionId;
      this.logVerbose("セッションID更新", {
        oldSessionId: this.state.sessionId,
        newSessionId,
      });

      // 非同期でWorker状態を保存
      this.saveAsync();
    }

    // 生のjsonlを保存
    if (this.state.repository?.fullName && allOutput.trim()) {
      this.logVerbose("生JSONLを保存", { outputLength: allOutput.length });
      const saveResult = await this.sessionLogger.saveRawJsonlOutput(
        this.state.repository.fullName,
        this.state.sessionId || undefined,
        allOutput,
      );
      if (saveResult.isErr()) {
        this.logVerbose("SessionLogger保存エラー", {
          error: saveResult.error,
        });
      }
    }
  }

  private handleStreamData(
    data: Uint8Array,
    decoder: TextDecoder,
    buffer: string,
    allOutput: string,
    processLine: (line: string) => void,
  ): { updatedBuffer: string; updatedAllOutput: string } {
    const chunk = decoder.decode(data, { stream: true });
    allOutput += chunk;
    buffer += chunk;

    // VERBOSEモードでstdoutを詳細ログ出力
    if (this.configuration.isVerbose() && chunk.trim()) {
      console.log(
        `[${
          new Date().toISOString()
        }] [Worker:${this.state.workerName}] Codex stdout:`,
      );
      console.log(
        `  ${chunk.split("\n").map((line) => `  ${line}`).join("\n")}`,
      );
    }

    // 改行で分割して処理
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      processLine(line);
    }

    return { updatedBuffer: buffer, updatedAllOutput: allOutput };
  }

  private async finalizeStreamProcessing(
    result: string,
    newSessionId: string | null,
    allOutput: string,
  ): Promise<Result<string, WorkerError>> {
    await this.saveSessionData(newSessionId, allOutput);

    const finalResult = result.trim() ||
      "Codex からの応答を取得できませんでした。";
    this.logVerbose("ストリーミング処理完了", {
      finalResultLength: finalResult.length,
    });
    return ok(finalResult);
  }

  getName(): string {
    return this.state.workerName;
  }

  getRepository(): GitRepository | null {
    return this.state.repository
      ? {
        fullName: this.state.repository.fullName,
        org: this.state.repository.org,
        repo: this.state.repository.repo,
        localPath: this.state.repositoryLocalPath ||
          this.state.repository.fullName,
      }
      : null;
  }

  async setRepository(
    repository: GitRepository,
    localPath: string,
  ): Promise<Result<void, WorkerError>> {
    this.logVerbose("リポジトリ設定開始", {
      repositoryFullName: repository.fullName,
      localPath,
      hasThreadId: !!this.state.threadId,
      useDevcontainer: this.state.devcontainerConfig.useDevcontainer,
    });

    this.state.repository = {
      fullName: repository.fullName,
      org: repository.org,
      repo: repository.repo,
    };
    this.state.repositoryLocalPath = localPath;

    if (this.state.threadId) {
      try {
        this.logVerbose("worktree作成開始", { threadId: this.state.threadId });
        this.state.worktreePath = await this.workspaceManager.ensureWorktree(
          this.state.threadId,
          localPath,
        );
        this.logVerbose("worktree作成完了", {
          worktreePath: this.state.worktreePath,
        });

        // ThreadInfo更新は削除（WorkerStateで管理）
        this.logVerbose("worktree情報をWorkerStateで管理");
      } catch (error) {
        this.logVerbose("worktree作成失敗、localPathを使用", {
          error: (error as Error).message,
          fallbackPath: localPath,
        });
        console.error(`worktreeの作成に失敗しました: ${error}`);
        this.state.worktreePath = localPath;
      }
    } else {
      this.logVerbose("threadIdなし、localPathを直接使用");
      this.state.worktreePath = localPath;
    }

    // devcontainerが有効な場合はDevcontainerCodexExecutorに切り替え
    if (
      this.state.devcontainerConfig.useDevcontainer && this.state.worktreePath
    ) {
      // リポジトリのPATを取得
      let ghToken: string | undefined;
      if (repository.fullName) {
        const patInfo = await this.workspaceManager.loadRepositoryPat(
          repository.fullName,
        );
        if (patInfo) {
          ghToken = patInfo.token;
          this.logVerbose("GitHub PAT取得（setRepository）", {
            repository: repository.fullName,
            hasToken: true,
          });
        }
      }

      this.logVerbose("DevcontainerCodexExecutorに切り替え");
      this.codexExecutor = new DevcontainerCodexExecutor(
        this.state.worktreePath,
        this.configuration.isVerbose(),
        ghToken,
      );
    }

    // MessageFormatterのworktreePathを更新
    this.formatter = new MessageFormatter(this.state.worktreePath || undefined);

    this.state.sessionId = null;
    this.logVerbose("リポジトリ設定完了", {
      finalWorktreePath: this.state.worktreePath,
      executorType: this.state.devcontainerConfig.useDevcontainer
        ? "DevcontainerCodexExecutor"
        : "DefaultCodexCommandExecutor",
    });

    // Worker状態を保存
    const saveResult = await this.save();
    if (saveResult.isErr()) {
      return saveResult;
    }

    return ok(undefined);
  }

  setThreadId(threadId: string): void {
    this.state.threadId = threadId;
    // 非同期でWorker状態を保存
    this.saveAsync();
  }

  /**
   * 非同期で状態を保存し、エラーをログに記録する
   */
  private saveAsync(): void {
    this.save().then((result) => {
      if (result.isErr()) {
        this.logVerbose("Worker状態の保存に失敗", {
          error: result.error,
          threadId: this.state.threadId,
        });
        console.error("Worker状態の保存に失敗しました:", result.error);
      }
    });
  }

  /**
   * devcontainerの使用を設定する
   */
  setUseDevcontainer(useDevcontainer: boolean): void {
    this.state.devcontainerConfig.useDevcontainer = useDevcontainer;

    // devcontainerが有効で、worktreePathが設定されている場合はExecutorを切り替え
    if (useDevcontainer && this.state.worktreePath) {
      this.logVerbose("DevcontainerCodexExecutorに切り替え（設定変更時）");
      this.codexExecutor = new DevcontainerCodexExecutor(
        this.state.worktreePath,
        this.configuration.isVerbose(),
      );
    } else if (!useDevcontainer && this.state.worktreePath) {
      // devcontainerを無効にした場合はDefaultに戻す
      this.logVerbose("DefaultCodexCommandExecutorに切り替え（設定変更時）");
      this.codexExecutor = new DefaultCodexCommandExecutor(
        this.configuration.isVerbose(),
      );
    }

    // 非同期でWorker状態を保存
    this.saveAsync();
  }

  /**
   * devcontainerが使用されているかを取得
   */
  isUsingDevcontainer(): boolean {
    return this.state.devcontainerConfig.useDevcontainer;
  }

  /**
   * devcontainerの使用設定を取得
   */
  getUseDevcontainer(): boolean {
    return this.state.devcontainerConfig.useDevcontainer;
  }

  /**
   * devcontainerが起動済みかを取得
   */
  isDevcontainerStarted(): boolean {
    return this.state.devcontainerConfig.isStarted;
  }

  /**
   * fallback devcontainerの使用を設定する
   */
  setUseFallbackDevcontainer(useFallback: boolean): void {
    this.state.devcontainerConfig.useFallbackDevcontainer = useFallback;
    this.logVerbose("fallback devcontainer設定変更", {
      useFallbackDevcontainer: useFallback,
    });

    // 非同期でWorker状態を保存
    this.saveAsync();
  }

  /**
   * fallback devcontainerが使用されているかを取得
   */
  isUsingFallbackDevcontainer(): boolean {
    return this.state.devcontainerConfig.useFallbackDevcontainer;
  }

  /**
   * verboseモードを設定する
   */
  setVerbose(verbose: boolean): void {
    this.configuration.setVerbose(verbose);
  }

  /**
   * verboseモードが有効かを取得
   */
  isVerbose(): boolean {
    return this.configuration.isVerbose();
  }

  /**
   * 権限チェックスキップ設定を設定する
   */
  setDangerouslySkipPermissions(skipPermissions: boolean): void {
    this.configuration.setDangerouslySkipPermissions(skipPermissions);
  }

  /**
   * 権限チェックスキップ設定を取得
   */
  isDangerouslySkipPermissions(): boolean {
    return this.configuration.getDangerouslySkipPermissions();
  }

  /**
   * 権限チェックスキップ設定を取得
   */
  getDangerouslySkipPermissions(): boolean {
    return this.configuration.getDangerouslySkipPermissions();
  }

  /**
   * 設定が完了しているかを確認
   */
  isConfigurationComplete(): boolean {
    // devcontainerの選択が済んでいればtrue
    return this.state.devcontainerConfig.useDevcontainer !== undefined;
  }

  /**
   * 現在の設定状態を取得
   */
  getConfigurationStatus(): {
    devcontainerChoiceMade: boolean;
    useDevcontainer: boolean;
  } {
    return {
      devcontainerChoiceMade:
        this.state.devcontainerConfig.useDevcontainer !== undefined,
      useDevcontainer: this.state.devcontainerConfig.useDevcontainer,
    };
  }

  /**
   * verboseログを出力する
   */
  private logVerbose(
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.configuration.logVerbose(this.state.workerName, message, metadata);
  }

  /**
   * ストリームメッセージから最後のアクティビティの説明を抽出
   */
  private extractActivityDescription(
    parsed: CodexStreamMessage,
    outputMessage: string,
  ): string {
    // ツール使用の場合
    if (parsed.type === "assistant" && parsed.message?.content) {
      for (const item of parsed.message.content) {
        if (item.type === "tool_use" && item.name) {
          return `ツール使用: ${item.name}`;
        }
      }
    }

    // ツール結果の場合
    if (parsed.type === "user" && parsed.message?.content) {
      for (const item of parsed.message.content) {
        if (typeof item === "string") {
          return item;
        }
        if (item.type === "tool_result") {
          return "ツール実行結果を処理";
        }
      }
    }

    // その他のメッセージの場合、最初の50文字を使用
    if (outputMessage) {
      const preview = outputMessage.substring(0, 50);
      return preview.length < outputMessage.length ? `${preview}...` : preview;
    }

    return "アクティビティ実行中";
  }

  /**
   * Planモードの状態を取得
   */
  isPlanMode(): boolean {
    return this.state.isPlanMode || false;
  }

  /**
   * Planモードの状態を設定
   */
  setPlanMode(planMode: boolean): void {
    this.state.isPlanMode = planMode;
    this.logVerbose("Planモード設定", { planMode });
  }

  /**
   * devcontainerを起動する
   */
  async startDevcontainer(
    onProgress?: (message: string) => Promise<void>,
  ): Promise<
    { success: boolean; containerId?: string; error?: string }
  > {
    if (!this.state.repository || !this.state.worktreePath) {
      return {
        success: false,
        error: "リポジトリが設定されていません",
      };
    }

    // リポジトリのPATを取得
    let ghToken: string | undefined;
    if (this.state.repository.fullName) {
      const patInfo = await this.workspaceManager.loadRepositoryPat(
        this.state.repository.fullName,
      );
      if (patInfo) {
        ghToken = patInfo.token;
        this.logVerbose("GitHub PAT取得", {
          repository: this.state.repository.fullName,
          hasToken: true,
        });
      }
    }

    const { startDevcontainer } = await import("../devcontainer.ts");
    const result = await startDevcontainer(
      this.state.worktreePath,
      onProgress,
      ghToken,
    );

    if (result.isOk()) {
      this.state.devcontainerConfig.isStarted = true;
      this.state.devcontainerConfig.containerId = result.value.containerId;

      // DevcontainerCodexExecutorに切り替え
      if (
        this.state.devcontainerConfig.useDevcontainer && this.state.worktreePath
      ) {
        this.logVerbose(
          "DevcontainerCodexExecutorに切り替え（startDevcontainer成功後）",
        );
        this.codexExecutor = new DevcontainerCodexExecutor(
          this.state.worktreePath,
          this.configuration.isVerbose(),
          ghToken,
        );
      }

      // Worker状態を保存
      const saveResult = await this.save();
      if (saveResult.isErr()) {
        const errorType = saveResult.error.type;
        const errorDetail = errorType === "WORKSPACE_ERROR"
          ? saveResult.error.error
          : errorType;
        return {
          success: false,
          error: `Worker状態の保存に失敗: ${errorDetail}`,
        };
      }

      return {
        success: true,
        containerId: result.value.containerId,
      };
    } else {
      const errorMessage = result.error.type === "CONTAINER_START_FAILED"
        ? result.error.error
        : `Devcontainer error: ${result.error.type}`;
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * fallback devcontainer起動後にCodexExecutorを更新する
   */
  async updateCodexExecutorForDevcontainer(): Promise<void> {
    if (
      !this.state.devcontainerConfig.useDevcontainer || !this.state.worktreePath
    ) {
      this.logVerbose("DevcontainerCodexExecutor切り替えスキップ", {
        useDevcontainer: this.state.devcontainerConfig.useDevcontainer,
        hasWorktreePath: !!this.state.worktreePath,
      });
      return;
    }

    // リポジトリのPATを取得
    let ghToken: string | undefined;
    if (this.state.repository?.fullName) {
      const patInfo = await this.workspaceManager.loadRepositoryPat(
        this.state.repository.fullName,
      );
      if (patInfo) {
        ghToken = patInfo.token;
        this.logVerbose(
          "GitHub PAT取得（updateCodexExecutorForDevcontainer）",
          {
            repository: this.state.repository.fullName,
            hasToken: true,
          },
        );
      }
    }

    this.logVerbose(
      "DevcontainerCodexExecutorに切り替え（fallback devcontainer起動後）",
    );
    const { DevcontainerCodexExecutor } = await import("./codex-executor.ts");
    this.codexExecutor = new DevcontainerCodexExecutor(
      this.state.worktreePath,
      this.configuration.isVerbose(),
      ghToken,
    );

    // devcontainerが起動済みとしてマーク
    this.state.devcontainerConfig.isStarted = true;

    // Worker状態を保存
    await this.save();
  }

  /**
   * Worker状態を永続化する
   */
  async save(): Promise<Result<void, WorkerError>> {
    if (!this.state.threadId) {
      this.logVerbose("Worker状態保存スキップ: threadId未設定");
      return ok(undefined);
    }

    try {
      this.state.lastActiveAt = new Date().toISOString();
      await this.workspaceManager.saveWorkerState(this.state);
      this.logVerbose("Worker状態を永続化", {
        threadId: this.state.threadId,
        workerName: this.state.workerName,
      });
      return ok(undefined);
    } catch (error) {
      console.error("Worker状態の保存に失敗しました:", error);
      return err({
        type: "WORKSPACE_ERROR",
        operation: "saveWorkerState",
        error: (error as Error).message,
      });
    }
  }

  /**
   * Codex Code実行を中断する
   */
  async stopExecution(
    onProgress?: (content: string) => Promise<void>,
  ): Promise<boolean> {
    // 実行中でない場合は早期リターン
    if (!this.isExecuting) {
      this.logVerbose("実行中ではないため中断スキップ", {
        isExecuting: this.isExecuting,
      });
      return false;
    }

    // プロセスハンドルがない場合も早期リターン
    if (!this.codexProcess) {
      this.logVerbose("プロセスハンドルがないため中断スキップ", {
        hasCodexProcess: false,
      });
      return false;
    }

    this.logVerbose("Codex Code実行の中断開始", {
      workerName: this.state.workerName,
      sessionId: this.state.sessionId,
    });

    // 中断イベントをセッションログに記録
    const executionTime = this.executionStartTime
      ? Date.now() - this.executionStartTime
      : undefined;

    if (
      this.state.repository?.fullName &&
      this.state.sessionId
    ) {
      await this.sessionLogger.saveInterruptionEvent(
        this.state.repository.fullName,
        this.state.sessionId,
        {
          reason: "user_requested",
          executionTime,
          lastActivity: this.lastActivityDescription || undefined,
        },
      );
    }

    try {
      // まずAbortControllerで中断シグナルを送信
      if (this.abortController) {
        this.abortController.abort();
        this.logVerbose("AbortController.abort()実行");
      }

      // プロセスにSIGTERMを送信
      const processToKill = this.codexProcess; // プロセス参照を保持
      let sigTermSent = false;

      try {
        processToKill.kill("SIGTERM");
        sigTermSent = true;
        this.logVerbose("SIGTERMシグナル送信");
      } catch (error) {
        this.logVerbose(
          "SIGTERM送信エラー（プロセスが既に終了している可能性）",
          {
            error: (error as Error).message,
          },
        );
      }

      // 5秒待機してプロセスが終了するか確認
      let forcefullyKilled = false;
      let timeoutId: number | undefined;

      if (sigTermSent) {
        timeoutId = setTimeout(() => {
          // プロセスがまだ存在する場合のみSIGKILLを送信
          if (this.codexProcess === processToKill) {
            try {
              processToKill.kill("SIGKILL");
              forcefullyKilled = true;
              this.logVerbose("SIGKILLシグナル送信（強制終了）");
            } catch (error) {
              this.logVerbose("SIGKILL送信エラー", {
                error: (error as Error).message,
              });
            }
          }
        }, PROCESS.TERMINATION_TIMEOUT_MS);

        // プロセスの終了を待機
        try {
          await processToKill.status;
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          this.logVerbose("プロセス終了確認");
        } catch (error) {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
          }
          this.logVerbose("プロセス終了待機エラー", {
            error: (error as Error).message,
          });
        }
      }

      // 中断メッセージを送信
      if (onProgress) {
        if (forcefullyKilled) {
          await onProgress("⚠️ Codex Codeの実行を強制終了しました");
        } else {
          await onProgress("⛔ Codex Codeの実行を中断しました");
        }
        await onProgress("💡 新しい指示を送信して作業を続けることができます");
      }

      return true;
    } catch (error) {
      this.logVerbose("中断処理エラー", {
        error: (error as Error).message,
      });

      // エラーメッセージを送信
      if (onProgress) {
        const errorMessage = error instanceof Error
          ? error.message
          : "不明なエラー";
        await onProgress(
          `❌ 中断処理中にエラーが発生しました: ${errorMessage}`,
        );
        await onProgress("💡 新しい指示を送信して作業を続けることができます");
      }

      return false;
    } finally {
      // クリーンアップ
      this.codexProcess = null;
      this.abortController = null;
      this.isExecuting = false;
      this.logVerbose("プロセス参照クリーンアップ完了");
    }
  }

  /**
   * Worker状態を復元する（静的メソッド）
   */
  static async fromState(
    workerState: WorkerState,
    workspaceManager: WorkspaceManager,
    verbose?: boolean,
    appendSystemPrompt?: string,
    translatorUrl?: string,
    rateLimitManager?: RateLimitManager,
  ): Promise<Worker> {
    const worker = new Worker(
      workerState,
      workspaceManager,
      undefined,
      verbose,
      appendSystemPrompt,
      translatorUrl,
      rateLimitManager,
    );

    // devcontainerが使用されている場合はExecutorを切り替え
    if (
      workerState.devcontainerConfig.useDevcontainer &&
      workerState.worktreePath &&
      workerState.devcontainerConfig.isStarted
    ) {
      // リポジトリのPATを取得
      let ghToken: string | undefined;
      if (workerState.repository?.fullName) {
        const patInfo = await workspaceManager.loadRepositoryPat(
          workerState.repository.fullName,
        );
        if (patInfo) {
          ghToken = patInfo.token;
        }
      }

      worker.codexExecutor = new DevcontainerCodexExecutor(
        workerState.worktreePath,
        verbose || false,
        ghToken,
      );
    }

    return worker;
  }

  /**
   * コンテキスト圧縮の必要性をチェックし、必要であれば圧縮を実行
   */
  private async checkAndCompressContext(): Promise<void> {
    if (!this.state.sessionId || !this.state.repository?.fullName) {
      return;
    }

    try {
      // 現在のセッションファイルの内容を取得
      const sessionContent = await this.getCurrentSessionContent();
      if (!sessionContent) {
        return;
      }

      // 圧縮が必要かチェック
      if (this.contextCompressor.shouldCompress(sessionContent)) {
        this.logVerbose("コンテキスト圧縮を開始", {
          sessionId: this.state.sessionId,
          repository: this.state.repository.fullName,
        });

        // コンテキストを圧縮
        const compressionResult = await this.contextCompressor.compressSession(
          sessionContent,
        );

        if (compressionResult.wasCompressed) {
          // 圧縮されたコンテンツでセッションファイルを更新
          await this.updateSessionFile(compressionResult.compressedContent);

          this.logVerbose("コンテキスト圧縮完了", {
            sessionId: this.state.sessionId,
            originalTokens: compressionResult.originalTokens,
            compressedTokens: compressionResult.compressedTokens,
            compressionRatio: compressionResult.compressionRatio,
          });
        }
      }
    } catch (error) {
      console.error("コンテキスト圧縮中にエラーが発生:", error);
      // 圧縮失敗は運用を阻害しない（そのまま継続）
    }
  }

  /**
   * 現在のセッションファイルの内容を取得
   */
  private async getCurrentSessionContent(): Promise<string | null> {
    if (!this.state.sessionId || !this.state.repository?.fullName) {
      return null;
    }

    try {
      const sessionManager = this.workspaceManager.getSessionManager();
      const sessionFilePath = await sessionManager.getRawSessionFilePath(
        this.state.repository.fullName,
        this.state.sessionId,
      );

      if (!sessionFilePath) {
        return null;
      }

      return await Deno.readTextFile(sessionFilePath);
    } catch (error) {
      console.error("セッションファイル読み取りエラー:", error);
      return null;
    }
  }

  /**
   * セッションファイルを更新
   */
  private async updateSessionFile(compressedContent: string): Promise<void> {
    if (!this.state.sessionId || !this.state.repository?.fullName) {
      return;
    }

    try {
      const sessionManager = this.workspaceManager.getSessionManager();
      const sessionFilePath = await sessionManager.getRawSessionFilePath(
        this.state.repository.fullName,
        this.state.sessionId,
      );

      if (!sessionFilePath) {
        return;
      }

      await Deno.writeTextFile(sessionFilePath, compressedContent);
    } catch (error) {
      console.error("セッションファイル更新エラー:", error);
    }
  }
}
