import { err, ok, Result } from "neverthrow";

export interface Env {
  DISCORD_TOKEN: string;
  WORK_BASE_DIR: string;
  CODEX_APPEND_SYSTEM_PROMPT?: string;
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
  const codexAppendSystemPrompt = Deno.env.get("CODEX_APPEND_SYSTEM_PROMPT");

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
    CODEX_APPEND_SYSTEM_PROMPT: codexAppendSystemPrompt,
  });
}
