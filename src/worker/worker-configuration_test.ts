import { assertEquals } from "https://deno.land/std@0.211.0/assert/mod.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";

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

Deno.test("WorkerConfiguration - buildCodexArgs - 固定コマンド", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args, [
    "--search",
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "テストプロンプト",
  ]);
});

Deno.test("WorkerConfiguration - buildCodexArgs - セッション継続", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("テストプロンプト", "session-123");

  assertEquals(args, [
    "--search",
    "exec",
    "--json",
    "--color",
    "never",
    "--dangerously-bypass-approvals-and-sandbox",
    "resume",
    "session-123",
    "テストプロンプト",
  ]);
});

Deno.test("WorkerConfiguration - buildCodexArgs - 追加システムプロンプト", () => {
  const config = new WorkerConfiguration(false, "追加プロンプト");
  const args = config.buildCodexArgs("テストプロンプト");

  const index = args.indexOf("--append-system-prompt");
  assertEquals(index !== -1, true);
  assertEquals(args[index + 1], "追加プロンプト");
});

Deno.test("WorkerConfiguration - buildCodexArgs - 権限スキップを無効化", () => {
  const config = new WorkerConfiguration();
  config.setDangerouslySkipPermissions(false);

  const args = config.buildCodexArgs("テストプロンプト");
  assertEquals(
    args.includes("--dangerously-bypass-approvals-and-sandbox"),
    false,
  );
});

Deno.test("WorkerConfiguration - logVerbose - verboseモードでログ出力", () => {
  const config = new WorkerConfiguration(true);

  const originalLog = console.log;
  const loggedMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    config.logVerbose("TestWorker", "テストメッセージ", { key: "value" });

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

  const originalLog = console.log;
  const loggedMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedMessages.push(args.join(" "));
  };

  try {
    config.logVerbose("TestWorker", "テストメッセージ");
    assertEquals(loggedMessages.length, 0);
  } finally {
    console.log = originalLog;
  }
});
