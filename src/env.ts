import { err, ok, Result } from "neverthrow";

export interface Env {
  DISCORD_TOKEN: string;
  WORK_BASE_DIR: string;
  VERBOSE: boolean;
  CODEX_APPEND_SYSTEM_PROMPT?: string;
  GEMINI_API_KEY?: string;
  CODEX_LIMIT_5H_TOKENS?: number;
  CODEX_LIMIT_1W_TOKENS?: number;
  /**
   * PLaMo-2-translate API URL（オプション）
   * 設定されている場合、日本語の指示を英語に翻訳してからCodex Codeに渡す
   * 例: http://localhost:8080
   */
  PLAMO_TRANSLATOR_URL?: string;
}

/**
 * 環境変数関連のエラー
 */
export type EnvError = {
  type: "MISSING_ENV_VAR";
  variable: string;
  message: string;
};

export function getEnv(): Result<Env, EnvError> {
  const token = Deno.env.get("DISCORD_TOKEN");
  const workBaseDir = Deno.env.get("WORK_BASE_DIR");
  const verbose = Deno.env.get("VERBOSE") === "true";
  const codexAppendSystemPrompt = Deno.env.get("CODEX_APPEND_SYSTEM_PROMPT");
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const plamoTranslatorUrl = Deno.env.get("PLAMO_TRANSLATOR_URL");
  const fiveHourLimit = parseIntegerEnv("CODEX_LIMIT_5H_TOKENS");
  const weeklyLimit = parseIntegerEnv("CODEX_LIMIT_1W_TOKENS");

  if (!token) {
    return err({
      type: "MISSING_ENV_VAR",
      variable: "DISCORD_TOKEN",
      message: "DISCORD_TOKEN is not set",
    });
  }

  if (!workBaseDir) {
    return err({
      type: "MISSING_ENV_VAR",
      variable: "WORK_BASE_DIR",
      message: "WORK_BASE_DIR is not set",
    });
  }

  return ok({
    DISCORD_TOKEN: token,
    WORK_BASE_DIR: workBaseDir,
    VERBOSE: verbose,
    CODEX_APPEND_SYSTEM_PROMPT: codexAppendSystemPrompt,
    GEMINI_API_KEY: geminiApiKey,
    CODEX_LIMIT_5H_TOKENS: fiveHourLimit,
    CODEX_LIMIT_1W_TOKENS: weeklyLimit,
    PLAMO_TRANSLATOR_URL: plamoTranslatorUrl,
  });
}

function parseIntegerEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
