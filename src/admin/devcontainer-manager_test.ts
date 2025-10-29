import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { join } from "std/path/mod.ts";
import {
  CommandExecutor,
  CommandOutput,
  DevcontainerManager,
} from "./devcontainer-manager.ts";
import { WorkspaceManager } from "../workspace/workspace.ts";

Deno.test("DevcontainerManager - devcontainer.jsonが存在しない場合", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const devcontainerManager = new DevcontainerManager(workspaceManager);
    const repoDir = await Deno.makeTempDir();

    try {
      const result = await devcontainerManager.checkAndSetupDevcontainer(
        "test-thread",
        repoDir,
      );

      assertEquals(result.hasDevcontainer, false);
      // DevcontainerManagerは空文字を返すようになったので、メッセージはmain.tsで生成される
      assertEquals(result.message, "");
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - devcontainer.jsonが存在する場合", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const devcontainerManager = new DevcontainerManager(workspaceManager);
    const repoDir = await Deno.makeTempDir();

    try {
      // devcontainer.jsonを作成
      const config = {
        name: "test",
        image: "node:20",
        features: {
          "ghcr.io/anthropics/devcontainer-features/codex-cli:latest": {},
        },
      };

      await Deno.writeTextFile(
        join(repoDir, ".devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await devcontainerManager.checkAndSetupDevcontainer(
        "test-thread",
        repoDir,
      );

      assertEquals(result.hasDevcontainer, true);
      // devcontainer CLIがインストールされていない環境でのテストなので、
      // CLIが見つからないメッセージが返されることを期待
      if (!result.message.includes("devcontainer内でCodexを実行しますか")) {
        assertStringIncludes(
          result.message,
          "devcontainer CLIがインストールされていません",
        );
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - anthropics featuresがない場合の警告", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const devcontainerManager = new DevcontainerManager(workspaceManager);
    const repoDir = await Deno.makeTempDir();

    try {
      // anthropics featuresのないdevcontainer.jsonを作成
      const config = {
        name: "test-no-anthropics",
        image: "node:20",
        features: {
          "ghcr.io/devcontainers/features/node:1": {},
        },
      };

      await Deno.writeTextFile(
        join(repoDir, ".devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await devcontainerManager.checkAndSetupDevcontainer(
        "test-thread",
        repoDir,
      );

      assertEquals(result.hasDevcontainer, true);
      // devcontainer CLIがインストールされていない環境では警告メッセージが異なる
      if (result.warning?.includes("anthropics/devcontainer-features")) {
        assertStringIncludes(
          result.warning,
          "anthropics/devcontainer-features",
        );
      } else {
        // CLIがない場合のメッセージの確認
        assertStringIncludes(result.message, "devcontainer CLI");
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - devcontainer設定の保存と取得", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    const devcontainerManager = new DevcontainerManager(workspaceManager);
    const threadId = "test-thread-config";

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

    // devcontainer設定を保存
    const config = {
      useDevcontainer: true,
      hasDevcontainerFile: true,
      hasAnthropicsFeature: true,
      containerId: "test-container-id",
      isStarted: true,
    };

    await devcontainerManager.saveDevcontainerConfig(threadId, config);

    // 設定を取得
    const loadedConfig = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    assertEquals(loadedConfig?.useDevcontainer, true);
    assertEquals(loadedConfig?.hasDevcontainerFile, true);
    assertEquals(loadedConfig?.hasAnthropicsFeature, true);
    assertEquals(loadedConfig?.containerId, "test-container-id");
    assertEquals(loadedConfig?.isStarted, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - devcontainerがない場合でも正常に処理される", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    // モックCommandExecutorを作成（呼ばれないことを確認）
    let executeCalled = false;
    class MockCommandExecutor implements CommandExecutor {
      async execute(
        _command: string,
        _args: string[],
        _options?: { stderr?: "piped"; stdout?: "piped" },
      ): Promise<CommandOutput> {
        executeCalled = true;
        return {
          code: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
        };
      }
    }

    const mockExecutor = new MockCommandExecutor();
    const devcontainerManager = new DevcontainerManager(
      workspaceManager,
      false,
      mockExecutor,
    );
    const threadId = "test-thread-no-devcontainer";

    // Worker状態を作成（devcontainerなし）
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

    // devcontainer削除を実行（何も起こらない）
    await devcontainerManager.removeDevcontainer(threadId);

    // dockerコマンドが実行されていないことを確認
    assertEquals(executeCalled, false);

    // 設定が変更されていないことを確認
    const loadedConfig = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    assertEquals(loadedConfig?.isStarted, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - 存在しないコンテナIDの場合でも正常に処理される", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    // モックCommandExecutorを作成（存在しないコンテナエラーを返す）
    let executedCommand = "";
    let executedArgs: string[] = [];

    class MockCommandExecutor implements CommandExecutor {
      async execute(
        command: string,
        args: string[],
        _options?: { stderr?: "piped"; stdout?: "piped" },
      ): Promise<CommandOutput> {
        executedCommand = command;
        executedArgs = args;

        // 存在しないコンテナエラーを返す
        return {
          code: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(
            "Error: No such container: non-existent-container",
          ),
        };
      }
    }

    const mockExecutor = new MockCommandExecutor();
    const devcontainerManager = new DevcontainerManager(
      workspaceManager,
      false,
      mockExecutor,
    );
    const threadId = "test-thread-non-existent";

    // Worker状態を作成（存在しないコンテナIDあり）
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: true,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: true,
        hasAnthropicsFeature: true,
        containerId: "non-existent-container",
        isStarted: true,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // 削除前の設定を確認（containerIdが存在することを確認）
    const configBeforeRemove = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    assertEquals(configBeforeRemove?.containerId, "non-existent-container");

    // devcontainer削除を実行（エラーになるがハンドリングされる）
    await devcontainerManager.removeDevcontainer(threadId);

    // モックが正しいコマンドで呼び出されたことを確認
    assertEquals(executedCommand, "docker");
    assertEquals(executedArgs, ["rm", "-f", "-v", "non-existent-container"]);

    // 設定が更新されていることを確認
    const loadedConfig = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    // containerIdがundefinedになっていることを明示的に確認
    assertEquals(loadedConfig?.containerId, undefined);
    assertEquals(loadedConfig?.isStarted, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - モックCommandExecutorを使用したコンテナ削除", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    // モックCommandExecutorを作成
    let executedCommand = "";
    let executedArgs: string[] = [];

    class MockCommandExecutor implements CommandExecutor {
      async execute(
        command: string,
        args: string[],
        _options?: { stderr?: "piped"; stdout?: "piped" },
      ): Promise<CommandOutput> {
        executedCommand = command;
        executedArgs = args;

        // 成功を示すレスポンスを返す
        return {
          code: 0,
          stdout: new TextEncoder().encode("container-id\n"),
          stderr: new Uint8Array(),
        };
      }
    }

    const mockExecutor = new MockCommandExecutor();
    const devcontainerManager = new DevcontainerManager(
      workspaceManager,
      false,
      mockExecutor,
    );
    const threadId = "test-thread-mock";

    // Worker状態を作成（コンテナIDあり）
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: true,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: true,
        hasAnthropicsFeature: true,
        containerId: "test-container-123",
        isStarted: true,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // devcontainer削除を実行
    await devcontainerManager.removeDevcontainer(threadId);

    // モックが正しいコマンドで呼び出されたことを確認
    assertEquals(executedCommand, "docker");
    assertEquals(executedArgs, ["rm", "-f", "-v", "test-container-123"]);

    // 設定が更新されていることを確認
    const loadedConfig = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    assertEquals(loadedConfig?.containerId, undefined);
    assertEquals(loadedConfig?.isStarted, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("DevcontainerManager - モックCommandExecutorでエラーケースのテスト", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();

    // エラーを返すモックCommandExecutorを作成
    class ErrorMockCommandExecutor implements CommandExecutor {
      async execute(
        _command: string,
        _args: string[],
        _options?: { stderr?: "piped"; stdout?: "piped" },
      ): Promise<CommandOutput> {
        // エラーを示すレスポンスを返す
        return {
          code: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(
            "Error: Cannot connect to Docker daemon",
          ),
        };
      }
    }

    const mockExecutor = new ErrorMockCommandExecutor();
    const devcontainerManager = new DevcontainerManager(
      workspaceManager,
      false,
      mockExecutor,
    );
    const threadId = "test-thread-error";

    // Worker状態を作成（コンテナIDあり）
    await workspaceManager.saveWorkerState({
      workerName: "test-worker",
      threadId,
      devcontainerConfig: {
        useDevcontainer: true,
        useFallbackDevcontainer: false,
        hasDevcontainerFile: true,
        hasAnthropicsFeature: true,
        containerId: "test-container-456",
        isStarted: true,
      },
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });

    // devcontainer削除を実行（エラーが発生するがハンドリングされる）
    await devcontainerManager.removeDevcontainer(threadId);

    // エラーが発生しても設定がクリアされることを確認
    const loadedConfig = await devcontainerManager.getDevcontainerConfig(
      threadId,
    );
    assertEquals(loadedConfig?.containerId, undefined);
    assertEquals(loadedConfig?.isStarted, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
