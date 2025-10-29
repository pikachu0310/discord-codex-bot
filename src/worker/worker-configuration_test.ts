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

Deno.test("WorkerConfiguration - buildCodexArgs - 基本", () => {
  const config = new WorkerConfiguration();
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args, [
    "-p",
    "テストプロンプト",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ]);
});

Deno.test("WorkerConfiguration - buildCodexArgs - verboseモード", () => {
  const config = new WorkerConfiguration(true);
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args.includes("--verbose"), true);
});

Deno.test.ignore(
  "WorkerConfiguration - buildCodexArgs - セッション継続",
  () => {
    const config = new WorkerConfiguration();
    const args = config.buildCodexArgs("テストプロンプト", "session-123");

    assertEquals(args.includes("--resume"), true);
    assertEquals(args.includes("session-123"), true);
  },
);

Deno.test("WorkerConfiguration - buildCodexArgs - 追加システムプロンプト", () => {
  const config = new WorkerConfiguration(false, "追加プロンプト");
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(args.includes("--append-system-prompt=追加プロンプト"), true);
});

Deno.test("WorkerConfiguration - buildCodexArgs - 空白を含む追加システムプロンプト", () => {
  const config = new WorkerConfiguration(false, "追加の システム プロンプト");
  const args = config.buildCodexArgs("テストプロンプト");

  assertEquals(
    args.includes("--append-system-prompt=追加の システム プロンプト"),
    true,
  );
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
