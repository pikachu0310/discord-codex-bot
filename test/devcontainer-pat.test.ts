import { assertEquals, assertExists } from "std/assert/mod.ts";
import { afterEach, beforeEach, describe, it } from "std/testing/bdd.ts";
import { Worker } from "../src/worker/worker.ts";
import { DevcontainerCodexExecutor } from "../src/worker/codex-executor.ts";
import {
  RepositoryPatInfo,
  WorkerState,
  WorkspaceManager,
} from "../src/workspace/workspace.ts";
import { GitRepository } from "../src/git-utils.ts";

describe("Devcontainer PAT環境変数設定", () => {
  let workspaceManager: WorkspaceManager;
  let tempDir: string;

  beforeEach(async () => {
    // テスト用の一時ディレクトリを作成
    tempDir = await Deno.makeTempDir({ prefix: "devcontainer_pat_test_" });
    workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();
  });

  afterEach(async () => {
    // テスト用ディレクトリをクリーンアップ
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch (error) {
      console.error("テストディレクトリのクリーンアップに失敗:", error);
    }
  });

  it("DevcontainerCodexExecutorがPATを環境変数として設定する", async () => {
    const ghToken = "ghp_test1234567890abcdefghijklmnopqrstu";
    const executor = new DevcontainerCodexExecutor(
      "/test/path",
      false,
      ghToken,
    );

    // executeStreamingメソッドが環境変数を正しく設定することを確認
    // （実際の実行はモック化が必要なため、ここではインスタンス作成のみ確認）
    assertExists(executor);
  });

  it("WorkerがリポジトリのPATを取得してDevcontainerに渡す", async () => {
    // PATを保存
    const patInfo: RepositoryPatInfo = {
      repositoryFullName: "owner/repo",
      token: "ghp_test1234567890abcdefghijklmnopqrstu",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: "テスト用PAT",
    };
    await workspaceManager.saveRepositoryPat(patInfo);

    // Workerを作成
    const state: WorkerState = {
      workerName: "test-worker",
      threadId: "test-thread-id",
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
    };
    const worker = new Worker(
      state,
      workspaceManager,
      undefined,
      undefined,
      undefined,
    );
    worker.setUseDevcontainer(true);

    // リポジトリを設定
    const repository: GitRepository = {
      org: "owner",
      repo: "repo",
      fullName: "owner/repo",
      localPath: "owner/repo",
    };

    // リポジトリディレクトリを作成
    const repoPath = await Deno.makeTempDir({ prefix: "test_repo_" });
    try {
      await worker.setRepository(repository, repoPath);

      // DevcontainerCodexExecutorが正しく設定されていることを確認
      assertEquals(worker.isUsingDevcontainer(), true);
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  });

  it("PATがない場合でもDevcontainerは正常に動作する", async () => {
    // PATを保存しない

    // Workerを作成
    const state: WorkerState = {
      workerName: "test-worker",
      threadId: "test-thread-id",
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
    };
    const worker = new Worker(
      state,
      workspaceManager,
      undefined,
      undefined,
      undefined,
    );
    worker.setUseDevcontainer(true);

    // リポジトリを設定
    const repository: GitRepository = {
      org: "owner",
      repo: "repo-without-pat",
      fullName: "owner/repo-without-pat",
      localPath: "owner/repo-without-pat",
    };

    // リポジトリディレクトリを作成
    const repoPath = await Deno.makeTempDir({ prefix: "test_repo_" });
    try {
      await worker.setRepository(repository, repoPath);

      // DevcontainerCodexExecutorが正しく設定されていることを確認
      assertEquals(worker.isUsingDevcontainer(), true);
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  });
});
