import { assert, assertEquals, assertExists } from "std/assert/mod.ts";
import { RateLimitManager } from "./rate-limit-manager.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";
import type { Client } from "discord.js";

Deno.test("RateLimitManager - レートリミット情報の保存", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const rateLimitManager = new RateLimitManager(workspaceManager);
    const threadId = "test-thread-rate-limit";
    const timestamp = Math.floor(Date.now() / 1000);

    // Worker状態を作成
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // レートリミット情報を保存
    await rateLimitManager.saveRateLimitInfo(threadId, timestamp);

    // 保存されたことを確認
    const workerState = await workspaceManager.loadWorkerState(threadId);

    // タイマーをクリア
    rateLimitManager.clearAutoResumeTimer(threadId);
    assertExists(workerState);
    assertEquals(workerState?.rateLimitTimestamp, timestamp);
    assertEquals(workerState?.autoResumeAfterRateLimit, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("RateLimitManager - メッセージキューへの追加", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const rateLimitManager = new RateLimitManager(workspaceManager);
    const threadId = "test-thread-queue";

    // Worker状態を作成
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // メッセージをキューに追加
    await rateLimitManager.queueMessage(
      threadId,
      "msg-123",
      "テストメッセージ",
      "user-123",
    );

    // キューに追加されたことを確認
    const workerState = await workspaceManager.loadWorkerState(threadId);
    assertExists(workerState?.queuedMessages);
    assertEquals(workerState?.queuedMessages?.length, 1);
    assertEquals(workerState?.queuedMessages?.[0].messageId, "msg-123");
    assertEquals(workerState?.queuedMessages?.[0].content, "テストメッセージ");
    assertEquals(workerState?.queuedMessages?.[0].authorId, "user-123");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("RateLimitManager - レートリミット状態の確認", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const rateLimitManager = new RateLimitManager(workspaceManager);
    const threadId = "test-thread-check";

    // Worker状態を作成（レートリミットなし）
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: false,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: false,
        hasAnthropicsFeature: false,
        isStarted: false,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // レートリミット状態を確認
    let isRateLimited = await rateLimitManager.isRateLimited(threadId);
    assertEquals(isRateLimited, false);

    // レートリミット情報を設定
    const timestamp = Math.floor(Date.now() / 1000);
    await rateLimitManager.saveRateLimitInfo(threadId, timestamp);

    // 再度確認
    isRateLimited = await rateLimitManager.isRateLimited(threadId);

    // タイマーをクリア
    rateLimitManager.clearAutoResumeTimer(threadId);
    assertEquals(isRateLimited, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("RateLimitManager - レートリミットメッセージの作成", () => {
  const tempDir = "dummy"; // このテストではファイルシステムを使用しない
  const workspaceManager = new WorkspaceManager(tempDir);
  const rateLimitManager = new RateLimitManager(workspaceManager);

  const threadId = "test-thread";
  const timestamp = Math.floor(Date.now() / 1000);

  const message = rateLimitManager.createRateLimitMessage(threadId, timestamp);

  assert(message.includes("Codex Codeのレートリミットに達しました"));
  assert(message.includes("制限解除予定時刻"));
  assert(
    message.includes(
      "この時間までに送信されたメッセージは、制限解除後に自動的に処理されます",
    ),
  );
});

Deno.test("RateLimitManager - Discordステータス表示はCodexレート制限の文字列を使う", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const rateLimitManager = new RateLimitManager(workspaceManager);
    const presenceUpdates: unknown[] = [];

    rateLimitManager.setRateLimitStatusSource({
      getStatusText: async () => "5h残り15.3%(12:34) 1w残り78.0%(02/28 15:06)",
    });

    rateLimitManager.setDiscordClient({
      user: {
        setPresence: async (presence: unknown) => {
          presenceUpdates.push(presence);
          return null;
        },
      },
    } as unknown as Client);

    await rateLimitManager.updateDiscordStatusWithTokenUsage();

    assertEquals(presenceUpdates.length, 1);
    const [firstPresence] = presenceUpdates as [{
      activities: Array<{ name: string }>;
    }];
    assertEquals(
      firstPresence.activities[0].name,
      "5h残り15.3%(12:34) 1w残り78.0%(02/28 15:06)",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
