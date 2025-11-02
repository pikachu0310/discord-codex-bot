import { assertEquals } from "https://deno.land/std@0.211.0/assert/mod.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import {
  recordDangerouslyBypassUnsupportedForTests,
  recordDangerouslySkipPermissionsUnsupportedForTests,
  recordExecJsonUnsupportedForTests,
  recordVerboseFlagUnsupportedForTests,
  resetCodexCliCapabilityCacheForTests,
} from "./codex-cli-capabilities.ts";

Deno.test("WorkerConfiguration - 初期設定", () => {
  const config = new WorkerConfiguration(
    true,
    "追加プロンプト",
    "http://translator.example.com",
  );

  assertEquals(config.isVerbose(), true);
  assertEquals(config.getAppendSystemPrompt(), "追加プロンプト");
  assertEquals(config.getTranslatorUrl(), "http://translator.example.com");
});

Deno.test("WorkerConfiguration - デフォルト設定", () => {
  const config = new WorkerConfiguration();

  assertEquals(config.isVerbose(), false);
  assertEquals(config.getAppendSystemPrompt(), undefined);
  assertEquals(config.getTranslatorUrl(), undefined);
});

Deno.test("WorkerConfiguration - verboseモード設定", () => {
  const config = new WorkerConfiguration();

  assertEquals(config.isVerbose(), false);
  config.setVerbose(true);
  assertEquals(config.isVerbose(), true);
});

Deno.test("WorkerConfiguration - buildCodexArgs - 基本", () => {
  resetCodexCliCapabilityCacheForTests();
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args, [
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "テストプロンプト",
  ]);
});

Deno.test("WorkerConfiguration - buildCodexArgs - verboseモード", () => {
  resetCodexCliCapabilityCacheForTests();
  const config = new WorkerConfiguration(true);
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args.includes("--verbose"), true);
});

Deno.test(
  "WorkerConfiguration - Codex CLIが--verboseをサポートしない場合にフラグを付与しない",
  () => {
    try {
      resetCodexCliCapabilityCacheForTests();
      recordVerboseFlagUnsupportedForTests();
      const config = new WorkerConfiguration(true);
      const args = config.buildCodexArgs("テストプロンプト");

      assertEquals(args.includes("--verbose"), false);
    } finally {
      resetCodexCliCapabilityCacheForTests();
    }
  },
);

Deno.test(
  "WorkerConfiguration - Codex CLIが--dangerously-skip-permissionsをサポートしない場合にフラグを付与しない",
  () => {
    try {
      resetCodexCliCapabilityCacheForTests();
      recordDangerouslySkipPermissionsUnsupportedForTests();
      const config = new WorkerConfiguration();
      const args = config.buildCodexArgs("テストプロンプト");

      assertEquals(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    } finally {
      resetCodexCliCapabilityCacheForTests();
    }
  },
);

Deno.test(
  "WorkerConfiguration - buildCodexArgs - セッション継続",
  () => {
    resetCodexCliCapabilityCacheForTests();
    const config = new WorkerConfiguration();
    const args = config.buildCodexArgs("テストプロンプト", "session-123");

    assertEquals(args.slice(0, 2), ["exec", "--json"]);
    const resumeIndex = args.indexOf("resume");
    assertEquals(resumeIndex !== -1, true);
    assertEquals(args[resumeIndex + 1], "session-123");
    assertEquals(args[args.length - 1], "テストプロンプト");
  },
);

Deno.test("WorkerConfiguration - buildCodexArgs - 追加システムプロンプト", () => {
  const config = new WorkerConfiguration(false, "追加プロンプト");
  const args = config.buildCodexArgs("テストプロンプト");

  const index = args.indexOf("--append-system-prompt");
  assertEquals(index !== -1, true);
  assertEquals(args[index + 1], "追加プロンプト");
});

Deno.test("WorkerConfiguration - buildCodexArgs - 空白を含む追加システムプロンプト", () => {
  const config = new WorkerConfiguration(false, "追加の システム プロンプト");
  const args = config.buildCodexArgs("テストプロンプト");

  const index = args.indexOf("--append-system-prompt");
  assertEquals(index !== -1, true);
  assertEquals(args[index + 1], "追加の システム プロンプト");
});

Deno.test("WorkerConfiguration - CODEX_CLI_OUTPUT_FORMAT_MODE=neverでフラグ無効", () => {
  try {
    Deno.env.set("CODEX_CLI_OUTPUT_FORMAT_MODE", "never");
    resetCodexCliCapabilityCacheForTests();
    recordExecJsonUnsupportedForTests();
    const config = new WorkerConfiguration();
    const args = config.buildCodexArgs("テストプロンプト");

    assertEquals(args.includes("--output-format"), false);
  } finally {
    Deno.env.delete("CODEX_CLI_OUTPUT_FORMAT_MODE");
    resetCodexCliCapabilityCacheForTests();
  }
});

Deno.test("WorkerConfiguration - logVerbose - verboseモードでログ出力", () => {
  const config = new WorkerConfiguration(true);

  // console.logをモック
  const originalLog = console.log;
  const loggedMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    config.logVerbose("TestWorker", "テストメッセージ", { key: "value" });

    // ログが出力されていることを確認
    assertEquals(loggedMessages.length, 2);
    assertEquals(
      loggedMessages[0].includes("[Worker:TestWorker] テストメッセージ"),
      true,
    );
    assertEquals(loggedMessages[1].includes("メタデータ:"), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("WorkerConfiguration - logVerbose - 非verboseモードでログ出力なし", () => {
  const config = new WorkerConfiguration(false);

  // console.logをモック
  const originalLog = console.log;
  const loggedMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    config.logVerbose("TestWorker", "テストメッセージ");

    // ログが出力されていないことを確認
    assertEquals(loggedMessages.length, 0);
  } finally {
    console.log = originalLog;
  }
});
