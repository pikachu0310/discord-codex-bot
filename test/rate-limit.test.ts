import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { WorkspaceManager } from "../src/workspace/workspace.ts";
import { Admin } from "../src/admin/admin.ts";
import {
  CodexCodeRateLimitError,
  CodexStreamProcessor,
} from "../src/worker/codex-stream-processor.ts";
import { MessageFormatter } from "../src/worker/message-formatter.ts";

Deno.test("レートリミット検出とメッセージ作成", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "test_rate_limit_" });
  const workspaceManager = new WorkspaceManager(baseDir);
  await workspaceManager.initialize();

  const adminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };
  const admin = new Admin(adminState, workspaceManager, undefined, undefined);
  const threadId = "test-thread-123";
  const timestamp = Math.floor(Date.now() / 1000);

  // レートリミットメッセージを作成
  const message = admin.createRateLimitMessage(threadId, timestamp);

  // メッセージ内容をチェック（string型に対応）
  assertStringIncludes(
    message,
    "Codex Codeのレートリミットに達しました",
  );
  assertStringIncludes(message, "制限解除予定時刻");
  assertStringIncludes(
    message,
    "この時間までに送信されたメッセージは、制限解除後に自動的に処理されます",
  );

  await Deno.remove(baseDir, { recursive: true });
});

Deno.test("CodexCodeRateLimitError の作成と属性", () => {
  const timestamp = 1749168000;
  const error = new CodexCodeRateLimitError(timestamp);

  assertEquals(error.name, "CodexCodeRateLimitError");
  assertEquals(error.timestamp, timestamp);
  assertEquals(error.message, `Codex AI usage limit reached|${timestamp}`);
});

Deno.test("CodexStreamProcessor でのレートリミット検出", () => {
  const formatter = new MessageFormatter();
  const processor = new CodexStreamProcessor(formatter);

  // レートリミットメッセージの検出テスト
  assertEquals(
    processor.isCodexCodeRateLimit("Codex AI usage limit reached|1749168000"),
    true,
  );
  assertEquals(
    processor.isCodexCodeRateLimit("Codex AI usage limit reached 1749168000"),
    true,
  );
  assertEquals(
    processor.isCodexCodeRateLimit("Codex AI usage limit reached"),
    true,
  );
  assertEquals(processor.isCodexCodeRateLimit("Normal response"), false);

  // タイムスタンプ抽出テスト
  assertEquals(
    processor.extractRateLimitTimestamp(
      "Codex AI usage limit reached|1749168000",
    ),
    1749168000,
  );
  assertEquals(
    processor.extractRateLimitTimestamp(
      "Codex AI usage limit reached 1749168000",
    ),
    1749168000,
  );
  assertEquals(processor.extractRateLimitTimestamp("Normal response"), null);
});

Deno.test("レートリミット自動継続ボタンハンドリング", async () => {
  const baseDir = await Deno.makeTempDir({ prefix: "test_rate_limit_button_" });
  const workspaceManager = new WorkspaceManager(baseDir);
  await workspaceManager.initialize();

  const adminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };
  const admin = new Admin(adminState, workspaceManager, undefined, undefined);
  const threadId = "test-thread-456";
  const timestamp = Math.floor(Date.now() / 1000);

  // Workerを作成してスレッド情報を準備
  const createWorkerResult = await admin.createWorker(threadId);
  assert(createWorkerResult.isOk());

  // レートリミット情報を保存
  const workerState = await workspaceManager.loadWorkerState(threadId);
  if (workerState) {
    workerState.rateLimitTimestamp = timestamp;
    await workspaceManager.saveWorkerState(workerState);
  }

  // 「はい」ボタンの処理
  const yesResultOrErr = await admin.handleButtonInteraction(
    threadId,
    `rate_limit_auto_yes_${threadId}`,
  );
  assert(yesResultOrErr.isOk());
  assertStringIncludes(yesResultOrErr.value, "自動継続が設定されました");

  // WorkerStateが更新されていることを確認
  const updatedWorkerState = await workspaceManager.loadWorkerState(threadId);
  assertEquals(updatedWorkerState?.autoResumeAfterRateLimit, true);

  // 「いいえ」ボタンの処理
  const noResultOrErr = await admin.handleButtonInteraction(
    threadId,
    `rate_limit_auto_no_${threadId}`,
  );
  assert(noResultOrErr.isOk());
  assertStringIncludes(noResultOrErr.value, "手動での再開が選択されました");

  // WorkerStateが更新されていることを確認
  const finalWorkerState = await workspaceManager.loadWorkerState(threadId);
  assertEquals(finalWorkerState?.autoResumeAfterRateLimit, false);

  // スレッドを終了してタイマーをクリア
  const terminateResult = await admin.terminateThread(threadId);
  assert(terminateResult.isOk());

  await Deno.remove(baseDir, { recursive: true });
});

Deno.test(
  "レートリミットタイマーの復旧 - 時間が残っている場合",
  async () => {
    const baseDir = await Deno.makeTempDir({
      prefix: "test_rate_limit_restore_",
    });
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const adminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    const admin = new Admin(adminState, workspaceManager, undefined, undefined);
    const threadId = "test-thread-restore-1";

    // 未来のタイムスタンプ（30秒後）
    const futureTimestamp = Math.floor((Date.now() + 30 * 1000) / 1000);

    // Workerを作成してスレッド情報を準備
    const createWorkerResult = await admin.createWorker(threadId);
    assert(createWorkerResult.isOk());

    // レートリミット情報を保存（自動継続有効）
    const workerState = await workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      workerState.rateLimitTimestamp = futureTimestamp;
      workerState.autoResumeAfterRateLimit = true;
      await workspaceManager.saveWorkerState(workerState);
    }

    // 新しいAdminインスタンスで復旧をテスト
    // Admin状態を保存してから再読み込み
    await admin.save();

    const adminState2 = await workspaceManager.loadAdminState() || {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    const admin2 = new Admin(
      adminState2,
      workspaceManager,
      undefined,
      undefined,
    );

    // タイマーが設定されたことを間接的に確認するため、
    // Worker状態が変更されないことを確認（タイマーがまだ実行されていない）
    await admin2.restoreActiveThreads();

    // タイマー設定後もWorker状態にレートリミット情報が残っていることを確認
    const restoredWorkerState = await workspaceManager.loadWorkerState(
      threadId,
    );
    assertEquals(restoredWorkerState?.rateLimitTimestamp, futureTimestamp);
    assertEquals(restoredWorkerState?.autoResumeAfterRateLimit, true);

    // 時間が残っている場合、タイマーが設定されてWorker状態は変更されないはず
    // （タイマーがまだ実行されていないことを確認）
    // 自動継続が有効なので、レートリミット情報はそのまま残る
    assert(restoredWorkerState !== null, "Worker状態が見つかりません");
    assert(
      restoredWorkerState.rateLimitTimestamp !== undefined,
      "レートリミットタイムスタンプが残っているはずです",
    );

    // クリーンアップ
    await admin.terminateThread(threadId);
    await admin2.terminateThread(threadId);
    await Deno.remove(baseDir, { recursive: true });
  },
);

Deno.test("レートリミットタイマーの復旧 - 時間が過ぎている場合（キューが空）", async () => {
  const baseDir = await Deno.makeTempDir({
    prefix: "test_rate_limit_restore_expired_",
  });
  const workspaceManager = new WorkspaceManager(baseDir);
  await workspaceManager.initialize();

  const adminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };
  const admin = new Admin(adminState, workspaceManager, undefined, undefined);
  const threadId = "test-thread-restore-2";

  // 過去のタイムスタンプ（10分前）
  const pastTimestamp = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);

  // Workerを作成してスレッド情報を準備
  const createWorkerResult = await admin.createWorker(threadId);
  assert(createWorkerResult.isOk());

  // レートリミット情報を保存（自動継続有効）
  const workerState = await workspaceManager.loadWorkerState(threadId);
  if (workerState) {
    workerState.rateLimitTimestamp = pastTimestamp;
    workerState.autoResumeAfterRateLimit = true;
    workerState.queuedMessages = []; // 空のキュー
    await workspaceManager.saveWorkerState(workerState);
  }

  // 自動再開コールバックをモック
  let autoResumeCallbackCalled = false;

  admin.setAutoResumeCallback(async (_threadId: string, _message: string) => {
    autoResumeCallbackCalled = true;
  });

  // 新しいAdminインスタンスで復旧をテスト（コールバックは引き継がれないのでadminを使用）
  const restoreResult = await admin.restoreActiveThreads();
  assert(restoreResult.isOk());

  // キューが空の場合は自動再開コールバックが呼ばれないことを確認
  assertEquals(autoResumeCallbackCalled, false);

  // レートリミット情報がリセットされていることを確認
  const updatedWorkerState = await workspaceManager.loadWorkerState(threadId);
  assertEquals(updatedWorkerState?.rateLimitTimestamp, undefined);
  assertEquals(updatedWorkerState?.autoResumeAfterRateLimit, undefined);

  // クリーンアップ
  const terminateResult = await admin.terminateThread(threadId);
  assert(terminateResult.isOk());
  await Deno.remove(baseDir, { recursive: true });
});

Deno.test("レートリミットタイマーの復旧 - キューにメッセージがある場合", async () => {
  const baseDir = await Deno.makeTempDir({
    prefix: "test_rate_limit_restore_with_queue_",
  });
  const workspaceManager = new WorkspaceManager(baseDir);
  await workspaceManager.initialize();

  const adminState = {
    activeThreadIds: [],
    lastUpdated: new Date().toISOString(),
  };
  const admin = new Admin(adminState, workspaceManager, undefined, undefined);
  const threadId = "test-thread-restore-queue";

  // 過去のタイムスタンプ（10分前）
  const pastTimestamp = Math.floor((Date.now() - 10 * 60 * 1000) / 1000);

  // Workerを作成してスレッド情報を準備
  const createWorkerResult = await admin.createWorker(threadId);
  assert(createWorkerResult.isOk());

  // レートリミット情報を保存（自動継続有効、キューにメッセージあり）
  const workerState = await workspaceManager.loadWorkerState(threadId);
  if (workerState) {
    workerState.rateLimitTimestamp = pastTimestamp;
    workerState.autoResumeAfterRateLimit = true;
    workerState.queuedMessages = [{
      messageId: "test-message-1",
      content: "テストメッセージ",
      timestamp: Date.now(),
      authorId: "test-author",
    }];
    await workspaceManager.saveWorkerState(workerState);
  }

  // 自動再開コールバックをモック
  let autoResumeCallbackCalled = false;
  let autoResumeThreadId = "";
  let autoResumeMessage = "";

  admin.setAutoResumeCallback(async (threadId: string, message: string) => {
    autoResumeCallbackCalled = true;
    autoResumeThreadId = threadId;
    autoResumeMessage = message;
  });

  // 新しいAdminインスタンスで復旧をテスト（コールバックは引き継がれないのでadminを使用）
  const restoreResult = await admin.restoreActiveThreads();
  assert(restoreResult.isOk());

  // キューからメッセージが処理されたことを確認
  assertEquals(autoResumeCallbackCalled, true);
  assertEquals(autoResumeThreadId, threadId);
  assertEquals(autoResumeMessage, "テストメッセージ");

  // レートリミット情報がリセットされていることを確認
  const updatedWorkerState = await workspaceManager.loadWorkerState(threadId);
  assertEquals(updatedWorkerState?.rateLimitTimestamp, undefined);
  assertEquals(updatedWorkerState?.autoResumeAfterRateLimit, undefined);
  assertEquals(updatedWorkerState?.queuedMessages?.length, 0);

  // クリーンアップ
  const terminateResult = await admin.terminateThread(threadId);
  assert(terminateResult.isOk());
  await Deno.remove(baseDir, { recursive: true });
});

Deno.test(
  "レートリミットタイマーの復旧 - 自動継続が無効の場合",
  async () => {
    const baseDir = await Deno.makeTempDir({
      prefix: "test_rate_limit_restore_disabled_",
    });
    const workspaceManager = new WorkspaceManager(baseDir);
    await workspaceManager.initialize();

    const adminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    const admin = new Admin(adminState, workspaceManager, undefined, undefined);
    const threadId = "test-thread-restore-3";

    // 未来のタイムスタンプ
    const futureTimestamp = Math.floor((Date.now() + 30 * 1000) / 1000);

    // Workerを作成してスレッド情報を準備
    const createWorkerResult = await admin.createWorker(threadId);
    assert(createWorkerResult.isOk());

    // レートリミット情報を保存（自動継続無効）
    const workerState = await workspaceManager.loadWorkerState(threadId);
    if (workerState) {
      workerState.rateLimitTimestamp = futureTimestamp;
      workerState.autoResumeAfterRateLimit = false;
      await workspaceManager.saveWorkerState(workerState);
    }

    // Admin状態を保存
    await admin.save();

    // 新しいAdminインスタンスで復旧をテスト
    const adminState2 = await workspaceManager.loadAdminState() || {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    const admin2 = new Admin(
      adminState2,
      workspaceManager,
      undefined,
      undefined,
    );
    await admin2.restoreActiveThreads();

    // 自動継続が無効の場合、タイマーが設定されないことを確認
    // Worker状態にレートリミット情報が残っていることを確認
    const restoredWorkerState = await workspaceManager.loadWorkerState(
      threadId,
    );
    assertEquals(restoredWorkerState?.rateLimitTimestamp, futureTimestamp);
    assertEquals(restoredWorkerState?.autoResumeAfterRateLimit, false);

    // 自動継続が無効なので、タイマーは設定されずレートリミット情報はそのまま残る
    assert(restoredWorkerState !== null, "Worker状態が見つかりません");
    assert(
      restoredWorkerState.rateLimitTimestamp !== undefined,
      "レートリミットタイムスタンプが残っているはずです",
    );

    // 時間が経過してもWorker状態は変わらないことを確認（タイマーが設定されていないため）
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unchangedWorkerState = await workspaceManager.loadWorkerState(
      threadId,
    );
    assertEquals(unchangedWorkerState?.rateLimitTimestamp, futureTimestamp);
    assertEquals(unchangedWorkerState?.autoResumeAfterRateLimit, false);

    // クリーンアップ
    await admin.terminateThread(threadId);
    await admin2.terminateThread(threadId);
    await Deno.remove(baseDir, { recursive: true });
  },
);
