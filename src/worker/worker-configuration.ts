import { CODEX_CLI } from "../constants.ts";
import {
  supportsExecColorFlag,
  supportsExecJsonMode,
  supportsDangerouslyBypassFlag,
  supportsSearchFlag,
  supportsLegacyOutputFormatFlag,
  shouldUseVerboseFlag,
  shouldUseDangerouslySkipPermissionsFlag,
} from "./codex-cli-capabilities.ts";

/**
 * Workerの設定管理を担当するクラス
 */
export class WorkerConfiguration {
  private verbose: boolean;
  private appendSystemPrompt?: string;
  private translatorUrl?: string;
  private dangerouslySkipPermissions: boolean;
  private maxOutputTokens: number;
  private useExecJsonMode: boolean;
  private useExecColorFlag: boolean;
  private useDangerouslyBypassFlag: boolean;
  private useOutputFormatFlag: boolean;
  private useCliVerboseFlag: boolean;
  private useDangerouslySkipPermissionsFlag: boolean;
  private useSearchFlag: boolean;

  constructor(
    verbose = false,
    appendSystemPrompt?: string,
    translatorUrl?: string,
    dangerouslySkipPermissions = true, // デフォルトはtrue（既存の動作を維持）
    maxOutputTokens?: number,
  ) {
    this.verbose = verbose;
    this.appendSystemPrompt = appendSystemPrompt;
    this.translatorUrl = translatorUrl;
    this.dangerouslySkipPermissions = dangerouslySkipPermissions;
    this.useExecJsonMode = supportsExecJsonMode();
    this.useExecColorFlag = this.useExecJsonMode && supportsExecColorFlag();
    this.useDangerouslyBypassFlag = this.dangerouslySkipPermissions &&
      this.useExecJsonMode && supportsDangerouslyBypassFlag();
    this.useSearchFlag = supportsSearchFlag();
    this.useOutputFormatFlag = !this.useExecJsonMode &&
      supportsLegacyOutputFormatFlag();
    this.useCliVerboseFlag = shouldUseVerboseFlag();
    this.useDangerouslySkipPermissionsFlag = this.dangerouslySkipPermissions &&
      (!this.useExecJsonMode || !this.useDangerouslyBypassFlag) &&
      shouldUseDangerouslySkipPermissionsFlag();

    // 環境変数からトークン制限を取得、未設定の場合はデフォルト値を使用
    this.maxOutputTokens = maxOutputTokens ||
      this.getMaxOutputTokensFromEnv() ||
      CODEX_CLI.DEFAULT_MAX_OUTPUT_TOKENS;
  }

  /**
   * verboseモードを設定する
   */
  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  /**
   * verboseモードが有効かを取得
   */
  isVerbose(): boolean {
    return this.verbose;
  }

  /**
   * 追加システムプロンプトを取得
   */
  getAppendSystemPrompt(): string | undefined {
    return this.appendSystemPrompt;
  }

  /**
   * 翻訳URLを取得
   */
  getTranslatorUrl(): string | undefined {
    return this.translatorUrl;
  }

  /**
   * exec --jsonモードを使用するか
   */
  shouldUseExecJsonMode(): boolean {
    return this.useExecJsonMode;
  }

  /**
   * exec --jsonモードを無効化してレガシーモードへフォールバック
   */
  disableExecJsonMode(): void {
    this.useExecJsonMode = false;
    this.useExecColorFlag = false;
    this.useDangerouslyBypassFlag = false;
    this.useOutputFormatFlag = supportsLegacyOutputFormatFlag();
    this.useDangerouslySkipPermissionsFlag = this.dangerouslySkipPermissions &&
      shouldUseDangerouslySkipPermissionsFlag();
  }

  /**
   * execモードでの--colorフラグを無効化
   */
  disableExecColorFlag(): void {
    this.useExecColorFlag = false;
  }

  /**
   * execモードでの危険フラグを無効化し、可能であれば旧フラグにフォールバック
   */
  disableDangerouslyBypassFlag(): void {
    this.useDangerouslyBypassFlag = false;
    if (this.dangerouslySkipPermissions) {
      this.useDangerouslySkipPermissionsFlag = shouldUseDangerouslySkipPermissionsFlag();
    }
  }

  /**
   * 権限チェックスキップ設定を設定する
   */
  setDangerouslySkipPermissions(skipPermissions: boolean): void {
    this.dangerouslySkipPermissions = skipPermissions;
    if (skipPermissions) {
      this.useDangerouslyBypassFlag = this.useExecJsonMode &&
        supportsDangerouslyBypassFlag();
      if (this.useDangerouslyBypassFlag) {
        this.useDangerouslySkipPermissionsFlag = false;
      } else {
        this.useDangerouslySkipPermissionsFlag = shouldUseDangerouslySkipPermissionsFlag();
      }
    } else {
      this.useDangerouslyBypassFlag = false;
      this.useDangerouslySkipPermissionsFlag = false;
    }
  }

  /**
   * 権限チェックスキップ設定を取得
   */
  getDangerouslySkipPermissions(): boolean {
    return this.dangerouslySkipPermissions;
  }

  /**
   * 環境変数から最大出力トークン数を取得
   */
  private getMaxOutputTokensFromEnv(): number | null {
    const envValue = Deno.env.get("CODEX_CODE_MAX_OUTPUT_TOKENS");
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  /**
   * 最大出力トークン数を設定
   */
  setMaxOutputTokens(tokens: number): void {
    if (tokens > 0) {
      this.maxOutputTokens = tokens;
    }
  }

  /**
   * 最大出力トークン数を取得
   */
  getMaxOutputTokens(): number {
    return this.maxOutputTokens;
  }

  /**
   * Codexコマンドの引数を構築
   */
  buildCodexArgs(prompt: string, sessionId?: string | null): string[] {
    const args: string[] = [];

    if (this.useSearchFlag) {
      args.push("--search");
    }

    if (this.useExecJsonMode) {
      args.push("exec");
      args.push("--json");
      if (this.useExecColorFlag) {
        args.push("--color", "never");
      }

      if (this.verbose && this.useCliVerboseFlag) {
        args.push("--verbose");
      }

      if (this.dangerouslySkipPermissions) {
        if (this.useDangerouslyBypassFlag) {
          args.push("--dangerously-bypass-approvals-and-sandbox");
        } else if (this.useDangerouslySkipPermissionsFlag) {
          args.push("--dangerously-skip-permissions");
        }
      }

      if (this.appendSystemPrompt) {
        args.push("--append-system-prompt", this.appendSystemPrompt);
      }

      if (sessionId) {
        args.push("resume");
        args.push(sessionId);
      }

      args.push(prompt);
      return args;
    }

    if (this.useOutputFormatFlag) {
      args.push("--output-format", "stream-json");
    }

    if (this.verbose && this.useCliVerboseFlag) {
      args.push("--verbose");
    }

    if (sessionId) {
      args.push("--continue");
    }

    if (this.dangerouslySkipPermissions && this.useDangerouslySkipPermissionsFlag) {
      args.push("--dangerously-skip-permissions");
    }

    if (this.appendSystemPrompt) {
      args.push("--append-system-prompt", this.appendSystemPrompt);
    }

    args.push(prompt);
    return args;
  }

  /**
   * Codex CLIが--output-formatをサポートしない場合にフラグを無効化
   */
  disableOutputFormatFlag(): void {
    this.useOutputFormatFlag = false;
  }

  /**
   * --output-formatフラグを使用するかどうか
   */
  shouldUseOutputFormat(): boolean {
    return this.useOutputFormatFlag;
  }

  /**
   * Codex CLIの--verboseフラグを使用するかどうか
   */
  shouldUseCliVerboseFlag(): boolean {
    return this.useCliVerboseFlag;
  }

  /**
   * Codex CLIの--dangerously-skip-permissionsフラグを使用するかどうか
   */
  shouldUseDangerouslySkipPermissionsFlag(): boolean {
    return this.useDangerouslySkipPermissionsFlag;
  }

  /**
   * Codex CLIが--verboseをサポートしない場合にフラグを無効化
   */
  disableVerboseFlag(): void {
    this.useCliVerboseFlag = false;
  }

  /**
   * Codex CLIが--dangerously-skip-permissionsをサポートしない場合にフラグを無効化
   */
  disableDangerouslySkipPermissionsFlag(): void {
    this.useDangerouslySkipPermissionsFlag = false;
  }

  disableSearchFlag(): void {
    this.useSearchFlag = false;
  }

  /**
   * Codex CLIの実行に必要な環境変数を構築
   */
  buildCodexEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // 最大出力トークン数を環境変数として設定
    env.CODEX_CODE_MAX_OUTPUT_TOKENS = this.maxOutputTokens.toString();

    return env;
  }

  /**
   * verboseログを出力する
   */
  logVerbose(
    workerName: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.verbose) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [Worker:${workerName}] ${message}`;
      console.log(logMessage);

      if (metadata && Object.keys(metadata).length > 0) {
        console.log(
          `[${timestamp}] [Worker:${workerName}] メタデータ:`,
          metadata,
        );
      }
    }
  }
}
