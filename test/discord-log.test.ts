import { assertEquals } from "std/assert/mod.ts";
import {
  createLocationPreview,
  createMessagePreview,
  formatDiscordSendLog,
} from "../src/utils/discord-log.ts";

Deno.test("createLocationPreview: 名前の先頭10文字をログ用に整形する", () => {
  assertEquals(createLocationPreview("1234567890extra"), "1234567890");
  assertEquals(createLocationPreview("guild\nname"), "guild\\nname");
});

Deno.test("createMessagePreview: 先頭20文字をログ用に整形する", () => {
  assertEquals(
    createMessagePreview("12345678901234567890extra"),
    "12345678901234567890",
  );
  assertEquals(createMessagePreview("hello\nworld"), "hello\\nworld");
});

Deno.test("formatDiscordSendLog: Discord送信ログの形式を作る", () => {
  assertEquals(
    formatDiscordSendLog(
      "server-name-extra",
      "channel-name-extra",
      "thread-name-extra",
      "message-12345678901234567890",
    ),
    "server-nam/channel-na/thread-nam「message-123456789012」",
  );
});
