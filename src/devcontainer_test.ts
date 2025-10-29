import { assertEquals } from "std/assert/mod.ts";
import { join } from "std/path/mod.ts";
import {
  checkDevcontainerCli,
  checkDevcontainerConfig,
} from "./devcontainer.ts";

Deno.test("devcontainer設定のチェック機能", async (t) => {
  await t.step("devcontainer.jsonが存在しない場合", async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.configExists, false);
        assertEquals(result.value.configPath, undefined);
        assertEquals(result.value.config, undefined);
        assertEquals(result.value.hasAnthropicsFeature, undefined);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });

  await t.step(".devcontainer/devcontainer.jsonが存在する場合", async () => {
    const tempDir = await Deno.makeTempDir();
    const devcontainerDir = join(tempDir, ".devcontainer");
    await Deno.mkdir(devcontainerDir);

    const config = {
      name: "test",
      image: "mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye",
      features: {
        "ghcr.io/anthropics/devcontainer-features/codex-cli:latest": {},
      },
    };

    try {
      await Deno.writeTextFile(
        join(devcontainerDir, "devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.configExists, true);
        assertEquals(
          result.value.configPath,
          join(devcontainerDir, "devcontainer.json"),
        );
        assertEquals(result.value.config?.name, "test");
        assertEquals(result.value.hasAnthropicsFeature, true);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });

  await t.step(".devcontainer.jsonが存在する場合", async () => {
    const tempDir = await Deno.makeTempDir();
    const config = {
      name: "test-root",
      image: "node:20",
      features: {
        "anthropics/devcontainer-features/codex-cli": "latest",
      },
    };

    try {
      await Deno.writeTextFile(
        join(tempDir, ".devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.configExists, true);
        assertEquals(
          result.value.configPath,
          join(tempDir, ".devcontainer.json"),
        );
        assertEquals(result.value.config?.name, "test-root");
        assertEquals(result.value.hasAnthropicsFeature, true);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });

  await t.step("anthropics featuresが含まれていない場合", async () => {
    const tempDir = await Deno.makeTempDir();
    const config = {
      name: "test-no-anthropics",
      image: "node:20",
      features: {
        "ghcr.io/devcontainers/features/node:1": {},
      },
    };

    try {
      await Deno.writeTextFile(
        join(tempDir, ".devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.configExists, true);
        assertEquals(result.value.hasAnthropicsFeature, false);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });

  await t.step("featuresが定義されていない場合", async () => {
    const tempDir = await Deno.makeTempDir();
    const config = {
      name: "test-no-features",
      image: "node:20",
    };

    try {
      await Deno.writeTextFile(
        join(tempDir, ".devcontainer.json"),
        JSON.stringify(config, null, 2),
      );

      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isOk(), true);
      if (result.isOk()) {
        assertEquals(result.value.configExists, true);
        assertEquals(result.value.hasAnthropicsFeature, false);
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });

  await t.step("不正なJSONの場合", async () => {
    const tempDir = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(
        join(tempDir, ".devcontainer.json"),
        "{ invalid json",
      );

      const result = await checkDevcontainerConfig(tempDir);
      assertEquals(result.isErr(), true);
      if (result.isErr()) {
        assertEquals(result.error.type, "JSON_PARSE_ERROR");
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("devcontainer CLIのチェック機能", async () => {
  const result = await checkDevcontainerCli();
  // Result型が返されることを確認
  assertEquals(result.isOk() || result.isErr(), true);
  if (result.isOk()) {
    assertEquals(typeof result.value, "boolean");
  }
});
