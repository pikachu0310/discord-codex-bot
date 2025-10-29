import { CodexStreamProcessor } from "./codex-stream-processor.ts";
import { MessageFormatter } from "./message-formatter.ts";
import { err, ok, Result } from "neverthrow";
import type { CodexExecutorError } from "./types.ts";

export interface CodexCommandExecutor {
  /**
   * Codex CLIをストリーミングモードで実行する
   * @param args Codex CLIに渡すコマンドライン引数
   * @param cwd 作業ディレクトリ
   * @param onData 標準出力データを受信したときのコールバック
   * @param abortSignal プロセスを中断するためのシグナル
   * @param onProcessStart プロセスが正常に生成された場合のみ呼ばれるコールバック。プロセス生成に失敗した場合は呼ばれない
   * @param env Codex CLIに渡す追加の環境変数
   * @returns 実行結果（終了コードと標準エラー出力）またはエラー
   */
  executeStreaming(
    args: string[],
    cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    env?: Record<string, string>,
    options?: { usePty?: boolean },
  ): Promise<Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>>;
}

export class DefaultCodexCommandExecutor implements CodexCommandExecutor {
  private readonly verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  async executeStreaming(
    args: string[],
    cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    env?: Record<string, string>,
    options?: { usePty?: boolean },
  ): Promise<
    Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>
  > {
    // VERBOSEモードでコマンド詳細ログ
    if (this.verbose) {
      console.log(
        `[${
          new Date().toISOString()
        }] [DefaultCodexCommandExecutor] Codexコマンド実行:`,
      );
      console.log(`  作業ディレクトリ: ${cwd}`);
      console.log(`  引数: ${JSON.stringify(args)}`);
      if (env && Object.keys(env).length > 0) {
        console.log(`  追加環境変数: ${JSON.stringify(env)}`);
      }
    }

    try {
      // 現在の環境変数に追加の環境変数をマージ
      const commandEnv = env ? { ...Deno.env.toObject(), ...env } : undefined;

      const binary = options?.usePty ? "script" : "codex";
      const commandArgs = options?.usePty
        ? ["-q", "/dev/null", "codex", ...args]
        : args;

      if (this.verbose) {
        const timestamp = new Date().toISOString();
        console.log(
          `[${timestamp}] [DefaultCodexCommandExecutor] 実行モード: ${options?.usePty ? "pty" : "standard"}`,
        );
        if (options?.usePty) {
          console.log(
            `[${timestamp}] [DefaultCodexCommandExecutor] 擬似TTYコマンド引数: ${JSON.stringify(commandArgs)}`,
          );
        }
      }

      const command = new Deno.Command(binary, {
        args: commandArgs,
        cwd,
        stdout: "piped",
        stderr: "piped",
        signal: abortSignal,
        env: commandEnv,
      });

      const process = command.spawn();

      // プロセス開始コールバック
      onProcessStart?.(process);

      // CodexStreamProcessorのprocessStreamsメソッドを使用
      const processor = new CodexStreamProcessor(
        new MessageFormatter(), // formatterインスタンスを渡す
      );

      // プロセスの終了を待つ
      const [{ code }, stderrOutput] = await Promise.all([
        process.status,
        processor.processStreams(process.stdout, process.stderr, onData),
      ]);

      // VERBOSEモードで実行結果詳細ログ
      if (this.verbose) {
        console.log(
          `[${
            new Date().toISOString()
          }] [DefaultCodexCommandExecutor] 実行完了:`,
        );
        console.log(`  終了コード: ${code}`);
        console.log(`  stderr長: ${stderrOutput.length}バイト`);
      }

      return ok({ code, stderr: stderrOutput });
    } catch (error) {
      // AbortErrorの場合は特別な処理
      if (error instanceof Error && error.name === "AbortError") {
        return err({
          type: "STREAM_PROCESSING_ERROR",
          error: "実行が中断されました",
        });
      }
      if (options?.usePty && error instanceof Deno.errors.NotFound) {
        return err({
          type: "STREAM_PROCESSING_ERROR",
          error:
            "'script' command not found. Install the util-linux package to enable pseudo-TTY fallback for the Codex CLI.",
        });
      }
      return err({
        type: "STREAM_PROCESSING_ERROR",
        error: (error as Error).message,
      });
    }
  }
}

export class DevcontainerCodexExecutor implements CodexCommandExecutor {
  private readonly repositoryPath: string;
  private readonly verbose: boolean;
  private readonly ghToken?: string;

  constructor(
    repositoryPath: string,
    verbose = false,
    ghToken?: string,
  ) {
    this.repositoryPath = repositoryPath;
    this.verbose = verbose;
    this.ghToken = ghToken;
  }

  async executeStreaming(
    args: string[],
    _cwd: string,
    onData: (data: Uint8Array) => void,
    abortSignal?: AbortSignal,
    onProcessStart?: (childProcess: Deno.ChildProcess) => void,
    additionalEnv?: Record<string, string>,
    options?: { usePty?: boolean },
  ): Promise<
    Result<{ code: number; stderr: Uint8Array }, CodexExecutorError>
  > {
    const argsWithDefaults = options?.usePty
      ? [
        "exec",
        "--workspace-folder",
        this.repositoryPath,
        "script",
        "-q",
        "/dev/null",
        "codex",
        ...args,
      ]
      : [
        "exec",
        "--workspace-folder",
        this.repositoryPath,
        "codex",
        ...args,
      ];
    // VERBOSEモードでdevcontainerコマンド詳細ログ
    if (this.verbose) {
      console.log(
        `[${
          new Date().toISOString()
        }] [DevcontainerCodexExecutor] devcontainerコマンド実行:`,
      );
      console.log(`  リポジトリパス: ${this.repositoryPath}`);
      console.log(`  引数: ${JSON.stringify(argsWithDefaults)}`);
      console.log(
        `  TTYモード: ${options?.usePty ? "有効 (script経由)" : "無効"}`,
      );
      if (additionalEnv && Object.keys(additionalEnv).length > 0) {
        console.log(`  追加環境変数: ${JSON.stringify(additionalEnv)}`);
      }
    }

    try {
      // devcontainer内でcodexコマンドをストリーミング実行
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        DOCKER_DEFAULT_PLATFORM: "linux/amd64",
      };

      // GitHub PATが提供されている場合は環境変数に設定
      if (this.ghToken) {
        env.GH_TOKEN = this.ghToken;
        env.GITHUB_TOKEN = this.ghToken; // 互換性のため両方設定
      }

      // 追加の環境変数をマージ
      if (additionalEnv) {
        Object.assign(env, additionalEnv);
      }

      const devcontainerCommand = new Deno.Command("devcontainer", {
        args: argsWithDefaults,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        cwd: this.repositoryPath,
        env,
        signal: abortSignal,
      });

      const process = devcontainerCommand.spawn();

      // プロセス開始コールバック
      if (onProcessStart) {
        onProcessStart(process);
      }

      // CodexStreamProcessorのprocessStreamsメソッドを使用
      const processor = new CodexStreamProcessor(
        new MessageFormatter(), // formatterインスタンスを渡す
      );

      // プロセスの終了を待つ
      const [{ code }, stderrOutput] = await Promise.all([
        process.status,
        processor.processStreams(process.stdout, process.stderr, onData),
      ]);

      // VERBOSEモードで実行結果詳細ログ
      if (this.verbose) {
        console.log(
          `[${
            new Date().toISOString()
          }] [DevcontainerCodexExecutor] 実行完了:`,
        );
        console.log(`  終了コード: ${code}`);
        console.log(`  stderr長: ${stderrOutput.length}バイト`);
      }

      return ok({ code, stderr: stderrOutput });
    } catch (error) {
      // AbortErrorの場合は特別な処理
      if (error instanceof Error && error.name === "AbortError") {
        return err({
          type: "STREAM_PROCESSING_ERROR",
          error: "実行が中断されました",
        });
      }
      return err({
        type: "STREAM_PROCESSING_ERROR",
        error: (error as Error).message,
      });
    }
  }
}
