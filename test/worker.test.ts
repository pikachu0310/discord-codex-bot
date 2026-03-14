import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Worker } from "../src/worker/worker.ts";
import { parseRepository } from "../src/git-utils.ts";
import {
  captureConsoleOutput,
  createErrorMockCodexCommandExecutor,
  createMockCodexCommandExecutor,
  createMockStreamingCodexCommandExecutor,
  createTestRepository,
  createTestWorker,
  createTestWorkerState,
  createTestWorkspaceManager,
} from "./test-utils.ts";

Deno.test("Worker - メッセージを受け取って返信する（リポジトリ未設定）", async () => {
  const workspace = await createTestWorkspaceManager();
  const workerName = "happy-panda";
  const executor = createMockCodexCommandExecutor();

  try {
    const worker = await createTestWorker(workerName, workspace, executor);
    const message = "テストメッセージです";
    const result = await worker.processMessage(message);

    // Result型の確認
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "REPOSITORY_NOT_SET");
    }
  } finally {
    // WorkspaceManagerのクリーンアップは省略（テストごとに独立）
  }
});

Deno.test("Worker - 名前を取得できる", async () => {
  const workspace = await createTestWorkspaceManager();
  const workerName = "clever-fox";

  try {
    const worker = await createTestWorker(workerName, workspace);
    assertEquals(worker.getName(), workerName);
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - 空のメッセージも処理できる", async () => {
  const workspace = await createTestWorkspaceManager();
  const executor = createMockCodexCommandExecutor();

  try {
    const worker = await createTestWorker("test-worker", workspace, executor);
    const result = await worker.processMessage("");

    // Result型の確認
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "REPOSITORY_NOT_SET");
    }
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - リポジトリ情報を設定・取得できる", async () => {
  const workspace = await createTestWorkspaceManager();

  try {
    const worker = await createTestWorker("test-worker", workspace);
    const repository = createTestRepository("octocat", "Hello-World");
    const repoPath = "/path/to/repo";

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false); // ホスト環境を選択

    await worker.setRepository(repository, repoPath);
    const retrievedRepo = worker.getRepository();

    assertEquals(retrievedRepo?.org, "octocat");
    assertEquals(retrievedRepo?.repo, "Hello-World");
    assertEquals(retrievedRepo?.fullName, "octocat/Hello-World");
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - 設定未完了時の定型メッセージ", async () => {
  const workspace = await createTestWorkspaceManager();
  const executor = createMockCodexCommandExecutor();

  try {
    // devcontainer設定が未完了のWorkerStateを作成
    const state = createTestWorkerState("test-worker", "test-thread-id", {
      devcontainerConfig: {
        useDevcontainer: undefined as unknown as boolean, // 未設定状態
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
    });
    const worker = new Worker(
      state,
      workspace,
      executor,
      undefined,
      undefined,
    );
    const repository = createTestRepository("octocat", "Hello-World");
    await worker.setRepository(repository, "/test/repo");

    // 設定が未完了の状態でメッセージを送信
    const message = "リポジトリについて教えて";
    const result = await worker.processMessage(message);

    // Result型の確認
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "CONFIGURATION_INCOMPLETE");
    }
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - リポジトリ設定後のメッセージ処理", async () => {
  const workspace = await createTestWorkspaceManager();
  const mockResponse = "これはリポジトリ設定後のモック応答です。";
  const executor = createMockCodexCommandExecutor(mockResponse);

  try {
    const worker = await createTestWorker("test-worker", workspace, executor);
    const repository = createTestRepository("octocat", "Hello-World");

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false); // ホスト環境を選択

    await worker.setRepository(repository, "/test/repo");

    const message = "リポジトリについて教えて";
    const result = await worker.processMessage(message);

    // Result型の確認
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      assertEquals(result.value, mockResponse);
    }
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - verboseモードが正しく設定される", async () => {
  const workspace = await createTestWorkspaceManager();

  try {
    const workerVerbose = await createTestWorker(
      "verbose-worker",
      workspace,
      undefined,
      true,
    );
    const workerQuiet = await createTestWorker(
      "quiet-worker",
      workspace,
      undefined,
      false,
    );

    // 内部状態の確認は実装に依存するため、動作確認のみ
    assertEquals(workerVerbose.getName(), "verbose-worker");
    assertEquals(workerQuiet.getName(), "quiet-worker");
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - verboseモードでログが出力される", async () => {
  const workspace = await createTestWorkspaceManager();
  const executor = createMockCodexCommandExecutor();

  let logOutput = "";
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logOutput += args.join(" ") + "\n";
    originalLog(...args);
  };

  try {
    const state = createTestWorkerState("verbose-worker", "test-thread-1");
    const worker = new Worker(
      state,
      workspace,
      executor,
      true,
      undefined,
    );
    const message = "verbose test message";
    const result = await worker.processMessage(message);

    // Result型の確認 - リポジトリ未設定エラー
    assertEquals(result.isErr(), true);

    // ログに worker名が含まれることを確認
    assertEquals(logOutput.includes("verbose-worker"), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("Worker - verboseモード無効時はログが出力されない", async () => {
  const workspace = await createTestWorkspaceManager();
  const { logs, restore } = captureConsoleOutput();

  try {
    const worker = await createTestWorker(
      "quiet-worker",
      workspace,
      undefined,
      false,
    );
    const result = await worker.processMessage("quiet test message");

    // Result型の確認 - リポジトリ未設定エラー
    assertEquals(result.isErr(), true);

    const hasWorkerLog = logs.some((log) =>
      log.includes("quiet-worker") && log.includes("メッセージ受信")
    );
    assertEquals(hasWorkerLog, false);
  } finally {
    restore();
  }
});

Deno.test("Worker - Codex Codeの実際の出力が行ごとに送信される", async () => {
  const workspace = await createTestWorkspaceManager();
  const repositoryResult = parseRepository("test/repo");
  if (repositoryResult.isErr()) {
    throw new Error("Failed to parse repository");
  }
  const repository = repositoryResult.value;
  const repoPath = "/test/repo";

  const mockExecutor = createMockStreamingCodexCommandExecutor();
  // モックレスポンスは最終的に"モックレスポンス"を返す
  mockExecutor.setResponse("test", "モックレスポンス");

  try {
    const worker = await createTestWorker(
      "test-worker",
      workspace,
      mockExecutor,
    );

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false); // ホスト環境を選択

    await worker.setRepository(repository, repoPath);

    const progressMessages: string[] = [];
    const result = await worker.processMessage(
      "test",
      async (content: string) => {
        progressMessages.push(content);
      },
    );

    // ストリーミングされたメッセージを確認
    assertEquals(progressMessages.length > 0, true);
    assertEquals(result.isOk(), true);
    if (result.isOk()) {
      assertEquals(result.value, "モックレスポンス");
    }
  } finally {
    // クリーンアップ
  }
});

Deno.test("Worker - エラーメッセージも正しく出力される", async () => {
  const workspace = await createTestWorkspaceManager();
  const repositoryResult = parseRepository("test/repo");
  if (repositoryResult.isErr()) {
    throw new Error("Failed to parse repository");
  }
  const repository = repositoryResult.value;
  const repoPath = "/test/repo";
  const errorExecutor = createErrorMockCodexCommandExecutor("モックエラー", 1);

  try {
    const worker = await createTestWorker(
      "test-worker",
      workspace,
      errorExecutor,
    );

    // devcontainer設定を完了させる
    worker.setUseDevcontainer(false); // ホスト環境を選択

    await worker.setRepository(repository, repoPath);

    const progressMessages: string[] = [];
    const result = await worker.processMessage(
      "test message",
      async (content: string) => {
        progressMessages.push(content);
      },
    );

    // Result型の確認 - エラーの場合
    assertEquals(result.isErr(), true);
    if (result.isErr()) {
      assertEquals(result.error.type, "CODEX_EXECUTION_FAILED");
      if (result.error.type === "CODEX_EXECUTION_FAILED") {
        assertEquals(result.error.error.includes("モックエラー"), true);
      }
    }
    assertEquals(progressMessages.length > 0, true);
  } finally {
    // クリーンアップ
  }
});
