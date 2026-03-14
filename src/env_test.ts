import { assertEquals } from "https://deno.land/std@0.223.0/assert/mod.ts";
import { getEnv } from "./env.ts";

Deno.test("getEnv - 必要な環境変数が設定されている場合は成功する", () => {
  // 環境変数を設定
  Deno.env.set("DISCORD_TOKEN", "test-token");
  Deno.env.set("WORK_BASE_DIR", "/test/work");
  // VERBOSEを明示的に削除して未設定状態にする
  Deno.env.delete("VERBOSE");

  const result = getEnv();

  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value.DISCORD_TOKEN, "test-token");
    assertEquals(result.value.WORK_BASE_DIR, "/test/work");
    assertEquals(result.value.VERBOSE, false);
  }

  // クリーンアップ
  Deno.env.delete("DISCORD_TOKEN");
  Deno.env.delete("WORK_BASE_DIR");
});

Deno.test("getEnv - DISCORD_TOKENが設定されていない場合はエラーを返す", () => {
  // DISCORD_TOKENを削除
  Deno.env.delete("DISCORD_TOKEN");
  Deno.env.set("WORK_BASE_DIR", "/test/work");

  const result = getEnv();

  assertEquals(result.isErr(), true);
  if (result.isErr()) {
    assertEquals(result.error.type, "MISSING_ENV_VAR");
    assertEquals(result.error.variable, "DISCORD_TOKEN");
    assertEquals(result.error.message, "DISCORD_TOKEN is not set");
  }

  // クリーンアップ
  Deno.env.delete("WORK_BASE_DIR");
});

Deno.test("getEnv - WORK_BASE_DIRが設定されていない場合はエラーを返す", () => {
  // WORK_BASE_DIRを削除
  Deno.env.set("DISCORD_TOKEN", "test-token");
  Deno.env.delete("WORK_BASE_DIR");

  const result = getEnv();

  assertEquals(result.isErr(), true);
  if (result.isErr()) {
    assertEquals(result.error.type, "MISSING_ENV_VAR");
    assertEquals(result.error.variable, "WORK_BASE_DIR");
    assertEquals(result.error.message, "WORK_BASE_DIR is not set");
  }

  // クリーンアップ
  Deno.env.delete("DISCORD_TOKEN");
});

Deno.test("getEnv - オプション環境変数が正しく読み込まれる", () => {
  // 環境変数を設定
  Deno.env.set("DISCORD_TOKEN", "test-token");
  Deno.env.set("WORK_BASE_DIR", "/test/work");
  Deno.env.set("VERBOSE", "true");
  Deno.env.set("CODEX_APPEND_SYSTEM_PROMPT", "test prompt");
  Deno.env.set("GEMINI_API_KEY", "test-api-key");
  Deno.env.set("PLAMO_TRANSLATOR_URL", "http://localhost:8080");

  const result = getEnv();

  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value.VERBOSE, true);
    assertEquals(result.value.CODEX_APPEND_SYSTEM_PROMPT, "test prompt");
    assertEquals(result.value.GEMINI_API_KEY, "test-api-key");
    assertEquals(result.value.PLAMO_TRANSLATOR_URL, "http://localhost:8080");
  }

  // クリーンアップ
  Deno.env.delete("DISCORD_TOKEN");
  Deno.env.delete("WORK_BASE_DIR");
  Deno.env.delete("VERBOSE");
  Deno.env.delete("CODEX_APPEND_SYSTEM_PROMPT");
  Deno.env.delete("GEMINI_API_KEY");
  Deno.env.delete("PLAMO_TRANSLATOR_URL");
});

Deno.test("getEnv - VERBOSEがfalse値の場合はfalseになる", () => {
  // 環境変数を設定
  Deno.env.set("DISCORD_TOKEN", "test-token");
  Deno.env.set("WORK_BASE_DIR", "/test/work");
  Deno.env.set("VERBOSE", "false");

  const result = getEnv();

  assertEquals(result.isOk(), true);
  if (result.isOk()) {
    assertEquals(result.value.VERBOSE, false);
  }

  // クリーンアップ
  Deno.env.delete("DISCORD_TOKEN");
  Deno.env.delete("WORK_BASE_DIR");
  Deno.env.delete("VERBOSE");
});
