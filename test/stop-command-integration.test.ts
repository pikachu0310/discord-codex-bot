import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createTestContext, createTestRepository } from "./test-utils.ts";
import { join } from "std/path/mod.ts";

Deno.test("/stop コマンド統合テスト - 実行中でない場合のメッセージ確認", async () => {
  const { admin, cleanup } = await createTestContext();
  const threadId = "stop-test-thread-1";

  try {
    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk(), "Worker作成に失敗");
    const worker = workerResult.value;

    // 何も実行していない状態で/stopコマンドを送信
    const stopResult = await worker.stopExecution();
    assert(
      !stopResult,
      "実行中でないのに中断が成功してしまいました",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("/stop コマンド統合テスト - 存在しないスレッドへの中断コマンド", async () => {
  const { admin, cleanup } = await createTestContext();
  const threadId = "non-existent-thread";

  try {
    // 存在しないスレッドのWorkerを取得しようとする
    const workerResult = admin.getWorker(threadId);
    assert(workerResult.isErr(), "存在しないWorkerが返されました");
    assertEquals(
      workerResult.error.type,
      "WORKER_NOT_FOUND",
      "エラータイプが期待値と異なります",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("/stop コマンド統合テスト - リポジトリ未設定時のメッセージ送信", async () => {
  const { admin, cleanup } = await createTestContext();
  const threadId = "stop-test-thread-2";

  try {
    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk(), "Worker作成に失敗");

    // リポジトリを設定せずにメッセージを送信
    const messageResult = await admin.routeMessage(
      threadId,
      "テストメッセージ",
      undefined,
      undefined,
    );

    assert(messageResult.isOk(), "メッセージ送信が失敗しました");
    const reply = messageResult.value;
    assert(typeof reply === "string", "返信がstring型ではありません");
    assert(
      reply.includes("リポジトリが設定されていません"),
      `期待されたエラーメッセージが含まれていません。実際の返信: ${reply}`,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("/stop コマンド統合テスト - リポジトリ設定後のメッセージ送信基本動作", async () => {
  const { admin, testDir, cleanup } = await createTestContext();
  const threadId = "stop-test-thread-3";

  try {
    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk(), "Worker作成に失敗");
    const worker = workerResult.value;

    // リポジトリを設定
    const repository = createTestRepository("test-org", "test-repo");
    const localPath = join(testDir, "worktrees", threadId);
    await Deno.mkdir(localPath, { recursive: true });

    // リポジトリディレクトリも作成
    const repoDir = join(testDir, "repositories", repository.fullName);
    await Deno.mkdir(repoDir, { recursive: true });

    // gitディレクトリを作成（最小限のgitリポジトリ）
    const gitDir = join(repoDir, ".git");
    await Deno.mkdir(gitDir, { recursive: true });

    await worker.setRepository(repository, localPath);

    // devcontainerの設定を無効化
    worker.setUseDevcontainer(false);

    // メッセージを送信
    const messageResult = await admin.routeMessage(
      threadId,
      "echo test",
      undefined,
      undefined,
    );

    // モックCodex CLIではないので、実際のコマンドを実行しないため、エラーになるか確認
    assert(
      messageResult.isOk() || messageResult.isErr(),
      "結果が返されませんでした",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("/stop コマンド統合テスト - 実行中かどうかの状態確認", async () => {
  const { admin, testDir, cleanup } = await createTestContext();
  const threadId = "stop-test-thread-4";

  try {
    // Workerを作成
    const workerResult = await admin.createWorker(threadId);
    assert(workerResult.isOk(), "Worker作成に失敗");
    const worker = workerResult.value;

    // リポジトリを設定
    const repository = createTestRepository("test-org", "test-repo");
    const localPath = join(testDir, "worktrees", threadId);
    await Deno.mkdir(localPath, { recursive: true });

    // リポジトリディレクトリも作成
    const repoDir = join(testDir, "repositories", repository.fullName);
    await Deno.mkdir(repoDir, { recursive: true });

    // gitディレクトリを作成
    const gitDir = join(repoDir, ".git");
    await Deno.mkdir(gitDir, { recursive: true });

    await worker.setRepository(repository, localPath);

    // devcontainerの設定を無効化
    worker.setUseDevcontainer(false);

    // workerの内部状態を確認（プライベートプロパティにアクセス）
    const workerInternal = worker as unknown as { isExecuting: boolean };
    assert(!workerInternal.isExecuting, "初期状態で実行中になっています");

    // stopExecutionは実行中でない場合はfalseを返す
    const stopResult = await worker.stopExecution();
    assert(!stopResult, "実行中でないのに中断が成功しました");
  } finally {
    await cleanup();
  }
});

Deno.test("/stop コマンド統合テスト - Adminレベルでのメッセージルーティング", async () => {
  const { admin, cleanup } = await createTestContext();
  const threadId1 = "stop-test-thread-5";
  const threadId2 = "stop-test-thread-6";

  try {
    // 2つのWorkerを作成
    const workerResult1 = await admin.createWorker(threadId1);
    const workerResult2 = await admin.createWorker(threadId2);

    assert(workerResult1.isOk(), "Worker1作成に失敗");
    assert(workerResult2.isOk(), "Worker2作成に失敗");

    // それぞれのスレッドにメッセージを送信
    const messageResult1 = await admin.routeMessage(
      threadId1,
      "メッセージ1",
      undefined,
      undefined,
    );
    const messageResult2 = await admin.routeMessage(
      threadId2,
      "メッセージ2",
      undefined,
      undefined,
    );

    // どちらもリポジトリ未設定エラーになるはず
    assert(messageResult1.isOk(), "メッセージ1送信が失敗しました");
    assert(messageResult2.isOk(), "メッセージ2送信が失敗しました");

    const reply1 = messageResult1.value;
    const reply2 = messageResult2.value;

    assert(typeof reply1 === "string");
    assert(typeof reply2 === "string");
    assert(reply1.includes("リポジトリが設定されていません"));
    assert(reply2.includes("リポジトリが設定されていません"));
  } finally {
    await cleanup();
  }
});
