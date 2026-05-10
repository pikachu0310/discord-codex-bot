import { assertEquals } from "std/assert/mod.ts";
import {
  createMessagePreview,
  formatDiscordSendLog,
} from "../src/utils/discord-log.ts";

Deno.test("createMessagePreview: 先頭20文字をログ用に整形する", () => {
  assertEquals(
    createMessagePreview("12345678901234567890extra"),
    "12345678901234567890",
  );
  assertEquals(createMessagePreview("hello\nworld"), "hello\\nworld");
});

Deno.test("formatDiscordSendLog: Discord送信ログの形式を作る", () => {
  assertEquals(
    formatDiscordSendLog("server", "channel", "thread", "message"),
    "server/channel/thread「message」",
  );
});
