import { err, ok, Result } from "neverthrow";
import { CODEX } from "./constants.ts";

export interface Env {
  DISCORD_TOKEN: string;
  WORK_BASE_DIR: string;
  VERBOSE: boolean;
  CODEX_APPEND_SYSTEM_PROMPT?: string;
  CODEX_STATUS_LIMIT_TOKENS: number;
  CODEX_LIMIT_5H_TOKENS?: number;
  CODEX_LIMIT_1W_TOKENS?: number;
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
  const statusLimit = parseIntegerEnv("CODEX_STATUS_LIMIT_TOKENS") ??
    CODEX.STATUS_USAGE_BASE_TOKENS;
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
    CODEX_STATUS_LIMIT_TOKENS: statusLimit,
    CODEX_LIMIT_5H_TOKENS: fiveHourLimit,
    CODEX_LIMIT_1W_TOKENS: weeklyLimit,
  });
}

function parseIntegerEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
