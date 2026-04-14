import { assertEquals } from "std/assert/mod.ts";
import { getEnv } from "../src/env.ts";

Deno.test("getEnv: 必須環境変数がある場合に成功する", () => {
  Deno.env.set("DISCORD_TOKEN", "token");
  Deno.env.set("WORK_BASE_DIR", "/tmp/work");
  Deno.env.set("CODEX_APPEND_SYSTEM_PROMPT", "system prompt");

  const env = getEnv();
  if (env.isErr()) {
    throw new Error("env parse failed");
  }
  assertEquals(env.value.CODEX_APPEND_SYSTEM_PROMPT, "system prompt");
});
