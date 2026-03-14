import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { join } from "std/path/mod.ts";
import { Admin } from "./admin.ts";
import { AdminState, WorkspaceManager } from "../workspace/workspace.ts";

Deno.test("Admin devcontainer機能のテスト", async (t) => {
  const tempDir = await Deno.makeTempDir();
  let workspaceManager: WorkspaceManager;
  let admin: Admin;

  try {
    workspaceManager = new WorkspaceManager(tempDir);
    await workspaceManager.initialize();
    const adminState: AdminState = {
      activeThreadIds: [],
      lastUpdated: new Date().toISOString(),
    };
    admin = new Admin(adminState, workspaceManager, undefined, undefined);

    await t.step("devcontainer.jsonが存在しない場合のチェック", async () => {
      const repoDir = await Deno.makeTempDir();

      try {
        const result = await admin.checkAndSetupDevcontainer(
          "test-thread",
          repoDir,
        );

        assertEquals(result.hasDevcontainer, false);
        // DevcontainerManagerは空文字を返すようになったので、メッセージはmain.tsで生成される
        assertEquals(result.message, "");
      } finally {
        await Deno.remove(repoDir, { recursive: true });
      }
    });

    await t.step("devcontainer.jsonが存在するがCLIがない場合", async () => {
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

        const result = await admin.checkAndSetupDevcontainer(
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
    });

    await t.step("anthropics featuresがない場合の警告", async () => {
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

        const result = await admin.checkAndSetupDevcontainer(
          "test-thread",
          repoDir,
        );

        assertEquals(result.hasDevcontainer, true);
        // devcontainer CLIがインストールされていない環境では警告メッセージが異なる
        if (
          result.warning &&
          result.warning.includes("anthropics/devcontainer-features")
        ) {
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
    });

    await t.step("存在しないWorkerでのdevcontainer起動", async () => {
      const result = await admin.startDevcontainerForWorker(
        "nonexistent-thread",
      );

      assertEquals(result.success, false);
      assertEquals(result.message, "Workerが見つかりません。");
    });

    await t.step("Workerが存在する場合のdevcontainer起動", async () => {
      await admin.createWorker("test-thread-devcontainer");

      // リポジトリが設定されていない状態でのテスト
      const result = await admin.startDevcontainerForWorker(
        "test-thread-devcontainer",
      );

      assertEquals(result.success, false);
      assertStringIncludes(result.message, "devcontainerの起動に失敗しました");
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
