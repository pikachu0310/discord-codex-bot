import { assertEquals } from "std/assert/mod.ts";
import {
  checkSystemRequirements,
  formatSystemCheckResults,
} from "./system-check.ts";

Deno.test("システム要件チェック機能", async (t) => {
  await t.step("必要なコマンドの存在確認", async () => {
    const result = await checkSystemRequirements();

    // Result型であることを確認
    assertEquals(typeof result.isOk, "function");
    assertEquals(typeof result.isErr, "function");

    if (result.isOk()) {
      // 成功時の結果の基本構造を確認
      const value = result.value;
      assertEquals(typeof value.success, "boolean");
      assertEquals(Array.isArray(value.results), true);
      assertEquals(Array.isArray(value.missingRequired), true);

      // gitコマンドの結果を確認
      const gitResult = value.results.find((r) => r.command === "git");
      assertEquals(gitResult?.command, "git");
      assertEquals(typeof gitResult?.available, "boolean");

      // codexコマンドの結果を確認
      const codexResult = value.results.find((r) => r.command === "codex");
      assertEquals(codexResult?.command, "codex");
      assertEquals(typeof codexResult?.available, "boolean");

      // ghコマンドの結果を確認（推奨コマンド）
      const ghResult = value.results.find((r) => r.command === "gh");
      assertEquals(ghResult?.command, "gh");
      assertEquals(typeof ghResult?.available, "boolean");

      // devcontainerコマンドの結果を確認（推奨コマンド）
      const devcontainerResult = value.results.find((r) =>
        r.command === "devcontainer"
      );
      assertEquals(devcontainerResult?.command, "devcontainer");
      assertEquals(typeof devcontainerResult?.available, "boolean");
    } else {
      // エラー時の処理
      const error = result.error;
      assertEquals(error.type, "REQUIRED_COMMAND_MISSING");
      if (error.type === "REQUIRED_COMMAND_MISSING") {
        assertEquals(Array.isArray(error.missingCommands), true);
      }
    }
  });

  await t.step("結果のフォーマット機能", () => {
    const mockResults = [
      {
        command: "git",
        available: true,
        version: "git version 2.39.0",
      },
      {
        command: "codex",
        available: false,
        error: "command not found",
      },
      {
        command: "gh",
        available: true,
        version: "gh version 2.40.0",
      },
      {
        command: "devcontainer",
        available: false,
        error: "command not found",
      },
    ];

    const missingRequired = ["codex"];
    const formatted = formatSystemCheckResults(mockResults, missingRequired);

    // フォーマットされた結果の基本チェック
    assertEquals(typeof formatted, "string");
    assertEquals(formatted.includes("システム要件チェック結果"), true);
    assertEquals(formatted.includes("【必須コマンド】"), true);
    assertEquals(formatted.includes("【推奨コマンド】"), true);
    assertEquals(formatted.includes("✅ git"), true);
    assertEquals(formatted.includes("❌ codex"), true);
    assertEquals(formatted.includes("✅ gh"), true);
    assertEquals(formatted.includes("⚠️ devcontainer"), true);
    assertEquals(
      formatted.includes("❌ 以下の必須コマンドが見つかりません"),
      true,
    );
  });

  await t.step("全てのコマンドが利用可能な場合", () => {
    const mockResults = [
      {
        command: "git",
        available: true,
        version: "git version 2.39.0",
      },
      {
        command: "codex",
        available: true,
        version: "codex version 1.0.0",
      },
      {
        command: "gh",
        available: true,
        version: "gh version 2.40.0",
      },
      {
        command: "devcontainer",
        available: true,
        version: "devcontainer version 0.362.0",
      },
    ];

    const missingRequired: string[] = [];
    const formatted = formatSystemCheckResults(mockResults, missingRequired);

    // エラーメッセージが含まれないことを確認
    assertEquals(
      formatted.includes("❌ 以下の必須コマンドが見つかりません"),
      false,
    );
    assertEquals(formatted.includes("インストール方法"), false);
  });
});
