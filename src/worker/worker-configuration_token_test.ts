import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.214.0/assert/mod.ts";
import { WorkerConfiguration } from "./worker-configuration.ts";
import { CODEX_CLI } from "../constants.ts";

Deno.test("WorkerConfiguration - トークン制限設定", async (t) => {
  await t.step("デフォルト値を使用する場合", () => {
    const config = new WorkerConfiguration();
    assertEquals(
      config.getMaxOutputTokens(),
      CODEX_CLI.DEFAULT_MAX_OUTPUT_TOKENS,
    );

    const env = config.buildCodexEnv();
    assertEquals(
      env.CODEX_CODE_MAX_OUTPUT_TOKENS,
      CODEX_CLI.DEFAULT_MAX_OUTPUT_TOKENS.toString(),
    );
  });

  await t.step("コンストラクタで指定した値を使用する場合", () => {
    const customTokens = 50000;
    const config = new WorkerConfiguration(
      false,
      undefined,
      undefined,
      true,
      customTokens,
    );
    assertEquals(config.getMaxOutputTokens(), customTokens);

    const env = config.buildCodexEnv();
    assertEquals(env.CODEX_CODE_MAX_OUTPUT_TOKENS, customTokens.toString());
  });

  await t.step("環境変数から値を取得する場合", () => {
    const envTokens = 30000;
    Deno.env.set("CODEX_CODE_MAX_OUTPUT_TOKENS", envTokens.toString());

    const config = new WorkerConfiguration();
    assertEquals(config.getMaxOutputTokens(), envTokens);

    const env = config.buildCodexEnv();
    assertEquals(env.CODEX_CODE_MAX_OUTPUT_TOKENS, envTokens.toString());

    // テスト後のクリーンアップ
    Deno.env.delete("CODEX_CODE_MAX_OUTPUT_TOKENS");
  });

  await t.step("環境変数の無効な値を処理する場合", () => {
    // 無効な値を設定
    Deno.env.set("CODEX_CODE_MAX_OUTPUT_TOKENS", "invalid");

    const config = new WorkerConfiguration();
    assertEquals(
      config.getMaxOutputTokens(),
      CODEX_CLI.DEFAULT_MAX_OUTPUT_TOKENS,
    );

    // テスト後のクリーンアップ
    Deno.env.delete("CODEX_CODE_MAX_OUTPUT_TOKENS");
  });

  await t.step("環境変数に負の値を設定した場合", () => {
    Deno.env.set("CODEX_CODE_MAX_OUTPUT_TOKENS", "-1000");

    const config = new WorkerConfiguration();
    assertEquals(
      config.getMaxOutputTokens(),
      CODEX_CLI.DEFAULT_MAX_OUTPUT_TOKENS,
    );

    // テスト後のクリーンアップ
    Deno.env.delete("CODEX_CODE_MAX_OUTPUT_TOKENS");
  });

  await t.step("setMaxOutputTokensメソッドで値を変更する場合", () => {
    const config = new WorkerConfiguration();
    const newTokens = 40000;

    config.setMaxOutputTokens(newTokens);
    assertEquals(config.getMaxOutputTokens(), newTokens);

    const env = config.buildCodexEnv();
    assertEquals(env.CODEX_CODE_MAX_OUTPUT_TOKENS, newTokens.toString());
  });

  await t.step("setMaxOutputTokensに無効な値を設定した場合", () => {
    const config = new WorkerConfiguration();
    const originalTokens = config.getMaxOutputTokens();

    // 負の値を設定しても変更されない
    config.setMaxOutputTokens(-100);
    assertEquals(config.getMaxOutputTokens(), originalTokens);

    // 0を設定しても変更されない
    config.setMaxOutputTokens(0);
    assertEquals(config.getMaxOutputTokens(), originalTokens);
  });

  await t.step("buildCodexEnvが正しい形式で環境変数を返す場合", () => {
    const config = new WorkerConfiguration();
    const env = config.buildCodexEnv();

    assertExists(env.CODEX_CODE_MAX_OUTPUT_TOKENS);
    assertEquals(typeof env.CODEX_CODE_MAX_OUTPUT_TOKENS, "string");

    // 数値として解析できることを確認
    const parsed = parseInt(env.CODEX_CODE_MAX_OUTPUT_TOKENS, 10);
    assertEquals(isNaN(parsed), false);
    assertEquals(parsed > 0, true);
  });
});
