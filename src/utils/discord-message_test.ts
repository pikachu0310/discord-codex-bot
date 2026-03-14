import { assertEquals } from "https://deno.land/std@0.211.0/assert/mod.ts";
import { splitIntoDiscordChunks } from "./discord-message.ts";

Deno.test("splitIntoDiscordChunks - returns original when short", () => {
  const text = "短いテキスト";
  const chunks = splitIntoDiscordChunks(text, 50);
  assertEquals(chunks, [text]);
});

Deno.test("splitIntoDiscordChunks - splits long text by newline", () => {
  const text = Array.from({ length: 5 }, (_, i) => `行${i}${"a".repeat(40)}`)
    .join("\n");
  const chunks = splitIntoDiscordChunks(text, 80);
  assertEquals(chunks.length > 1, true);
  assertEquals(chunks.join(""), text);
});

Deno.test("splitIntoDiscordChunks - splits code block preserving fences", () => {
  const body = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const code = "```ts\n" + body + "\n```";
  const chunks = splitIntoDiscordChunks(code, 120);
  assertEquals(chunks.length > 1, true);
  for (const chunk of chunks) {
    assertEquals(chunk.startsWith("```ts"), true);
    assertEquals(chunk.trimEnd().endsWith("```"), true);
  }
});
