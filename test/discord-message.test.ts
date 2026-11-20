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

Deno.test("splitIntoDiscordChunks: 日本語の回答の境界で絵文字が壊れない", () => {
  const text = "あ".repeat(1499) + "🐈です";
  const chunks = splitIntoDiscordChunks(text);
  assertEquals(chunks.join(""), text);
  assertEquals(chunks.every((piece) => piece === piece.toWellFormed()), true);
});

Deno.test("splitIntoDiscordChunks: 長いインラインの三連バッククォートで本文を複製しない", () => {
  const text = "```" + "日".repeat(1700) + "```";
  const parts = splitIntoDiscordChunks(text);
  assertEquals(parts.join("").match(/日/g)?.length, 1700);
  assertEquals(parts.every((p) => p.length <= 1500), true);
});
