import { assertEquals } from "std/assert/mod.ts";
import { splitIntoDiscordChunks } from "../src/utils/discord-message.ts";

Deno.test("splitIntoDiscordChunks: 空白だけの入力は送信チャンクにしない", () => {
  assertEquals(splitIntoDiscordChunks(" \n\t "), []);
});

Deno.test("splitIntoDiscordChunks: コードブロック間の空白だけの区間を除外する", () => {
  const chunks = splitIntoDiscordChunks(
    "```ts\nconst a = 1;\n```\n\n```ts\nconst b = 2;\n```",
    24,
  );

  assertEquals(chunks, [
    "```ts\nconst a = 1;\n```",
    "```ts\nconst b = 2;\n```",
  ]);
});
