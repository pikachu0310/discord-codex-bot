import { err, ok, Result } from "npm:neverthrow@8.1.1";
import { exec } from "./utils/exec.ts";

// エラー型の定義
export type SystemCheckError = {
  type: "COMMAND_NOT_FOUND";
  command: string;
  error: string;
} | {
  type: "VERSION_CHECK_FAILED";
  command: string;
  error: string;
} | {
  type: "REQUIRED_COMMAND_MISSING";
  missingCommands: string[];
} | {
  type: "UNEXPECTED_ERROR";
  message: string;
};

export interface SystemRequirement {
  command: string;
  description: string;
  required: boolean;
}

export interface CommandStatus {
  command: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface SystemCheckResult {
  success: boolean;
  results: CommandStatus[];
  missingRequired: string[];
}

const REQUIRED_COMMANDS: SystemRequirement[] = [
  {
    command: "git",
    description: "Git version control system",
    required: true,
  },
  {
    command: "codex",
    description: "Codex CLI tool",
    required: true,
  },
];

const OPTIONAL_COMMANDS: SystemRequirement[] = [
  {
    command: "gh",
    description: "GitHub CLI (recommended for enhanced repository management)",
    required: false,
  },
  {
    command: "devcontainer",
    description: "Dev Container CLI (for development container support)",
    required: false,
  },
];

export async function checkSystemRequirements(): Promise<
  Result<SystemCheckResult, SystemCheckError>
> {
  const results: CommandStatus[] = [];
  const missingRequired: string[] = [];

  // 必須コマンドのチェック
  for (const requirement of REQUIRED_COMMANDS) {
    const commandResult = await checkCommand(requirement.command);

    if (commandResult.isErr()) {
      // エラーが発生した場合でも、利用不可として記録する
      const errorMessage = commandResult.error.type === "COMMAND_NOT_FOUND" ||
          commandResult.error.type === "VERSION_CHECK_FAILED"
        ? commandResult.error.error
        : "Unknown error";
      const status: CommandStatus = {
        command: requirement.command,
        available: false,
        error: errorMessage,
      };
      results.push(status);
      missingRequired.push(requirement.command);
    } else {
      const status = commandResult.value;
      results.push(status);

      if (!status.available) {
        missingRequired.push(requirement.command);
      }
    }
  }

  // オプションコマンドのチェック
  for (const requirement of OPTIONAL_COMMANDS) {
    const commandResult = await checkCommand(requirement.command);

    if (commandResult.isErr()) {
      // オプションコマンドのエラーは無視し、利用不可として記録
      const errorMessage = commandResult.error.type === "COMMAND_NOT_FOUND" ||
          commandResult.error.type === "VERSION_CHECK_FAILED"
        ? commandResult.error.error
        : "Unknown error";
      const status: CommandStatus = {
        command: requirement.command,
        available: false,
        error: errorMessage,
      };
      results.push(status);
    } else {
      results.push(commandResult.value);
    }
  }

  // 必須コマンドが不足している場合はエラーを返す
  if (missingRequired.length > 0) {
    return err({
      type: "REQUIRED_COMMAND_MISSING",
      missingCommands: missingRequired,
    });
  }

  return ok({
    success: true,
    results,
    missingRequired,
  });
}

async function checkCommand(
  command: string,
): Promise<Result<CommandStatus, SystemCheckError>> {
  const result = await exec(`${command} --version`);

  if (result.isOk()) {
    return ok({
      command,
      available: true,
      version: result.value.output.trim(),
    });
  } else {
    // コマンドが実行できなかった場合
    if (result.error.type === "EXECUTION_ERROR") {
      return ok({
        command,
        available: false,
        error: result.error.message,
      });
    }
    // コマンドが失敗した場合
    return ok({
      command,
      available: false,
      error: result.error.error || result.error.message,
    });
  }
}

export function formatSystemCheckResults(
  results: CommandStatus[],
  missingRequired: string[],
): string {
  const lines: string[] = [];

  lines.push("システム要件チェック結果:");
  lines.push("");

  // 必須コマンド
  lines.push("【必須コマンド】");
  for (const requirement of REQUIRED_COMMANDS) {
    const result = results.find((r) => r.command === requirement.command);
    if (result) {
      const status = result.available ? "✅" : "❌";
      const versionInfo = result.version ? ` (${result.version})` : "";
      lines.push(`  ${status} ${requirement.command}${versionInfo}`);
      if (!result.available && result.error) {
        lines.push(`      エラー: ${result.error}`);
      }
    }
  }

  lines.push("");

  // オプションコマンド
  lines.push("【推奨コマンド】");
  for (const requirement of OPTIONAL_COMMANDS) {
    const result = results.find((r) => r.command === requirement.command);
    if (result) {
      const status = result.available ? "✅" : "⚠️";
      const versionInfo = result.version ? ` (${result.version})` : "";
      lines.push(`  ${status} ${requirement.command}${versionInfo}`);
      if (!result.available) {
        lines.push(`      ${requirement.description}`);
      }
    }
  }

  if (missingRequired.length > 0) {
    lines.push("");
    lines.push("❌ 以下の必須コマンドが見つかりません:");
    for (const command of missingRequired) {
      const requirement = REQUIRED_COMMANDS.find((r) => r.command === command);
      lines.push(`   - ${command}: ${requirement?.description}`);
    }
    lines.push("");
    lines.push("インストール方法:");
    lines.push("  - Git: https://git-scm.com/downloads");
    lines.push(
      "  - Codex CLI: https://docs.anthropic.com/en/docs/codex-code",
    );
  }

  return lines.join("\n");
}
