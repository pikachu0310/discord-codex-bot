import { assertEquals } from "std/assert/mod.ts";
import {
  formatCodexUpdateError,
  formatCodexUpdateResult,
} from "../src/codex-update.ts";

Deno.test("formatCodexUpdateResult: 出力ありの成功メッセージを整形する", () => {
  assertEquals(
    formatCodexUpdateResult({
      code: 0,
      output: "updated to 0.135.0",
      version: "codex-cli 0.135.0",
    }),
    [
      "🎉 Update ran successfully! (codex-cli 0.135.0)",
      "",
      "```",
      "updated to 0.135.0",
      "```",
      "",
      "BOT は Codex を実行ごとに起動するため、再起動などは必要ないよ。",
    ].join("\n"),
  );
});

Deno.test("formatCodexUpdateResult: 成功出力は省略せず成功行だけ本文から外す", () => {
  const npmOutput = "npm output line ".repeat(160).trim();
  const output = [
    "Updating Codex via npm install -g @openai/codex...",
    npmOutput,
    "🎉 Update ran successfully! Please restart Codex.",
  ].join("\n");

  assertEquals(
    formatCodexUpdateResult({ code: 0, output, version: "codex-cli 0.135.0" }),
    [
      "🎉 Update ran successfully! (codex-cli 0.135.0)",
      "",
      "```",
      "Updating Codex via npm install -g @openai/codex...",
      npmOutput,
      "```",
      "",
      "BOT は Codex を実行ごとに起動するため、再起動などは必要ないよ。",
    ].join("\n"),
  );
});

Deno.test("formatCodexUpdateError: 失敗メッセージを整形する", () => {
  assertEquals(
    formatCodexUpdateError({
      type: "COMMAND_FAILED",
      code: 1,
      output: "permission denied",
    }),
    "Codex update に失敗しました (終了コード: 1)。\n\npermission denied",
  );
});
