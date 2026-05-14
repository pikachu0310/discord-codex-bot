import { err, ok, Result } from "neverthrow";

export interface Env {
  DISCORD_TOKEN: string;
  WORK_BASE_DIR: string;
  CODEX_APPEND_SYSTEM_PROMPT?: string;
  CODEX_STATUS_TIME_ZONE?: string;
}

/**
 * 環境変数関連のエラー
 */
export type EnvError = {
  type: "MISSING_ENV_VAR";
  variable: string;
  message: string;
};

function expandHomeDirectory(path: string): Result<string, EnvError> {
  if (path !== "~" && !path.startsWith("~/")) {
    return ok(path);
  }

  const home = Deno.env.get("HOME");
  if (!home) {
    return err({
      type: "MISSING_ENV_VAR",
      variable: "HOME",
      message: "HOME is not set; cannot expand WORK_BASE_DIR",
    });
  }

  return ok(path === "~" ? home : `${home}${path.slice(1)}`);
}

export function getEnv(): Result<Env, EnvError> {
  const token = Deno.env.get("DISCORD_TOKEN");
  const workBaseDir = Deno.env.get("WORK_BASE_DIR");
  const codexAppendSystemPrompt = Deno.env.get("CODEX_APPEND_SYSTEM_PROMPT");
  const codexStatusTimeZone = Deno.env.get("CODEX_STATUS_TIME_ZONE");

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

  const expandedWorkBaseDir = expandHomeDirectory(workBaseDir);
  if (expandedWorkBaseDir.isErr()) {
    return err(expandedWorkBaseDir.error);
  }

  return ok({
    DISCORD_TOKEN: token,
    WORK_BASE_DIR: expandedWorkBaseDir.value,
    CODEX_APPEND_SYSTEM_PROMPT: codexAppendSystemPrompt,
    CODEX_STATUS_TIME_ZONE: codexStatusTimeZone,
  });
}
